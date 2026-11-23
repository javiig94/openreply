#!/usr/bin/env python3
"""newsedge — real-time news -> Polymarket signal monitor.

The realistic version of "get ahead of the market on speed". You will NOT beat
CEX HFT on BTC. But Polymarket's crowd is slow to reprice news, so the play is:
detect a market-moving headline, find the OPEN Polymarket market it resolves,
and act before the crowd drags the price. This tool watches fast RSS feeds,
matches fresh headlines to active markets by entity, and emits an alert with the
current price and the latency since the headline was published.

Read-only: it ALERTS, it does not trade. Wire execution only after the latency
study (latency_study.py) shows the repricing window is actually wide enough.

  python newsedge.py --once          # single scan of current headlines vs markets
  python newsedge.py --watch 15      # poll every 15s, log alerts to data/alerts.log
"""
from __future__ import annotations
import argparse
import html
import os
import re
import time
import datetime as dt
import requests

import sources
from direction import infer

DATA = os.path.join(os.path.dirname(__file__), "data")
GAMMA = "https://gamma-api.polymarket.com"

STOP = set("""a an the of to in on for by at is are be will would there no new
after before over under with without and or not this that these those he she it
they his her their its as from into out up down who whom which what when where
why how any all some more most than then so if but about above below between
during per via vs x game map spread win wins winner lose first second third
2024 2025 2026 2027 2028 january february march april may june july august
september october november december q1 q2 q3 q4 end higher lower above below
bps year reach hit named change continues through""".split())

MONTHS = set("january february march april may june july august september "
             "october november december".split())


def _get(url, params=None, tries=4):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e; time.sleep(1.2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def entities(text):
    """Significant tokens: capitalized words (proper nouns) kept as strong, plus
    salient lowercase keywords. Dates/boilerplate dropped."""
    # multi-word Capitalized sequences = strong entities
    strong = set()
    for m in re.findall(r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b", text):
        w = m.strip()
        toks = [t for t in w.split() if t.lower() not in MONTHS]
        if toks:
            strong.add(" ".join(toks).lower())
    # all significant word tokens
    weak = set()
    for w in re.findall(r"[A-Za-z]{3,}", text.lower()):
        if w not in STOP and w not in MONTHS:
            weak.add(w)
    return strong, weak


def active_markets(limit=400):
    rows = _get(f"{GAMMA}/markets", {"active": "true", "closed": "false",
                                     "limit": limit, "order": "volume24hr",
                                     "ascending": "false"})
    mk = []
    for m in rows:
        q = m.get("question", "")
        if not q:
            continue
        s = q.lower()
        if any(w in s for w in [" vs ", " vs.", "dota", "cs2", "nba game", "map 1",
                                "spread:", "counter-strike", "valorant", "moneyline"]):
            continue  # live sports noise reprices too fast to beat anyway
        import json as _json
        toks = _json.loads(m.get("clobTokenIds") or "[]")
        st, wk = entities(q)
        mk.append({"q": q, "price": m.get("lastTradePrice"),
                   "strong": st, "weak": wk,
                   "slug": m.get("slug", ""),
                   "token": toks[0] if toks else ""})
    return mk


def _minute_hist(token):
    d = _get(f"https://clob.polymarket.com/prices-history",
             {"market": token, "interval": "1d", "fidelity": 1})
    return [(int(p["t"]), float(p["p"])) for p in d.get("history", [])] if d else []


def residual(token, headline_ts, side):
    """Has the market already repriced in the implied direction?

    Compares the current price to a baseline ~10 min before the headline. Tells
    you if you are EARLY (price still flat -> room) or LATE (already moved).
    Returns (status, baseline, current, moved_toward).
    """
    if not token or not side:
        return "no-token", None, None, None
    h = _minute_hist(token)
    if len(h) < 3:
        return "no-data", None, None, None
    current = h[-1][1]
    cutoff = (headline_ts - 600) if headline_ts else (h[-1][0] - 1800)
    pre = [p for (t, p) in h if t <= cutoff]
    baseline = pre[-1] if pre else h[0][1]
    sign = 1 if side == "YES" else -1
    moved_toward = (current - baseline) * sign       # >0 = already moved our way
    # room = distance the price can still travel toward the implied outcome
    room = (1 - current) if side == "YES" else current
    if room < 0.10:
        status = "PRICED IN (no reward)"              # already at the implied extreme
    elif moved_toward >= 0.08:
        status = "LATE (already moving)"
    elif abs(current - baseline) < 0.03:
        status = "EARLY (flat — room)"
    else:
        status = "PARTIAL"
    return status, baseline, current, moved_toward


def match(headline, markets):
    """Alert only on a real entity hit, not loose keyword overlap:
      - a multi-word proper noun shared (e.g. 'jensen huang')  -> strong signal
      - OR two distinct proper nouns shared
      - OR one proper noun + >=3 shared salient keywords
    """
    hl = headline.lower()
    hs, hw = entities(headline)
    best = []
    for m in markets:
        multi = [e for e in m["strong"] if " " in e and (e in hs or e in hl)]
        single = [e for e in m["strong"] if " " not in e and len(e) > 3 and (e in hs or e in hw)]
        shared = sorted(m["weak"] & hw)
        score = 3 * len(multi) + 2 * len(single) + len(shared)
        strong_enough = bool(multi) or len(single) >= 2 or (single and len(shared) >= 3)
        if strong_enough:
            hits = multi + single + shared
            best.append((score, m, hits))
    best.sort(key=lambda x: -x[0])
    return best[:3]


def scan_once(markets, seen, log=None):
    now = int(time.time())
    alerts = 0
    for it in sources.all_items():
        key = it["link"] or it["title"]
        if key in seen:
            continue
        seen.add(key)
        m = match(it["title"], markets)
        if not m:
            continue
        age = (now - it["ts"]) if it["ts"] else None
        agestr = f"{age//60}m{age % 60}s" if age is not None else "?"
        for score, mk, hits in m:
            side, conf, why = infer(it["title"], mk["q"])
            status = base = cur = moved = None
            if side is None:
                sidestr = "side=? (no clear direction)"
            else:
                status, base, cur, moved = residual(mk["token"], it["ts"], side)
                tag = {"EARLY (flat — room)": "🟢 ACTIONABLE",
                       "PARTIAL": "🟡 some room",
                       "LATE (already moving)": "🟡 late",
                       "PRICED IN (no reward)": "🔴 already priced"}.get(status, "")
                sidestr = (f"==> BET {side}  conf={conf:.2f}  [{why}]\n"
                           f"   RESIDUAL: {status} {tag}"
                           + (f"  (pre={base:.3f} now={cur:.3f} moved_toward={moved:+.3f})"
                              if base is not None else ""))
            line = (f"ALERT score={score} lat={agestr} [{it['source']}]\n"
                    f"   NEWS : {it['title']}\n"
                    f"   MKT  : {mk['q']}  (price={mk['price']})\n"
                    f"   {sidestr}\n"
                    f"   via  : {', '.join(hits[:6])}")
            print(line + "\n")
            if log:
                log.write(f"{now}\t{it['ts']}\t{score}\t{it['source']}\t{side}\t{conf:.2f}\t"
                          f"{status}\t{base}\t{cur}\t{mk['slug']}\t{it['title']}\t{mk['q']}\n")
                log.flush()
            alerts += 1
    return alerts


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--watch", type=int, metavar="SECONDS", help="poll interval")
    ap.add_argument("--refresh-markets", type=int, default=600,
                    help="re-pull active markets every N seconds in watch mode")
    args = ap.parse_args()

    os.makedirs(DATA, exist_ok=True)
    print("[newsedge] pulling active markets...")
    markets = active_markets()
    feednames = list(sources.RSS_FEEDS) + ["HN"]
    print(f"[newsedge] {len(markets)} news-sensitive markets indexed. sources: {', '.join(feednames)}\n")
    seen = set()

    if args.watch:
        log = open(os.path.join(DATA, "alerts.log"), "a")
        last_mk = time.time()
        print(f"[newsedge] watching every {args.watch}s (ctrl-C to stop)...\n")
        # prime seen with current items so we only alert on NEW ones
        scan_once(markets, seen, log=None)
        while True:
            time.sleep(args.watch)
            if time.time() - last_mk > args.refresh_markets:
                markets = active_markets(); last_mk = time.time()
            n = scan_once(markets, seen, log=log)
            if n:
                print(f"  -- {n} new alert(s) at {dt.datetime.now():%H:%M:%S} --\n")
    else:
        n = scan_once(markets, seen)
        print(f"[newsedge] {n} headline-market matches in current feeds.")


if __name__ == "__main__":
    main()

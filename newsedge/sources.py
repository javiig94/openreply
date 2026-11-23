"""Unified news sources, normalized to {source, title, ts, link}.

Mixes RSS (BBC, CoinDesk, Fed) with faster/structured feeds:
  - Hacker News via Algolia (one call, titled + timestamped, breaks tech/crypto)
  - (hook left for SEC EDGAR / primary-source pollers)

RSS already costs minutes of latency; HN-Algolia and primary sources are the
path to tightening that. Each fetcher is best-effort and never raises.
"""
from __future__ import annotations
import html
import time
import datetime as dt
import xml.etree.ElementTree as ET
import urllib.request
import requests

RSS_FEEDS = {
    "BBCworld": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "BBCbiz": "https://feeds.bbci.co.uk/news/business/rss.xml",
    "BBCpol": "https://feeds.bbci.co.uk/news/politics/rss.xml",
    "CoinDesk": "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "Fed": "https://www.federalreserve.gov/feeds/press_all.xml",
}


def _parse_date(s):
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z"):
        try:
            return int(dt.datetime.strptime(s.strip(), fmt).timestamp())
        except (ValueError, TypeError):
            pass
    return 0


def fetch_rss(name, url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 newsedge"})
        raw = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
        root = ET.fromstring(raw)
        out = []
        for it in root.findall(".//item"):
            out.append({
                "source": name,
                "title": html.unescape(it.findtext("title", "") or ""),
                "link": it.findtext("link", "") or it.findtext("guid", "") or "",
                "ts": _parse_date(it.findtext("pubDate", "") or ""),
            })
        return out
    except Exception:  # noqa: BLE001
        return []


def fetch_hn(hits=40):
    """Recent HN stories via Algolia — one call, titled + unix-timestamped."""
    try:
        r = requests.get("https://hn.algolia.com/api/v1/search_by_date",
                         params={"tags": "story", "hitsPerPage": hits}, timeout=20)
        r.raise_for_status()
        out = []
        for h in r.json().get("hits", []):
            title = h.get("title") or h.get("story_title") or ""
            if not title:
                continue
            out.append({
                "source": "HN",
                "title": title,
                "link": h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID')}",
                "ts": int(h.get("created_at_i") or 0),
            })
        return out
    except Exception:  # noqa: BLE001
        return []


def all_items():
    items = []
    for name, url in RSS_FEEDS.items():
        items += fetch_rss(name, url)
    items += fetch_hn()
    return items

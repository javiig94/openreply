"""Direction inference: does a headline push a market's YES up or down?

Rule/lexicon based (no external LLM). For each market we detect the EVENT TYPE
from the question, then apply that type's polarity lexicon to the headline:
  + = the YES event is happening / becoming more likely
  - = the opposite
Then flip if the question itself is negated ("Will there be NO change...").

Returns (side, confidence, why): side in {"YES","NO",None}.

This is a heuristic first pass — good for the common Polymarket templates,
wrong on sarcasm/complex phrasing. It exists so alerts become *actionable*
(a side), and so direction accuracy can be measured on logged alerts.
"""
from __future__ import annotations
import re

# event type -> (affirming terms, negating terms)
TEMPLATES = {
    "resign": (
        ["resign", "resigns", "resigned", "step down", "steps down", "stepped down",
         "ousted", "fired", "removed", "out as", "forced out", "quits", "departure",
         "sacked", "dismissed", "exit", "exits"],
        ["stays", "remains", "returns", "keeps", "retains", "survives", "survived",
         "too big to fire", "backed", "secures", "holds on", "reinstated", "safe"],
    ),
    "win_election": (
        ["wins", "win", "won", "leads", "surges", "ahead", "frontrunner", "clinches",
         "secures nomination", "landslide", "victory", "elected", "takes the lead"],
        ["loses", "lost", "trails", "concedes", "drops out", "behind", "defeated",
         "withdraws", "suspends campaign", "eliminated", "fades"],
    ),
    "price_reach": (
        ["hits", "tops", "surges past", "reaches", "breaks above", "soars", "rally",
         "rallies", "jumps to", "climbs to", "all-time high", "record high", "spikes"],
        ["falls", "drops below", "crashes", "slumps", "plunges", "sinks", "tumbles",
         "retreats", "loses", "selloff", "sell-off", "dips"],
    ),
    "approve": (
        ["approves", "approved", "passes", "passed", "greenlights", "confirms",
         "confirmed", "ratifies", "authorizes", "clears", "signed into law", "enacted"],
        ["rejects", "rejected", "blocks", "blocked", "delays", "delayed", "fails",
         "failed", "vetoes", "stalls", "postpones", "shelved", "struck down"],
    ),
    "deal_continues": (
        ["holds", "continues", "extends", "extended", "agrees", "agreement", "signed",
         "renewed", "sustained", "maintained", "truce"],
        ["collapses", "breaks down", "breaks", "ends", "violated", "fails", "scrapped",
         "falls apart", "called off", "abandoned", "resumes fighting"],
    ),
    "rate_hike": (
        ["hikes", "raises rates", "rate hike", "increases rates", "tightens"],
        ["cuts", "rate cut", "lowers rates", "holds rates", "unchanged", "pause", "eases"],
    ),
}

NEG_Q = re.compile(r"\b(no|not|fail(s|ed)? to|won['’]t|without)\b", re.I)


def _has(s: str, words) -> bool:
    return any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", s) for w in words)


def _event_type(q: str) -> str | None:
    s = q.lower()
    # ceasefire/deal first — "ceasefire" must not be read as "fire" (resign)
    if _has(s, ["ceasefire", "truce", "deal", "agreement", "continues", "peace", "treaty"]):
        return "deal_continues"
    if _has(s, ["fed", "interest rate", "rate hike", "rate cut", "bps", "fomc"]):
        return "rate_hike"
    if _has(s, ["resign", "resignation", "removal", "out as", "removed", "step down",
                "fired", "ousted", "sacked"]):
        return "resign"
    if _has(s, ["win the", "election", "nominee", "nomination", "presidential",
                "primary", "elected", "mayor", "governor"]):
        return "win_election"
    if _has(s, ["reach", "above", "price", "market cap", "all-time high", "ath",
                "largest company"]) or "$" in s:
        return "price_reach"
    if _has(s, ["approve", "pass", "confirm", "ban", "legal", "ruling", "court",
                "bill", "law", "etf"]):
        return "approve"
    return None


def _polarity(headline: str, etype: str) -> tuple[int, list[str]]:
    hl = " " + headline.lower() + " "
    pos, neg = TEMPLATES[etype]
    phits = [w for w in pos if w in hl]
    nhits = [w for w in neg if w in hl]
    # explicit denial of an affirming verb ("CEO did NOT resign") flips it
    if phits and re.search(r"\b(did not|does not|didn['’]t|doesn['’]t|denies|denied|"
                           r"won['’]t|will not|rules out)\b", hl):
        nhits += phits
        phits = []
    score = len(phits) - len(nhits)
    return score, (phits + ["-" + w for w in nhits])


def infer(headline: str, question: str):
    """-> (side, confidence 0..1, explanation)."""
    etype = _event_type(question)
    if not etype:
        return None, 0.0, "unknown event type"
    score, hits = _polarity(headline, etype)
    if score == 0:
        return None, 0.0, f"{etype}: no directional words"
    # question negation: "Will there be NO change..." flips YES meaning
    q_negated = bool(NEG_Q.search(question.split("?")[0]))
    yes_happens = not q_negated
    event_happening = score > 0
    side = "YES" if (event_happening == yes_happens) else "NO"
    conf = min(1.0, 0.4 + 0.2 * abs(score))
    why = f"{etype} {'+' if score>0 else '-'}{abs(score)} [{', '.join(hits[:4])}]" \
          + (" (q-negated)" if q_negated else "")
    return side, conf, why

"""The shape of a question, and what the system owes the person answering it.

A question used to be a prompt and a list of options. That is enough to collect an
answer and not enough to get a good one: the font-licence follow-up was precise,
correct, and unanswerable without knowing why it was being asked or what the answer
would bind to — so it sat, and the ticket stopped.

So a question carries four things beyond its text:

- `why` — the reason it is being asked. A question whose consequence is invisible
  gets answered carelessly or not at all.
- `becomes` — the decision id the answer locks (`D-01`). An answer that binds
  nothing is a comment; an answer that binds a decision is a spec.
- `thread` — the back-and-forth. "Which font licence did we buy" deserves "what are
  the options, and what changes?" before it deserves an answer, and the person who
  can answer it is usually not the person who can look it up.
- `source` — `triage` or `planner`. They arrive at different moments and mean
  different things: triage asks before there is a plan, the planner asks because the
  plan stopped. The UI leads with the second, since work is halted behind it.

Three exits sit beside every question, because "answer or the ticket stalls" is a
false choice:

- **Ask about this** (`thread`) — the answer is knowable, the asker just needs it.
- **Decide for me** (`delegate_requested`) — a real choice with no strong opinion.
  The agent picks and records `reason`; the pick is marked `answered_by: "agent"`
  so it reads as delegated, not decided, and can be taken back.
- **Decide later** (`deferred`) — genuinely not needed yet. A deferred question
  stops blocking, which is the whole point: one unanswerable question should not
  hold the other eight.

Only what a human alone can answer should be asked at all — a missing `.planning/`
is a prerequisite the system fixes, not a question. Asking the first kind trains
people to click through, which is how the second kind stops being read.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional

SOURCES = ("triage", "planner")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canonical(q: Dict, index: int = 1) -> Dict:
    """One question in full shape, with every field the UI and the loop rely on."""
    source = q.get("source") or "triage"
    if source not in SOURCES:
        source = "triage"
    thread = [m for m in (q.get("thread") or []) if isinstance(m, dict) and m.get("text")]
    return {
        "id": q.get("id") or f"q{index}",
        "question": q.get("question", q.get("q", "")),
        "category": q.get("category", "scope"),
        "question_type": q.get("question_type", "text"),
        "options": q.get("options"),
        "why": q.get("why", ""),
        "source": source,
        "becomes": q.get("becomes") or f"D-{index:02d}",
        "answer": q.get("answer"),
        "answered_at": q.get("answered_at"),
        "answered_by": q.get("answered_by"),
        "reason": q.get("reason", ""),
        "deferred": bool(q.get("deferred")),
        "delegate_requested": bool(q.get("delegate_requested")),
        "thread": [
            {
                "role": "you" if m.get("role") == "you" else "research",
                "text": m.get("text", ""),
                "at": m.get("at") or _now(),
            }
            for m in thread
        ],
    }


def merge(existing: List[Dict], incoming: List[Dict]) -> List[Dict]:
    """Fold a fresh round of questions into what is already there, keeping history.

    `post_planning_questions` used to rebuild the list field by field, so anything
    it did not know about — an answer's reasoning, a conversation, a deferral —
    vanished on the next round. A re-triage silently discarded the thread that was
    the reason the question was still open.

    Matching is by id. An existing answer always wins: a round that re-asks a
    settled question must not reopen it.
    """
    by_id = {q.get("id"): q for q in (existing or []) if q.get("id")}
    merged: List[Dict] = []
    seen = set()

    for i, raw in enumerate(incoming or [], 1):
        fresh = canonical(raw, i)
        prior = by_id.get(fresh["id"])
        if prior:
            kept = canonical(prior, i)
            # New text and options can improve; everything the human touched stays.
            kept["question"] = fresh["question"] or kept["question"]
            kept["options"] = fresh["options"] or kept["options"]
            kept["why"] = fresh["why"] or kept["why"]
            kept["source"] = fresh["source"] if fresh["source"] != "triage" else kept["source"]
            merged.append(kept)
        else:
            merged.append(fresh)
        seen.add(fresh["id"])

    # A question already on the ticket but absent from this round still stands —
    # dropping it would lose an answer, or an open thread, with no trace.
    for q in (existing or []):
        if q.get("id") and q["id"] not in seen:
            merged.append(canonical(q, len(merged) + 1))
    return merged


def is_answered(q: Dict) -> bool:
    return bool(q.get("answer"))


def blocking(questions: List[Dict]) -> List[Dict]:
    """Questions that still hold work up.

    Deferred ones do not: "decide later" is an answer about timing, and treating it
    as an open question would make the exit meaningless.
    """
    return [q for q in (questions or []) if not is_answered(q) and not q.get("deferred")]


def all_settled(questions: List[Dict]) -> bool:
    """Nothing left that blocks. An empty set is settled."""
    return not blocking(questions)


def awaiting_reply(questions: List[Dict]) -> List[Dict]:
    """Questions whose thread ends on a message from the human — our turn to answer.

    Settled and set-aside questions are excluded. Their threads still end on a human
    message forever, so including them meant paying for a deep-model call on every
    tick to answer a conversation nobody is waiting on.
    """
    out = []
    for q in questions or []:
        if is_answered(q) or q.get("deferred"):
            continue
        thread = q.get("thread") or []
        if thread and thread[-1].get("role") == "you":
            out.append(q)
    return out


def awaiting_decision(questions: List[Dict]) -> List[Dict]:
    """Questions handed to the agent via "Decide for me" and not yet decided."""
    return [q for q in (questions or [])
            if q.get("delegate_requested") and not is_answered(q)]


def add_message(q: Dict, role: str, text: str) -> Dict:
    """Append to a question's thread. Returns the question for chaining."""
    q.setdefault("thread", []).append({
        "role": "you" if role == "you" else "research",
        "text": text,
        "at": _now(),
    })
    return q


def record_answer(q: Dict, answer: str, by: str = "you", reason: str = "") -> Dict:
    """Settle a question. `by` is "you" or "agent"; an agent pick must say why.

    Delegation is cleared so a re-opened question does not silently re-delegate,
    and a deferred question that gets answered stops being deferred.
    """
    q["answer"] = answer
    q["answered_at"] = _now()
    q["answered_by"] = "agent" if by == "agent" else "you"
    if reason:
        q["reason"] = reason
    q["delegate_requested"] = False
    q["deferred"] = False
    return q


def reopen(q: Dict) -> Dict:
    """Take back an answer — the "Change it" affordance on an agent's pick.

    The reasoning stays: it is why the value was what it was, and the person
    overriding it should be able to read it while they decide.
    """
    q["answer"] = None
    q["answered_at"] = None
    q["answered_by"] = None
    q["delegate_requested"] = False
    return q


def summarise(questions: List[Dict]) -> Dict[str, int]:
    """Counts for a log line or an activity message."""
    qs = questions or []
    return {
        "total": len(qs),
        "answered": len([q for q in qs if is_answered(q)]),
        "blocking": len(blocking(qs)),
        "deferred": len([q for q in qs if q.get("deferred") and not is_answered(q)]),
        "threads_open": len(awaiting_reply(qs)),
        "delegated": len(awaiting_decision(qs)),
    }

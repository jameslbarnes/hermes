"""
message_aggregator.py — Per-user burst detection and speech act aggregation.

Groups rapid consecutive messages from the same user into a single "speech act"
so downstream analysis treats "hey / you know what / I think we should do X"
as one utterance, not three.

Handles interruptions: if user A sends messages, user B interrupts, and user A
continues within the burst window (measured from A's last message), the messages
are merged into a single speech act marked as interrupted.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Dict, Optional, Any
import statistics
import math


@dataclass
class SpeechAct:
    """A grouped set of rapid consecutive messages from a single sender."""
    sender_id: str
    sender_name: str
    messages: List[Dict[str, Any]] = field(default_factory=list)
    combined_text: str = ""
    total_word_count: int = 0
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    message_count: int = 0
    was_interrupted: bool = False

    def _refresh(self):
        """Recompute derived fields from the messages list."""
        if not self.messages:
            return
        texts = [m.get("text") or "" for m in self.messages]
        self.combined_text = "\n".join(t for t in texts if t)
        self.total_word_count = sum(len(t.split()) for t in texts if t)
        self.message_count = len(self.messages)
        times = [_parse_ts(m["timestamp"]) for m in self.messages]
        self.start_time = min(times)
        self.end_time = max(times)


def _parse_ts(ts_str: str) -> datetime:
    """Parse an ISO-format timestamp string to datetime."""
    # Handle both 'T' separator and space separator, with or without fractional seconds
    ts_str = ts_str.strip()
    for fmt in (
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
    ):
        try:
            return datetime.strptime(ts_str, fmt)
        except ValueError:
            continue
    raise ValueError(f"Unable to parse timestamp: {ts_str!r}")


def aggregate_speech_acts(
    messages: List[Dict[str, Any]],
    burst_window_seconds: float = 30.0,
) -> List["SpeechAct"]:
    """
    Group a chronologically-sorted list of messages into speech acts.

    A speech act is a sequence of messages from the same sender where consecutive
    gaps are <= burst_window_seconds.  If another user sends a message in between
    (an "interruption"), the original user's speech act is still merged as long as
    their post-interruption message arrives within burst_window_seconds of their
    last pre-interruption message.

    Args:
        messages: list of dicts with at least: sender_id, sender_name, text, timestamp.
                  Must be sorted by timestamp ascending.
        burst_window_seconds: maximum gap (in seconds) between consecutive messages
                              from the same sender to be considered part of one burst.

    Returns:
        List of SpeechAct dataclass instances, in chronological order of start_time.
    """
    if not messages:
        return []

    # Sort by timestamp to be safe
    sorted_msgs = sorted(messages, key=lambda m: _parse_ts(m["timestamp"]))

    # Track open (in-progress) speech acts per sender_id.
    # Key: sender_id -> SpeechAct being built
    open_acts: Dict[str, SpeechAct] = {}
    # Track the last message timestamp per sender for burst-window checking
    last_msg_time: Dict[str, datetime] = {}
    # Completed speech acts
    completed: List[SpeechAct] = []
    # Track the sequence of sender_ids to detect interruptions
    # For each open act, track whether any other sender sent a message
    # after the act's last message (i.e., was interrupted)
    interrupted_since: Dict[str, bool] = {}

    for msg in sorted_msgs:
        sid = str(msg["sender_id"])
        sname = msg.get("sender_name", sid)
        ts = _parse_ts(msg["timestamp"])

        if sid in open_acts:
            gap = (ts - last_msg_time[sid]).total_seconds()
            if gap <= burst_window_seconds:
                # Continue the existing speech act
                if interrupted_since.get(sid, False):
                    open_acts[sid].was_interrupted = True
                open_acts[sid].messages.append(msg)
                last_msg_time[sid] = ts
                interrupted_since[sid] = False
            else:
                # Gap too large — close the old act, start a new one
                open_acts[sid]._refresh()
                completed.append(open_acts[sid])
                act = SpeechAct(sender_id=sid, sender_name=sname, messages=[msg])
                open_acts[sid] = act
                last_msg_time[sid] = ts
                interrupted_since[sid] = False
        else:
            # New sender or first message from this sender
            act = SpeechAct(sender_id=sid, sender_name=sname, messages=[msg])
            open_acts[sid] = act
            last_msg_time[sid] = ts
            interrupted_since[sid] = False

        # Mark all OTHER open acts as interrupted by this message
        for other_sid in open_acts:
            if other_sid != sid:
                interrupted_since[other_sid] = True

    # Close all remaining open acts
    for sid, act in open_acts.items():
        act._refresh()
        completed.append(act)

    # Sort by start_time
    completed.sort(key=lambda a: a.start_time)
    return completed


def get_user_burst_profile(
    speech_acts: List[SpeechAct],
    sender_id: str,
) -> Dict[str, Any]:
    """
    Compute per-user burst statistics from a list of speech acts.

    Args:
        speech_acts: list of SpeechAct instances (output of aggregate_speech_acts).
        sender_id: the user whose profile to compute.

    Returns:
        Dict with keys:
          - sender_id: the user
          - speech_act_count: number of speech acts
          - typical_burst_size: median message count per speech act
          - mean_burst_size: mean message count per speech act
          - typical_inter_message_gap_seconds: median gap between consecutive
            messages within speech acts (None if not enough data)
          - typical_word_count: median total_word_count per speech act
          - mean_word_count: mean total_word_count per speech act
          - interruption_rate: fraction of speech acts that were interrupted
          - burst_sizes: list of message counts (raw data)
          - word_counts: list of word counts (raw data)
    """
    user_acts = [a for a in speech_acts if str(a.sender_id) == str(sender_id)]

    if not user_acts:
        return {
            "sender_id": sender_id,
            "speech_act_count": 0,
            "typical_burst_size": 0,
            "mean_burst_size": 0.0,
            "typical_inter_message_gap_seconds": None,
            "typical_word_count": 0,
            "mean_word_count": 0.0,
            "interruption_rate": 0.0,
            "burst_sizes": [],
            "word_counts": [],
        }

    burst_sizes = [a.message_count for a in user_acts]
    word_counts = [a.total_word_count for a in user_acts]
    interrupted_count = sum(1 for a in user_acts if a.was_interrupted)

    # Compute inter-message gaps within speech acts
    all_gaps = []
    for act in user_acts:
        if act.message_count < 2:
            continue
        times = sorted(_parse_ts(m["timestamp"]) for m in act.messages)
        for i in range(1, len(times)):
            gap = (times[i] - times[i - 1]).total_seconds()
            all_gaps.append(gap)

    typical_gap = statistics.median(all_gaps) if all_gaps else None

    return {
        "sender_id": sender_id,
        "speech_act_count": len(user_acts),
        "typical_burst_size": statistics.median(burst_sizes),
        "mean_burst_size": statistics.mean(burst_sizes),
        "typical_inter_message_gap_seconds": typical_gap,
        "typical_word_count": statistics.median(word_counts),
        "mean_word_count": statistics.mean(word_counts),
        "interruption_rate": interrupted_count / len(user_acts),
        "burst_sizes": burst_sizes,
        "word_counts": word_counts,
    }

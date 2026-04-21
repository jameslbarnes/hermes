"""
channel_stats.py — Rolling window statistics per channel.

Computes rolling statistics over a configurable time window for use by
response rules.  Connects to the SQLite message store directly.

All functions accept a db_path and query the 'messages' table with the schema:
  message_id, chat_id, topic_id, sender_id, sender_name, text,
  message_type, reply_to_message_id, timestamp
"""

import sqlite3
import math
import statistics
from datetime import datetime, timedelta
from collections import defaultdict, Counter
from typing import Dict, List, Any, Optional, Tuple

import os as _os
import sys as _sys
# Ensure sibling modules are importable when invoked as a script
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

from message_aggregator import aggregate_speech_acts, _parse_ts


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fetch_window(
    db_path: str,
    chat_id: str,
    window_minutes: float,
    topic_id: Optional[int] = None,
    ref_time: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Fetch messages from the last *window_minutes* minutes for a given chat.

    Args:
        db_path: path to the SQLite database file.
        chat_id: the chat/channel identifier.
        window_minutes: how far back to look.
        topic_id: optional topic filter.
        ref_time: reference "now" for the window end (default: utcnow).

    Returns:
        List of row dicts sorted by timestamp ascending.
    """
    if ref_time is None:
        ref_time = datetime.utcnow()
    start = ref_time - timedelta(minutes=window_minutes)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if topic_id is not None:
            rows = conn.execute(
                """SELECT message_id, chat_id, topic_id, sender_id, sender_name,
                          text, message_type, reply_to_message_id, timestamp
                   FROM messages
                   WHERE chat_id = ? AND topic_id = ? AND timestamp >= ? AND timestamp <= ?
                   ORDER BY timestamp ASC""",
                (chat_id, topic_id, start.isoformat(), ref_time.isoformat()),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT message_id, chat_id, topic_id, sender_id, sender_name,
                          text, message_type, reply_to_message_id, timestamp
                   FROM messages
                   WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
                   ORDER BY timestamp ASC""",
                (chat_id, start.isoformat(), ref_time.isoformat()),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _word_count(text: Optional[str]) -> int:
    if not text:
        return 0
    return len(text.split())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_rolling_word_counts(
    db_path: str,
    chat_id: str,
    window_minutes: float = 30,
    topic_id: Optional[int] = None,
    ref_time: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Compute rolling word-count statistics for the given chat window.

    Returns a dict with:
      all_counts      – list of word counts for every message in the window
      trimmed_counts  – middle 80% (drop top/bottom 10%)
      trimmed_mean    – mean of trimmed_counts
      trimmed_std     – stdev of trimmed_counts
      cap             – trimmed_mean + 1.5 * trimmed_std (response word limit)
      per_user        – dict of sender_id -> per-user stats
      sample_size     – number of messages in the window
    """
    messages = _fetch_window(db_path, chat_id, window_minutes, topic_id, ref_time)

    all_counts = [_word_count(m.get("text")) for m in messages]
    sample_size = len(all_counts)

    # Trimmed counts: drop bottom 10% and top 10%
    if sample_size >= 5:
        sorted_counts = sorted(all_counts)
        lo = max(1, round(sample_size * 0.10))
        hi = sample_size - lo
        trimmed_counts = sorted_counts[lo:hi]
    elif sample_size > 0:
        trimmed_counts = list(all_counts)
    else:
        trimmed_counts = []

    if trimmed_counts:
        trimmed_mean = statistics.mean(trimmed_counts)
        trimmed_std = statistics.pstdev(trimmed_counts) if len(trimmed_counts) > 1 else 0.0
    else:
        trimmed_mean = 0.0
        trimmed_std = 0.0

    cap = trimmed_mean + 1.5 * trimmed_std

    # Per-user stats (including speech-act aggregation)
    speech_acts = aggregate_speech_acts(messages) if messages else []

    # Build per-user speech act index
    sa_by_user: Dict[str, list] = defaultdict(list)
    for sa in speech_acts:
        sa_by_user[str(sa.sender_id)].append(sa)

    per_user: Dict[str, Dict[str, Any]] = {}
    user_messages: Dict[str, list] = defaultdict(list)
    for m in messages:
        user_messages[str(m["sender_id"])].append(m)

    for sid, msgs in user_messages.items():
        total_words = sum(_word_count(m.get("text")) for m in msgs)
        msg_count = len(msgs)
        user_sa = sa_by_user.get(sid, [])
        sa_word_counts = [sa.total_word_count for sa in user_sa]
        per_user[sid] = {
            "message_count": msg_count,
            "total_words": total_words,
            "avg_words": total_words / msg_count if msg_count else 0.0,
            "speech_act_count": len(user_sa),
            "avg_words_per_speech_act": (
                statistics.mean(sa_word_counts) if sa_word_counts else 0.0
            ),
        }

    return {
        "all_counts": all_counts,
        "trimmed_counts": trimmed_counts,
        "trimmed_mean": trimmed_mean,
        "trimmed_std": trimmed_std,
        "cap": cap,
        "per_user": per_user,
        "sample_size": sample_size,
    }


def get_conversation_velocity(
    db_path: str,
    chat_id: str,
    window_minutes: float = 30,
    topic_id: Optional[int] = None,
    active_threshold: int = 5,
    ref_time: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Compute conversation velocity metrics for the given chat window.

    Returns:
      messages_per_minute  – raw message rate
      active_participants  – count of distinct senders
      participant_ids      – list of sender_ids
      burst_score          – ratio of max 5-min sub-window rate to average rate
      is_active            – True if >= active_threshold messages in window
    """
    messages = _fetch_window(db_path, chat_id, window_minutes, topic_id, ref_time)

    total = len(messages)
    mpm = total / window_minutes if window_minutes > 0 else 0.0

    sender_ids = list({str(m["sender_id"]) for m in messages})
    active_participants = len(sender_ids)

    # Burst score: divide the window into 5-minute sub-windows
    burst_score = 1.0
    if total > 0 and window_minutes > 0:
        sub_window = 5.0  # minutes
        num_buckets = max(1, math.ceil(window_minutes / sub_window))
        # Find the reference start
        timestamps = [_parse_ts(m["timestamp"]) for m in messages]
        t_min = min(timestamps)
        bucket_counts = [0] * num_buckets
        for ts in timestamps:
            offset_min = (ts - t_min).total_seconds() / 60.0
            bucket_idx = min(int(offset_min / sub_window), num_buckets - 1)
            bucket_counts[bucket_idx] += 1

        avg_rate = total / num_buckets if num_buckets > 0 else 0
        max_rate = max(bucket_counts) if bucket_counts else 0
        burst_score = max_rate / avg_rate if avg_rate > 0 else 1.0

    return {
        "messages_per_minute": mpm,
        "active_participants": active_participants,
        "participant_ids": sender_ids,
        "burst_score": burst_score,
        "is_active": total >= active_threshold,
    }


def get_response_probability(
    db_path: str,
    chat_id: str,
    bot_sender_id: str,
    window_minutes: float = 30,
    topic_id: Optional[int] = None,
    alpha: float = 0.5,
    ref_time: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Compute time-weighted response probability for the bot.

    Uses hyperbolic decay: p = 1 / (1 + alpha * weighted_n)

    weighted_n counts consecutive non-bot speech acts (most recent first),
    with messages arriving within 5s of each other increasing effective n faster.

    A participant boost is applied when 3+ participants are active.

    Returns:
      base_probability        – p before participant boost
      participant_boost       – multiplier from active participants
      final_probability       – base * boost (clamped to [0, 1])
      consecutive_human_acts  – raw count of consecutive non-bot speech acts
      active_participants     – distinct sender count in window
    """
    messages = _fetch_window(db_path, chat_id, window_minutes, topic_id, ref_time)

    if not messages:
        return {
            "base_probability": 1.0,
            "participant_boost": 1.0,
            "final_probability": 1.0,
            "consecutive_human_acts": 0,
            "active_participants": 0,
        }

    speech_acts = aggregate_speech_acts(messages)
    active_participants = len({str(m["sender_id"]) for m in messages})

    # Count consecutive non-bot speech acts from the end
    consecutive_human = 0
    weighted_n = 0.0
    for sa in reversed(speech_acts):
        if str(sa.sender_id) == str(bot_sender_id):
            break
        consecutive_human += 1

        # Weight by burst speed: compute average inter-message gap within the act
        if sa.message_count >= 2:
            times = sorted(_parse_ts(m["timestamp"]) for m in sa.messages)
            gaps = [(times[i] - times[i - 1]).total_seconds() for i in range(1, len(times))]
            avg_gap = statistics.mean(gaps) if gaps else 30.0
        else:
            avg_gap = 30.0  # single message = default gap

        # Rapid bursts (avg gap < 5s) count as more; slow acts count as less
        if avg_gap <= 5.0:
            speed_weight = 1.5  # rapid fire increases effective n
        elif avg_gap <= 15.0:
            speed_weight = 1.0
        else:
            speed_weight = 0.7

        weighted_n += speed_weight

    base_p = 1.0 / (1.0 + alpha * weighted_n)

    # Participant boost: more participants = bot should be more engaged
    if active_participants >= 5:
        boost = 1.4
    elif active_participants >= 3:
        boost = 1.2
    else:
        boost = 1.0

    final_p = min(1.0, base_p * boost)

    return {
        "base_probability": round(base_p, 4),
        "participant_boost": boost,
        "final_probability": round(final_p, 4),
        "consecutive_human_acts": consecutive_human,
        "active_participants": active_participants,
    }


def get_participant_geometry(
    db_path: str,
    chat_id: str,
    window_minutes: float = 10,
    topic_id: Optional[int] = None,
    bot_sender_id: Optional[str] = None,
    ref_time: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Analyse participant geometry: who is talking, conversational pairs, equality.

    Returns:
      active_count       – distinct senders in window
      pairs              – list of (sender_a, sender_b, exchange_count) tuples
      is_dyadic          – True if exactly 2 active participants
      bot_is_participant – True if bot_sender_id has sent in this window
      gini_coefficient   – 0 = equal participation, 1 = one person dominates
    """
    messages = _fetch_window(db_path, chat_id, window_minutes, topic_id, ref_time)

    sender_counts: Counter = Counter()
    for m in messages:
        sender_counts[str(m["sender_id"])] += 1

    active_count = len(sender_counts)

    # Detect conversational pairs: consecutive messages between two different
    # senders count as one "exchange" for that pair.
    pair_counts: Counter = Counter()
    for i in range(1, len(messages)):
        a = str(messages[i - 1]["sender_id"])
        b = str(messages[i]["sender_id"])
        if a != b:
            pair_key = tuple(sorted([a, b]))
            pair_counts[pair_key] += 1

    pairs = [
        (p[0], p[1], count)
        for p, count in pair_counts.most_common()
    ]

    is_dyadic = active_count == 2

    bot_is_participant = False
    if bot_sender_id is not None:
        bot_is_participant = str(bot_sender_id) in sender_counts

    # Gini coefficient of message counts
    gini = _gini(list(sender_counts.values())) if sender_counts else 0.0

    return {
        "active_count": active_count,
        "pairs": pairs,
        "is_dyadic": is_dyadic,
        "bot_is_participant": bot_is_participant,
        "gini_coefficient": round(gini, 4),
    }


def _gini(values: List[int]) -> float:
    """Compute the Gini coefficient for a list of non-negative values."""
    if not values or all(v == 0 for v in values):
        return 0.0
    n = len(values)
    if n == 1:
        return 0.0
    sorted_vals = sorted(values)
    total = sum(sorted_vals)
    cum = 0.0
    weighted_sum = 0.0
    for i, v in enumerate(sorted_vals):
        cum += v
        weighted_sum += (2 * (i + 1) - n - 1) * v
    return weighted_sum / (n * total)

#!/usr/bin/env python3
"""
test_analytics.py — Runnable test script for chat analytics modules.

Creates a temporary SQLite database with synthetic message data and exercises
every function in message_aggregator and channel_stats, printing results.
"""

import os
import sys
import sqlite3
import tempfile
from datetime import datetime, timedelta

# Ensure the module directory is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from message_aggregator import aggregate_speech_acts, get_user_burst_profile, _parse_ts
from channel_stats import (
    get_rolling_word_counts,
    get_conversation_velocity,
    get_response_probability,
    get_participant_geometry,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  topic_id INTEGER,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  reply_to_message_id INTEGER,
  timestamp TEXT NOT NULL,
  raw_event TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique ON messages(chat_id, message_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id);
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ts(base: datetime, offset_seconds: float) -> str:
    """Return ISO timestamp offset from base."""
    return (base + timedelta(seconds=offset_seconds)).isoformat()


def insert_msg(cur, msg_id, chat_id, sender_id, sender_name, text, timestamp,
               topic_id=None, message_type="text", reply_to=None):
    cur.execute(
        """INSERT INTO messages
           (message_id, chat_id, topic_id, sender_id, sender_name, text,
            message_type, reply_to_message_id, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (msg_id, chat_id, topic_id, sender_id, sender_name, text,
         message_type, reply_to, timestamp),
    )


def section(title):
    print(f"\n{'=' * 70}")
    print(f"  {title}")
    print(f"{'=' * 70}")


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    mark = "✓" if condition else "✗"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{mark}] {label}{suffix}")
    if not condition:
        global failures
        failures += 1


failures = 0

# ---------------------------------------------------------------------------
# Build the test database
# ---------------------------------------------------------------------------

db_fd, db_path = tempfile.mkstemp(suffix=".db")
os.close(db_fd)
print(f"Test database: {db_path}")

conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.executescript(SCHEMA)

# We'll use a reference time in the future so all messages fall within the window.
# BASE is 27 minutes before NOW; the latest message is at BASE + ~1538s ≈ 25.6min,
# so everything fits in a 30-minute window ending at NOW.
NOW = datetime.utcnow() + timedelta(minutes=2)  # give ourselves headroom
BASE = NOW - timedelta(minutes=28)  # 28 minutes before our ref_time

CHAT = "test_chat_1"
BOT_ID = "bot_42"

msg_id = 0

# --- Scenario 1: Burst of 5 messages from Alice in ~10 seconds ---
for i in range(5):
    msg_id += 1
    insert_msg(cur, msg_id, CHAT, "alice", "Alice",
               f"burst message {i+1} from alice with some words here",
               ts(BASE, i * 2))  # 0, 2, 4, 6, 8 seconds

# --- Scenario 2: Slow conversation between Bob and Carol over ~20 minutes ---
for i in range(10):
    msg_id += 1
    sender = "bob" if i % 2 == 0 else "carol"
    name = "Bob" if i % 2 == 0 else "Carol"
    insert_msg(cur, msg_id, CHAT, sender, name,
               f"{'Hey' if i == 0 else 'Yeah'} this is message {i+1} in a slow chat about various topics and things",
               ts(BASE, 120 + i * 120))  # every 2 minutes starting at +2min

# --- Scenario 3: Lively group chat with 4 users ---
users = [("dave", "Dave"), ("eve", "Eve"), ("frank", "Frank"), ("grace", "Grace")]
for i in range(20):
    msg_id += 1
    sid, sname = users[i % 4]
    insert_msg(cur, msg_id, CHAT, sid, sname,
               f"lively group message {i+1} with moderate length text about fun things and stuff",
               ts(BASE, 1320 + i * 8))  # every 8 seconds starting at +22min

# --- Scenario 4: Interrupted monologue (Alice talks, Bob interrupts, Alice continues) ---
mono_start = 1500  # +25 min
for i in range(3):
    msg_id += 1
    insert_msg(cur, msg_id, CHAT, "alice", "Alice",
               f"monologue part A-{i+1} where I am explaining something",
               ts(BASE, mono_start + i * 3))

# Bob interrupts
msg_id += 1
insert_msg(cur, msg_id, CHAT, "bob", "Bob",
           "sorry to interrupt but quick question",
           ts(BASE, mono_start + 12))

# Alice continues (within 30s of her last message at +9s = 21s gap)
for i in range(2):
    msg_id += 1
    insert_msg(cur, msg_id, CHAT, "alice", "Alice",
               f"continuing monologue A-{i+4} after interruption",
               ts(BASE, mono_start + 15 + i * 3))

# Bot message near the end
msg_id += 1
insert_msg(cur, msg_id, CHAT, BOT_ID, "Hermes",
           "I have a response to that",
           ts(BASE, mono_start + 25))

# A few more human messages after the bot
for i in range(3):
    msg_id += 1
    insert_msg(cur, msg_id, CHAT, "carol", "Carol",
               f"carol follows up message {i+1}",
               ts(BASE, mono_start + 30 + i * 4))

conn.commit()
conn.close()

print(f"Inserted {msg_id} messages.\n")

# ---------------------------------------------------------------------------
# Test 1: Speech Act Aggregation (from raw dicts)
# ---------------------------------------------------------------------------
section("1. Speech Act Aggregation (message_aggregator)")

# Fetch all messages as dicts for the aggregator
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp",
    (CHAT,),
).fetchall()
messages = [dict(r) for r in rows]
conn.close()

acts = aggregate_speech_acts(messages, burst_window_seconds=30)

print(f"\n  Total messages: {len(messages)}")
print(f"  Speech acts:    {len(acts)}\n")

for i, a in enumerate(acts):
    print(f"  Act {i+1}: {a.sender_name} | {a.message_count} msg(s) | "
          f"{a.total_word_count} words | interrupted={a.was_interrupted}")

# Check: Alice's burst of 5 should be a single speech act
alice_acts = [a for a in acts if a.sender_id == "alice"]
first_alice = alice_acts[0]
check("Alice burst: 5 msgs grouped into 1 speech act",
      first_alice.message_count == 5,
      f"got {first_alice.message_count}")

# Check: interrupted monologue — Alice should have an act with was_interrupted=True
interrupted_alice = [a for a in alice_acts if a.was_interrupted]
check("Alice has at least one interrupted speech act",
      len(interrupted_alice) >= 1,
      f"found {len(interrupted_alice)}")

if interrupted_alice:
    mono_act = interrupted_alice[-1]  # The monologue one
    check("Interrupted monologue merged: >=5 messages",
          mono_act.message_count >= 5,
          f"got {mono_act.message_count}")

# Check: Bob and Carol slow conversation should produce separate acts
bob_acts = [a for a in acts if a.sender_id == "bob"]
carol_acts = [a for a in acts if a.sender_id == "carol"]
check("Bob has multiple speech acts (slow convo = separate acts)",
      len(bob_acts) >= 2,
      f"got {len(bob_acts)}")

# ---------------------------------------------------------------------------
# Test 2: User Burst Profile
# ---------------------------------------------------------------------------
section("2. User Burst Profile")

profile = get_user_burst_profile(acts, "alice")
print(f"\n  Alice profile:")
for k, v in profile.items():
    if k not in ("burst_sizes", "word_counts"):
        print(f"    {k}: {v}")

check("Alice speech_act_count >= 2",
      profile["speech_act_count"] >= 2,
      f"got {profile['speech_act_count']}")
check("Alice typical_burst_size > 1",
      profile["typical_burst_size"] > 1,
      f"got {profile['typical_burst_size']}")
check("Alice has an inter-message gap value",
      profile["typical_inter_message_gap_seconds"] is not None)

# ---------------------------------------------------------------------------
# Test 3: Rolling Word Counts
# ---------------------------------------------------------------------------
section("3. Rolling Word Counts (channel_stats)")

wc = get_rolling_word_counts(db_path, CHAT, window_minutes=30, ref_time=NOW)
print(f"\n  sample_size:   {wc['sample_size']}")
print(f"  trimmed_mean:  {wc['trimmed_mean']:.2f}")
print(f"  trimmed_std:   {wc['trimmed_std']:.2f}")
print(f"  cap:           {wc['cap']:.2f}")
print(f"  per_user keys: {list(wc['per_user'].keys())}")

check("Sample size matches inserted messages",
      wc["sample_size"] == msg_id,
      f"got {wc['sample_size']}, expected {msg_id}")
check("Cap is positive",
      wc["cap"] > 0, f"got {wc['cap']:.2f}")
check("Per-user has alice",
      "alice" in wc["per_user"])

alice_pu = wc["per_user"].get("alice", {})
print(f"\n  Alice per-user: {alice_pu}")
check("Alice message_count matches",
      alice_pu.get("message_count", 0) == 10,
      f"got {alice_pu.get('message_count')}")

# ---------------------------------------------------------------------------
# Test 4: Conversation Velocity
# ---------------------------------------------------------------------------
section("4. Conversation Velocity")

vel = get_conversation_velocity(db_path, CHAT, window_minutes=30, ref_time=NOW)
print(f"\n  messages_per_minute: {vel['messages_per_minute']:.2f}")
print(f"  active_participants: {vel['active_participants']}")
print(f"  burst_score:         {vel['burst_score']:.2f}")
print(f"  is_active:           {vel['is_active']}")

check("Messages per minute > 0",
      vel["messages_per_minute"] > 0)
check("Active participants >= 7 (alice,bob,carol,dave,eve,frank,grace+bot)",
      vel["active_participants"] >= 7,
      f"got {vel['active_participants']}")
check("Burst score >= 1.0 (bursty data)",
      vel["burst_score"] >= 1.0,
      f"got {vel['burst_score']:.2f}")
check("is_active is True",
      vel["is_active"] is True)

# ---------------------------------------------------------------------------
# Test 5: Response Probability
# ---------------------------------------------------------------------------
section("5. Response Probability")

rp = get_response_probability(db_path, CHAT, BOT_ID,
                              window_minutes=30, ref_time=NOW)
print(f"\n  base_probability:       {rp['base_probability']}")
print(f"  participant_boost:      {rp['participant_boost']}")
print(f"  final_probability:      {rp['final_probability']}")
print(f"  consecutive_human_acts: {rp['consecutive_human_acts']}")
print(f"  active_participants:    {rp['active_participants']}")

check("Base probability < 1.0 (there are human acts after bot)",
      rp["base_probability"] < 1.0,
      f"got {rp['base_probability']}")
check("Consecutive human acts >= 1",
      rp["consecutive_human_acts"] >= 1,
      f"got {rp['consecutive_human_acts']}")
check("Participant boost >= 1.2 (many participants)",
      rp["participant_boost"] >= 1.2,
      f"got {rp['participant_boost']}")
check("Final probability is in [0, 1]",
      0 <= rp["final_probability"] <= 1.0)

# ---------------------------------------------------------------------------
# Test 6: Participant Geometry
# ---------------------------------------------------------------------------
section("6. Participant Geometry")

geo = get_participant_geometry(db_path, CHAT, window_minutes=30,
                               bot_sender_id=BOT_ID, ref_time=NOW)
print(f"\n  active_count:       {geo['active_count']}")
print(f"  is_dyadic:          {geo['is_dyadic']}")
print(f"  bot_is_participant: {geo['bot_is_participant']}")
print(f"  gini_coefficient:   {geo['gini_coefficient']}")
print(f"  top pairs:")
for a, b, c in geo["pairs"][:5]:
    print(f"    {a} <-> {b}: {c} exchanges")

check("Active count >= 7",
      geo["active_count"] >= 7,
      f"got {geo['active_count']}")
check("Not dyadic (many participants)",
      geo["is_dyadic"] is False)
check("Bot is a participant",
      geo["bot_is_participant"] is True)
check("Gini coefficient > 0 (unequal participation)",
      geo["gini_coefficient"] > 0,
      f"got {geo['gini_coefficient']}")
check("At least some pairs detected",
      len(geo["pairs"]) >= 1,
      f"got {len(geo['pairs'])} pairs")

# ---------------------------------------------------------------------------
# Test 7: Edge cases
# ---------------------------------------------------------------------------
section("7. Edge Cases")

# Empty aggregation
empty_acts = aggregate_speech_acts([])
check("Empty message list -> empty speech acts", len(empty_acts) == 0)

# Single message
single = [{"sender_id": "x", "sender_name": "X", "text": "hello world",
           "timestamp": datetime.utcnow().isoformat()}]
single_acts = aggregate_speech_acts(single)
check("Single message -> 1 speech act", len(single_acts) == 1)
check("Single act has 1 message", single_acts[0].message_count == 1)
check("Single act word count = 2", single_acts[0].total_word_count == 2)

# Empty user profile
empty_profile = get_user_burst_profile([], "nobody")
check("Empty profile speech_act_count = 0",
      empty_profile["speech_act_count"] == 0)

# Nonexistent chat in channel_stats
empty_wc = get_rolling_word_counts(db_path, "nonexistent_chat",
                                    window_minutes=30, ref_time=NOW)
check("Nonexistent chat -> sample_size 0",
      empty_wc["sample_size"] == 0)
check("Nonexistent chat -> cap 0",
      empty_wc["cap"] == 0.0)

empty_vel = get_conversation_velocity(db_path, "nonexistent_chat",
                                       window_minutes=30, ref_time=NOW)
check("Nonexistent chat velocity -> 0 mpm",
      empty_vel["messages_per_minute"] == 0.0)
check("Nonexistent chat -> not active",
      empty_vel["is_active"] is False)

empty_rp = get_response_probability(db_path, "nonexistent_chat", BOT_ID,
                                     window_minutes=30, ref_time=NOW)
check("Nonexistent chat -> probability 1.0",
      empty_rp["final_probability"] == 1.0)

empty_geo = get_participant_geometry(db_path, "nonexistent_chat",
                                      window_minutes=30, ref_time=NOW)
check("Nonexistent chat -> active_count 0",
      empty_geo["active_count"] == 0)

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
section("SUMMARY")
if failures == 0:
    print("\n  All checks passed!\n")
else:
    print(f"\n  {failures} check(s) FAILED.\n")

# Cleanup
os.unlink(db_path)
print(f"  Cleaned up {db_path}")

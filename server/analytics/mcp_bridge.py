#!/usr/bin/env python3
"""
mcp_bridge.py — CLI bridge for MCP tools to call chat analytics functions.

Usage:
    python3 mcp_bridge.py <action> [--chat_id X] [--topic_id N] [--bot_sender_id X]
                                    [--window_minutes N] [--db_path PATH]

Actions:
    word_count_stats       Rolling word-count statistics
    response_probability   Time-weighted response probability for the bot
    participant_geometry   Participant geometry analysis
    conversation_velocity  Conversation velocity metrics
    full_snapshot          All of the above combined into one response

Outputs JSON to stdout. Errors go to stderr with a non-zero exit code.
"""

import argparse
import json
import os
import sys

# Ensure sibling modules are importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from channel_stats import (
    get_rolling_word_counts,
    get_conversation_velocity,
    get_response_probability,
    get_participant_geometry,
)

DEFAULT_DB_PATH = "/data/telegram-messages.db"
DEFAULT_BOT_SENDER_ID = "hermes"


def main():
    parser = argparse.ArgumentParser(description="Chat analytics MCP bridge")
    parser.add_argument("action", choices=[
        "word_count_stats",
        "response_probability",
        "participant_geometry",
        "conversation_velocity",
        "full_snapshot",
    ])
    parser.add_argument("--chat_id", required=True, help="Telegram chat ID")
    parser.add_argument("--topic_id", type=int, default=None, help="Forum topic/thread ID")
    parser.add_argument("--bot_sender_id", default=DEFAULT_BOT_SENDER_ID,
                        help="Bot's sender ID for response probability")
    parser.add_argument("--window_minutes", type=float, default=30,
                        help="Rolling window in minutes (default: 30)")
    parser.add_argument("--db_path", default=DEFAULT_DB_PATH,
                        help="Path to SQLite database")

    args = parser.parse_args()

    db_path = args.db_path
    if not os.path.exists(db_path):
        print(json.dumps({
            "error": f"Database not found at {db_path}",
            "hint": "The message store may not have been initialized yet.",
        }))
        sys.exit(1)

    result = {}

    if args.action == "word_count_stats":
        result = get_rolling_word_counts(
            db_path, args.chat_id,
            window_minutes=args.window_minutes,
            topic_id=args.topic_id,
        )
    elif args.action == "conversation_velocity":
        result = get_conversation_velocity(
            db_path, args.chat_id,
            window_minutes=args.window_minutes,
            topic_id=args.topic_id,
        )
    elif args.action == "response_probability":
        result = get_response_probability(
            db_path, args.chat_id,
            bot_sender_id=args.bot_sender_id,
            window_minutes=args.window_minutes,
            topic_id=args.topic_id,
        )
    elif args.action == "participant_geometry":
        result = get_participant_geometry(
            db_path, args.chat_id,
            window_minutes=args.window_minutes,
            topic_id=args.topic_id,
            bot_sender_id=args.bot_sender_id,
        )
    elif args.action == "full_snapshot":
        result = {
            "word_count_stats": get_rolling_word_counts(
                db_path, args.chat_id,
                window_minutes=args.window_minutes,
                topic_id=args.topic_id,
            ),
            "conversation_velocity": get_conversation_velocity(
                db_path, args.chat_id,
                window_minutes=args.window_minutes,
                topic_id=args.topic_id,
            ),
            "response_probability": get_response_probability(
                db_path, args.chat_id,
                bot_sender_id=args.bot_sender_id,
                window_minutes=args.window_minutes,
                topic_id=args.topic_id,
            ),
            "participant_geometry": get_participant_geometry(
                db_path, args.chat_id,
                window_minutes=args.window_minutes,
                topic_id=args.topic_id,
                bot_sender_id=args.bot_sender_id,
            ),
        }

    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3

import json
import os
import re
import secrets
import shlex
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


KEY_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
HANDLE_RE = re.compile(r"^[a-z][a-z0-9_]{2,14}$")


def log(message: str) -> None:
    print(f"[identity] {message}", file=sys.stderr)


def fail(message: str) -> "NoReturn":
    log(message)
    raise SystemExit(1)


def decode_json(raw: bytes) -> dict:
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


def post_json(base_url: str, path: str, payload: dict, retries: int = 20, delay_s: int = 2) -> tuple[int, dict]:
    url = f"{base_url}{path}"
    body = json.dumps(payload).encode("utf-8")
    last_error = "unknown error"

    for attempt in range(1, retries + 1):
        request = Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, decode_json(response.read())
        except HTTPError as exc:
            payload = decode_json(exc.read())
            if 400 <= exc.code < 500 and exc.code not in {408, 429}:
                return exc.code, payload
            last_error = f"HTTP {exc.code}: {payload}"
        except URLError as exc:
            last_error = f"network error: {exc.reason}"

        if attempt < retries:
            time.sleep(delay_s)

    fail(f"Failed contacting Hermes server at {url} after {retries} attempts ({last_error})")


def normalize_handle(raw_handle: str) -> str:
    return raw_handle.strip().lstrip("@").lower()


def main() -> None:
    hermes_home = Path(os.environ["HERMES_HOME"])
    hermes_home.mkdir(parents=True, exist_ok=True)

    key_file = hermes_home / "secret_key"
    explicit_key = os.environ.get("HERMES_SECRET_KEY", "").strip()
    desired_handle = normalize_handle(os.environ.get("HERMES_HANDLE", "router"))
    mcp_url = os.environ.get("HERMES_MCP_URL", "http://hermes:3000/mcp/http")

    if not HANDLE_RE.fullmatch(desired_handle):
        fail(f"Invalid HERMES_HANDLE '{desired_handle}'")

    parsed = urlparse(mcp_url)
    if not parsed.scheme or not parsed.netloc:
        fail(f"Invalid HERMES_MCP_URL '{mcp_url}'")
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    key = ""
    source = ""

    if explicit_key:
        key = explicit_key
        source = "env"
    elif key_file.exists():
        key = key_file.read_text(encoding="utf-8").strip()
        if key:
            source = "disk"

    if not key:
        key = secrets.token_urlsafe(32)
        source = "generated"
        log("Generated new Hermes notebook key")

    if not KEY_RE.fullmatch(key):
        fail("Resolved HERMES secret key is not a valid Hermes identity key")

    key_file.write_text(f"{key}\n", encoding="utf-8")
    os.chmod(key_file, 0o600)

    status, lookup = post_json(base_url, "/api/identity/lookup", {"secret_key": key})
    if status != 200:
        fail(f"Identity lookup failed with status {status}: {lookup}")

    pseudonym = lookup.get("pseudonym") or ""
    handle = lookup.get("handle")

    if not lookup.get("hasAccount"):
        log(f"Key from {source} is unregistered; attempting to claim @{desired_handle}")
        status, registration = post_json(
            base_url,
            "/api/identity/register",
            {"secret_key": key, "handle": desired_handle},
        )

        if status == 201:
            handle = registration.get("handle") or desired_handle
            pseudonym = registration.get("pseudonym") or pseudonym
            log(f"Registered Hermes identity @{handle}")
        else:
            if source == "generated":
                try:
                    key_file.unlink()
                except FileNotFoundError:
                    pass
            fail(
                f"Unable to register @{desired_handle}: "
                f"{registration.get('error') or registration}"
            )

    if handle and handle != desired_handle:
        log(
            f"Warning: identity resolves to @{handle}, not @{desired_handle}. "
            f"Moderator-gated tools may be unavailable unless server MODERATOR_HANDLES includes @{handle}."
        )
    elif handle:
        log(f"Using Hermes identity @{handle} from {source}")

    print(f"export HERMES_SECRET_KEY={shlex.quote(key)}")
    print(f"export HERMES_SECRET_KEY_SOURCE={shlex.quote(source)}")
    print(f"export HERMES_AGENT_HANDLE={shlex.quote(handle or desired_handle)}")
    print(f"export HERMES_IDENTITY_PSEUDONYM={shlex.quote(pseudonym)}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Basic Safari runtime smoke test for Neon Knockout.

Uses safaridriver directly via WebDriver HTTP (no third-party dependencies).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for_port(port: int, timeout_s: float = 10.0) -> None:
    start = time.time()
    while time.time() - start < timeout_s:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.08)
    raise RuntimeError(f"safaridriver did not open port {port} in {timeout_s:.1f}s")


class WebDriverClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def request(self, method: str, path: str, payload: dict | None = None) -> dict:
        data = None
        headers = {"Content-Type": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url=f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"WebDriver HTTP {e.code}: {body}") from e


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Safari runtime smoke test.")
    parser.add_argument(
        "--html",
        default="index.html",
        help="Path to game HTML file (default: index.html in cwd).",
    )
    parser.add_argument(
        "--screenshot",
        default="/tmp/neon_knockout_safari_smoke.png",
        help="Output screenshot path.",
    )
    args = parser.parse_args()

    html_path = Path(args.html).resolve()
    if not html_path.exists():
        print(f"ERROR: HTML not found: {html_path}")
        return 2

    port = find_free_port()
    driver_cmd = ["safaridriver", "-p", str(port)]
    proc = subprocess.Popen(
        driver_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    session_id = None
    client = WebDriverClient(f"http://127.0.0.1:{port}")
    try:
        wait_for_port(port)

        created = client.request(
            "POST",
            "/session",
            {
                "capabilities": {
                    "alwaysMatch": {
                        "browserName": "safari",
                    }
                }
            },
        )
        session_id = created.get("value", {}).get("sessionId") or created.get("sessionId")
        if not session_id:
            raise RuntimeError(f"Session creation failed: {created}")

        client.request(
            "POST",
            f"/session/{session_id}/url",
            {"url": html_path.as_uri()},
        )

        # Give the game time to initialize and draw first frame.
        time.sleep(1.0)

        info = client.request(
            "POST",
            f"/session/{session_id}/execute/sync",
            {
                "script": """
                    const c = document.querySelector('canvas');
                    return {
                      title: document.title || '',
                      hasCanvas: !!c,
                      canvasW: c ? c.width : 0,
                      canvasH: c ? c.height : 0,
                      versionCounter: localStorage.getItem('nk_version_counter'),
                      versionSignature: localStorage.getItem('nk_version_signature')
                    };
                """,
                "args": [],
            },
        )
        value = info.get("value", {}) if isinstance(info, dict) else {}

        if not value.get("hasCanvas"):
            raise RuntimeError(f"Smoke check failed: canvas missing ({value})")
        if int(value.get("canvasW", 0) or 0) <= 0 or int(value.get("canvasH", 0) or 0) <= 0:
            raise RuntimeError(f"Smoke check failed: invalid canvas size ({value})")

        shot = client.request("GET", f"/session/{session_id}/screenshot")
        shot_b64 = shot.get("value")
        if not shot_b64:
            raise RuntimeError("Smoke check failed: screenshot capture returned no data")
        png = base64.b64decode(shot_b64)
        out_path = Path(args.screenshot).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(png)

        print("Safari smoke test passed")
        print(f"HTML: {html_path}")
        print(f"Screenshot: {out_path}")
        print(f"Runtime info: {json.dumps(value)}")
        return 0
    finally:
        if session_id:
            try:
                client.request("DELETE", f"/session/{session_id}")
            except Exception:
                pass
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

        # Drain output for debugging if needed.
        try:
            _ = proc.stdout.read() if proc.stdout else ""
            _ = proc.stderr.read() if proc.stderr else ""
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())

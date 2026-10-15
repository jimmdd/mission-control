#!/usr/bin/env python3
"""Bounded recovery for the review runner; this does not authorize delivery.

Only a completed invocation without infrastructure errors is handed to the
head/base-bound readiness gate. Never change CLI configuration or OS security.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time


TRANSIENT = re.compile(
    r"^(?:ERROR:\s*)?(?:timed out negotiating with the code-mode host|"
    r"code-mode host (?:exited unexpectedly|disconnected)|"
    r"stream disconnected before completion)(?:[.:].*)?$", re.I | re.M,
)
VERDICT = re.compile(r"^VERDICT: (PASS|FAIL|WARN)\b", re.M)


def stop_group(process):
    # The CLI's host can outlive its parent and keep stdout open. This is our
    # new session only; never inspect or kill other agents or shared daemons.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def infrastructure_failure(answer, transcript):
    if TRANSIENT.search(answer):
        return True
    # Read only error/assistant events. The transcript can echo the whole diff,
    # including a regression test containing the error string we are fixing.
    for line in transcript.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get("item") or event
        if item.get("type") in ("error", "agent_message"):
            if TRANSIENT.search(str(item.get("message") or item.get("text") or "")):
                return True
    return False


def run(prompt, result, timeout, model="", executable="codex"):
    result = Path(result)
    result.unlink(missing_ok=True)
    deadline = time.monotonic() + timeout
    last_reason = ""
    with tempfile.TemporaryDirectory(prefix="mc-codex-review-") as temp:
        for attempt in range(1, 3):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            output = Path(temp) / f"answer-{attempt}.txt"
            transcript = Path(temp) / f"transcript-{attempt}.txt"
            args = [executable, "exec", "--skip-git-repo-check", "--sandbox", "read-only",
                    "--json", "--output-last-message", str(output)]
            if model:
                args += ["--model", model]
            timed_out = False
            try:
                with transcript.open("w+") as log:
                    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=log,
                                               stderr=subprocess.STDOUT, start_new_session=True)
                    try:
                        process.communicate(input=prompt.encode(), timeout=min(remaining, timeout / 2))
                    except subprocess.TimeoutExpired:
                        timed_out = True
                        stop_group(process)
                    finally:
                        # Also reclaim descendants if a parent exits before its host.
                        stop_group(process)
            except OSError as error:
                print(f"Codex review failed to run: {error}")
                return 2
            answer = output.read_text() if output.exists() else ""
            log_text = transcript.read_text()
            infrastructure = infrastructure_failure(answer, log_text)
            if timed_out:
                last_reason = f"produced no completed review within {timeout:g}s total budget"
            elif infrastructure:
                last_reason = "code-mode host or transport failed before review completed"
            elif process.returncode != 0:
                print("Codex review failed to run")
                print("\n".join(log_text.splitlines()[-8:]))
                return 2
            else:
                # Actual findings/WARN and malformed verdicts go to the gate without
                # retries. A fresh review, not a more agreeable verdict, is required.
                if any(verdict in ("FAIL", "WARN") for verdict in VERDICT.findall(answer)):
                    print(answer)
                    return 1
                result.write_text(answer)
                print(answer)
                return 0
            verdicts = VERDICT.findall(answer)
            # A substantive warning/finding must not be replaced by a second verdict.
            # Explicit host errors remain retryable even if the CLI appends WARN.
            if "FAIL" in verdicts:
                print(answer)
                return 1
            if attempt < 2 and time.monotonic() < deadline:
                print(f"Codex review attempt {attempt}: {last_reason}; retrying once within the same budget.")
        print(f"Codex review unavailable after bounded recovery: {last_reason}.")
        print("Check `codex --version` and a read-only shell probe. No review receipt was issued; "
              "repair the runner or request a specific supported installation action, then rerun review.")
        return 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result")
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--model", default="")
    args = parser.parse_args()
    if not 0 < args.timeout <= 3600:
        parser.error("timeout must be greater than zero and at most 3600 seconds")
    sys.exit(run(sys.stdin.read(), args.result, args.timeout, args.model))

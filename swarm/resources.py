"""What the machine can still take.

Agent concurrency was capped by a count. A count is a guess about memory dressed
up as a policy: four small agents and four agents each holding a large repo in
context are not the same load, and the number needs re-tuning on every machine.
Worse, the count was computed from registry entries, so three dead agents nobody
reaped held three of four slots and the daemon would have refused to start work
while the machine sat idle.

So the ceiling is measured instead. New agents start freely until memory is
genuinely tight, and stop when it is.

Unknown is not full. If memory cannot be read — an unfamiliar platform, a tool
missing — this reports None and the caller carries on. A monitoring gap should not
halt the machine.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
from typing import Optional

# Above this fraction of memory in use, no new agent starts. Below it, no limit.
DEFAULT_MEMORY_CEILING = 0.90


def memory_ceiling() -> float:
    """The configured ceiling, as a fraction. `MC_MEMORY_CEILING=0.8` to change it."""
    raw = os.environ.get("MC_MEMORY_CEILING", "")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_MEMORY_CEILING
    # A ceiling outside (0, 1] is a typo, not an intention — 90 meaning 90% is the
    # obvious one, so accept it rather than treating the machine as permanently full.
    if value > 1:
        value = value / 100
    return value if 0 < value <= 1 else DEFAULT_MEMORY_CEILING


def _from_psutil() -> Optional[float]:
    try:
        import psutil  # type: ignore
    except ImportError:
        return None
    try:
        return float(psutil.virtual_memory().percent) / 100
    except Exception:
        return None


def _from_vm_stat() -> Optional[float]:
    """macOS. Available = free + inactive + speculative + purgeable.

    Inactive and purgeable pages are reclaimed under pressure, so counting them as
    used would report a healthy Mac as full — file cache alone would block every
    spawn.
    """
    try:
        total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True,
                                   text=True, timeout=10).stdout.strip())
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    if not total or not out:
        return None

    page = 4096
    match = re.search(r"page size of (\d+) bytes", out)
    if match:
        page = int(match.group(1))

    counts = {}
    for line in out.splitlines():
        m = re.match(r'"?([A-Za-z][^:"]*)"?:\s+(\d+)', line.strip())
        if m:
            counts[m.group(1).strip().lower()] = int(m.group(2))

    available_pages = sum(counts.get(k, 0) for k in
                          ("pages free", "pages inactive", "pages speculative",
                           "pages purgeable"))
    if not available_pages:
        return None
    return max(0.0, min(1.0, 1 - (available_pages * page) / total))


def _from_proc_meminfo() -> Optional[float]:
    """Linux. MemAvailable is the kernel's own estimate and beats guessing."""
    try:
        text = open("/proc/meminfo").read()
    except OSError:
        return None
    values = {}
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) == 2:
            digits = parts[1].strip().split()
            if digits and digits[0].isdigit():
                values[parts[0].strip()] = int(digits[0])
    total, available = values.get("MemTotal"), values.get("MemAvailable")
    if not total or available is None:
        return None
    return max(0.0, min(1.0, 1 - available / total))


def memory_used_fraction() -> Optional[float]:
    """Fraction of memory in use (0..1), or None when it cannot be determined."""
    for probe in (_from_psutil,
                  _from_vm_stat if platform.system() == "Darwin" else _from_proc_meminfo):
        value = probe()
        if value is not None:
            return value
    return None


def can_start_agent() -> bool:
    """Is there room for another agent right now?

    True when memory is below the ceiling, and true when memory is unreadable — a
    machine we cannot measure is not a machine we should refuse to use.
    """
    used = memory_used_fraction()
    return True if used is None else used < memory_ceiling()


def describe() -> str:
    used = memory_used_fraction()
    if used is None:
        return "memory unreadable — not limiting"
    return f"memory {used * 100:.0f}% used, ceiling {memory_ceiling() * 100:.0f}%"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Report whether another agent may start.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    used = memory_used_fraction()
    ok = can_start_agent()
    if args.json:
        print(json.dumps({"used": used, "ceiling": memory_ceiling(), "can_start": ok}))
    else:
        print(describe())
    # Exit code so a shell can branch on it without parsing anything.
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Count terminal writes per rendered frame from an `strace` log, and check the IME invariant.

Usage
-----
    # 1. record what pi writes to the terminal (a pty gives pi a real terminal)
    script -qec "strace -f -tt -e trace=write -s 8000 -o /tmp/pi-writes.log pi" /dev/null
    # 2. inspect it
    ./tools/count-writes-per-frame.py /tmp/pi-writes.log

What it reports
---------------
* writes per frame — a frame is the region between `ESC[?2026h` and `ESC[?2026l`
  (the synchronized-output block pi wraps every render in);
* for every frame, whether the hardware-cursor positioning (`ESC[<n>{A,B,C,D}` / `ESC[<n>G`)
  and the cursor-visibility write (`ESC[?25l` / `ESC[?25h`) land *before* `ESC[?2026l`.

The second check is the one that matters: if cursor bytes are written after the block is closed,
terminals sample two different cursor positions per frame and IME candidate windows flicker
(see docs/diagnosis.en.md). With the extension, frames end with something like
`... ESC[1B ESC[1G ESC[?25l ESC[?2026l`.

Note: use `-s 8000` when recording. With the default `-s 32`, long writes are truncated in the log
and frames cannot be delimited correctly (a mistake that has produced wrong results before).
"""

from __future__ import annotations

import collections
import re
import sys

LINE_RE = re.compile(r'^(\d+)\s+(\S+)\s+write\((\d+), "(.*)"(\.\.\.)?, (\d+)\) = (\d+)$')
CURSOR_RE = re.compile(r"\x1b\[(\d*)([ABCDG])")
SYNC_BEGIN = "\x1b[?2026h"
SYNC_END = "\x1b[?2026l"


def unescape(payload: str) -> str:
    """Decode one strace string literal (`\\33`, `\\x1b`, `\\r`, ...)."""

    def repl(match: re.Match[str]) -> str:
        body = match.group(1)
        if body.startswith("x"):
            return chr(int(body[1:], 16))
        if body in 'rntfva\\"':
            return {"r": "\r", "n": "\n", "t": "\t", "f": "\f", "v": "\v", "a": "\a", "\\": "\\", '"': '"'}[body]
        return chr(int(body, 8))

    return re.sub(r"\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)", repl, payload)


def load_writes(path: str) -> list[tuple[str, int, str, int]]:
    writes: list[tuple[str, int, str, int]] = []
    with open(path, errors="replace") as handle:
        for line in handle:
            match = LINE_RE.match(line.rstrip("\n"))
            if not match:
                continue
            _pid, timestamp, fd, payload, _truncated, size, _written = match.groups()
            writes.append((timestamp, int(fd), unescape(payload), int(size)))
    return writes


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    writes = load_writes(sys.argv[1])
    if not writes:
        print("no write() records found — was the log recorded with `strace -e trace=write`?")
        return 1

    sync_by_fd: collections.Counter[int] = collections.Counter()
    for _timestamp, fd, data, _size in writes:
        sync_by_fd[fd] += data.count(SYNC_BEGIN)
    candidates = [fd for fd, count in sync_by_fd.items() if count]
    if not candidates:
        print("no frame data found: none of the writes contains the synchronized-output marker")
        return 1

    out_fd = candidates[0]
    print(f"terminal fd in log: {out_fd} (synchronized-output blocks: {sync_by_fd[out_fd]})")

    frames: list[list[str]] = []
    current: list[str] = []
    started = False
    for _timestamp, fd, data, _size in writes:
        if fd != out_fd:
            continue
        if SYNC_BEGIN in data:
            started = True
        if not started:
            continue
        current.append(data)
        if SYNC_END in data:
            frames.append(current)
            current = []

    if not frames:
        print("no complete frames found")
        return 1

    sizes = collections.Counter(len(frame) for frame in frames)
    print(f"frames: {len(frames)}  writes per frame: {dict(sorted(sizes.items()))}")

    ok = 0
    for frame in frames:
        data = "".join(frame)
        end = data.rfind(SYNC_END)
        cursor = max((m.start() for m in CURSOR_RE.finditer(data)), default=-1)
        visibility = max(data.rfind("\x1b[?25l"), data.rfind("\x1b[?25h"))
        if cursor < end and visibility < end:
            ok += 1
    print(f"frames with cursor positioning + visibility inside the block: {ok}/{len(frames)}")
    print("=> a healthy result is ~1 write per frame and every frame inside the block.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
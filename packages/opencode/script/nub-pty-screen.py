#!/usr/bin/env python3
"""Run a command under a real pty and print the frame a terminal would show.

A TUI writes cursor-positioning escapes rather than lines, and OpenTUI does not
render at all unless stdout is a tty — so piping its output gives you nothing
useful, and `script` refuses when the harness has no controlling terminal.
`pty.fork()` has neither problem. This replays the capture into a screen model,
which is the only way to assert on a rendered frame from a non-interactive
harness.

Optionally drives keystrokes: each --key is written after a settle delay with the
frame captured in between, so a sequence can be checked step by step.

    ./nub-pty-screen.py ./dist-nub/opencode
    ./nub-pty-screen.py --seconds 30 --key $'\\x1b' --key $'\\x10' ./dist-nub/opencode
"""
import argparse
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import fcntl

CSI = re.compile(rb"\x1b\[([0-9;?]*)([a-zA-Z])")
OSC = re.compile(rb"\x1b\][^\x07]*\x07")


def render(raw, rows, cols):
    """Replay CUP/erase/newline into a screen model and return its non-blank lines."""
    screen = [[" "] * cols for _ in range(rows)]
    r = c = i = 0
    while i < len(raw):
        ch = raw[i : i + 1]
        if ch == b"\x1b":
            m = CSI.match(raw, i)
            if m:
                params, op = m.group(1).decode(), m.group(2).decode()
                if op == "H":
                    nums = [int(x) for x in params.split(";") if x] or [1]
                    r = max(0, nums[0] - 1)
                    c = max(0, (nums[1] - 1) if len(nums) > 1 else 0)
                elif op == "J" and params in ("2", "3"):
                    screen = [[" "] * cols for _ in range(rows)]
                    r = c = 0
                i = m.end()
                continue
            m = OSC.match(raw, i)
            i = m.end() if m else i + 1
            continue
        if ch == b"\n":
            r, c = r + 1, 0
        elif ch == b"\r":
            c = 0
        elif ch >= b" ":
            # Decode as UTF-8 so box-drawing and block glyphs land in one cell.
            width = 1
            byte = raw[i]
            if byte >= 0xF0:
                width = 4
            elif byte >= 0xE0:
                width = 3
            elif byte >= 0xC0:
                width = 2
            glyph = raw[i : i + width].decode("utf8", "replace")
            if 0 <= r < rows and 0 <= c < cols:
                screen[r][c] = glyph
            c += 1
            if c >= cols:
                r, c = r + 1, 0
            i += width
            if r >= rows:
                r = rows - 1
            continue
        i += 1
        if r >= rows:
            r = rows - 1
    return [line for line in ("".join(row).rstrip() for row in screen) if line.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=25)
    ap.add_argument("--key", action="append", default=[])
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("command", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    if not args.command:
        ap.error("a command is required")

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execvp(args.command[0], args.command)

    # Without a window size the TUI lays out against a 0x0 terminal and draws
    # nothing — this is the single most common reason a pty capture comes back empty.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    raw = bytearray()
    settle = args.seconds / (len(args.key) + 1) if args.key else args.seconds
    settle = max(settle, 5)

    def pump(duration):
        end = time.time() + duration
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return False
                if not chunk:
                    return False
                raw.extend(chunk)
        return True

    pump(settle)
    for key in args.key:
        print(f"---- frame before key {key!r} ----")
        print("\n".join(render(bytes(raw), args.rows, args.cols)))
        os.write(fd, key.encode())
        pump(settle)

    print("---- final frame ----")
    print("\n".join(render(bytes(raw), args.rows, args.cols)))
    os.kill(pid, signal.SIGTERM)
    os.close(fd)
    sys.exit(0)


if __name__ == "__main__":
    main()

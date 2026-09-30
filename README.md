# pi-ime-cursor-batch

Fixes one specific annoyance: **while pi streams output in Konsole (+fcitx5), typing with a CJK IME
makes the candidate window flicker**.

It is a plain pi extension — **no changes to pi's core, no patched bundles, and it keeps working
after `pi update`**.

> 中文: [README.zh.md](README.zh.md)

## Symptom

While pi is working or streaming text, composing Chinese makes the IME candidate window jump between
the **end of the terminal line** and the **input box** at ~25–30 Hz. Fullscreen mode
(`--tui-mode fullscreen`) does not have the problem.

## Cause (measured, not guessed)

pi's **regular (main-screen) mode** emits every frame as **three** `write()` calls:

```
write A: ESC[?2026h …content… ESC[?2026l     <- every line is padded to the full width,
write B: ESC[1B ESC[1G                           so the content write leaves the cursor at EOL
write C: ESC[?25l
```

The last two land **outside** the `ESC[?2026h…l` synchronized-output block. Konsole calls
`QGuiApplication::inputMethod()->update(Qt::ImCursorRectangle)` on every screen update
(`src/terminalDisplay/TerminalDisplay.cpp`, since 20.08, commit `d86b0547`, BUG 420799), so the input
method samples **two different cursor rectangles within a single frame**. Recording the rectangles
that fcitx5 receives (`org.fcitx.Fcitx.InputContext1.SetCursorRectV2`) gives:

```
x = 3768 (end of line)  <->  x = 8 (input box)     strict 1:1 alternation
76 calls in 3 seconds, p50 interval 39 ms
each pair: x=3768 first, then 12-53 ms later the real input-box position
```

The alt-screen (fullscreen) renderer does **not** have this problem: it appends the cursor
positioning and `?25l` to the frame's `BoundedTerminalWriter` *before* `END_SYNCHRONIZED_OUTPUT` and
issues a single `write()` per frame (`packages/tui/src/tui-alt-screen.ts`).

## What this extension does

It wraps `process.stdout.write` (every TUI write goes through it, including `hideCursor()`):

1. writes from the same `process.nextTick` turn are **batched**;
2. on flush, every `ESC[?2026l` is **moved to the end of the batch**.

Terminals then see the cursor parked at the editor at both block boundaries, the reported rectangle
stops changing, and the candidate window stays put.

Deliberate limits:

- only writes that contain `ESC[?2026h` (plus the rest of a frame already open) are batched; print/JSON
  mode, logs and other extensions' plain-text output pass **straight through**, order preserved;
- the wrapper is installed only when `ctx.mode === "tui"`;
- batching delays output by one `process.nextTick` (microseconds); a synchronous flush runs on
  `process.on("exit")`.

## Install

```bash
# 1. as a local pi package (written to ~/.pi/agent/settings.json)
pi install /path/to/pi-ime-cursor-batch

# 2. from git
pi install git:github.com/Ahrunda/pi-ime-cursor-batch

# 3. simplest: drop the file into the extensions directory
cp extensions/ime-cursor-batch.ts ~/.pi/agent/extensions/
```

Method 3 in one command: `./install.sh` (re-run it to re-sync).

Restart pi (or `/reload`). No configuration needed.

## Remove / disable

```bash
rm ~/.pi/agent/extensions/ime-cursor-batch.ts            # method 3
pi remove git:github.com/Ahrunda/pi-ime-cursor-batch    # method 1/2
```

Temporarily: `PI_IME_CURSOR_BATCH=0`.

## Verification (all actually measured)

`tools/count-writes-per-frame.py` reads an `strace` log and reports writes per frame plus whether the
cursor positioning stays inside the synchronized block. Measured against **unpatched pi 0.99.1**:

| Scenario | Result |
|---|---|
| extension only (`pi --no-extensions -e <ext>`) | **66 of 69 frames = 1 write/frame** |
| real session with all installed extensions | **69 of 73 frames = 1 write/frame**, no extension errors |
| streaming frame contents (26 samples) | **26/26** end with `?2026l`, **26/26** contain `?25l`, **26/26** position the cursor inside the block |
| `/quit` | `2026h/2026l` balanced, `?25h` and `?2004l` emitted |
| `pi -p` (print mode) | output unchanged (no wrapper is installed in that mode) |

Reproduce (runs pi for real, needs a configured model):

```bash
script -qec "strace -f -tt -e trace=write -s 8000 -o /tmp/pi.log pi" /dev/null
tools/count-writes-per-frame.py /tmp/pi.log
```

> Use `-s 8000`: the default `-s 32` truncates long writes, frames cannot be delimited, and results
> come out too optimistic — we made that mistake once.

## Caveats

- This is a **workaround at the stdout layer**, not the official fix. The renderer is where it should
  be fixed: see [`docs/upstream-fix.diff`](docs/upstream-fix.diff) and
  [`docs/diagnosis.md`](docs/diagnosis.md). **If upstream fixes it, remove this extension**
  (running both is safe — the wrapper is installed only once).
- Very large frames (>1 MiB) are flushed mid-frame, so their cursor bytes can still land outside the
  block. Only that kind of frame is affected.
- If another extension also wraps `process.stdout.write`, wrapping order decides who sees the data
  first. This extension installs on `session_start` and uses a `Symbol.for` guard on `globalThis` so
  it wraps exactly once.

## References

- Konsole: `src/terminalDisplay/TerminalDisplay.cpp` (notifies the input method on every output, since 20.08)
- fcitx5-qt: `qt6/platforminputcontext/qfcitxplatforminputcontext.cpp` (`RelativeRect` and
  `ClientSideInputPanel` capabilities, `SetCursorRectV2`)
- pi: `packages/tui/src/tui-main-screen.ts` (regular mode, the bug) and
  `packages/tui/src/tui-alt-screen.ts` (fullscreen mode, the correct pattern)

## License

MIT, see [LICENSE](LICENSE).
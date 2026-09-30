# Root-cause diagnosis and measurements

Environment: Arch Linux / KDE Plasma (Wayland) / Konsole 26.08.1 / fcitx5 5.1.23 / fcitx5-qt 5.1.16
/ pi 0.99.1 (regular TUI mode). `QT_IM_MODULE=fcitx` makes Konsole use the fcitx5-qt platform input
context instead of the Wayland text-input protocol.

> 中文: [diagnosis.md](diagnosis.md)

## 1. Symptom

While pi is streaming (or showing its spinner), composing Chinese makes the IME candidate window
oscillate between the **end of the terminal line** and the **input box**, ~25–30 times per second.
Plain typing (pi idle, one re-render per keystroke) flickers too. Fullscreen mode does not.

## 2. The chain

```
pi regular mode: 3 writes per frame
  content (every line padded to full width -> cursor ends up at EOL)
  move cursor back to the editor            <- both of these land OUTSIDE the
  ?25l                                        ESC[?2026h...l synchronized-output block
        |
Konsole: QGuiApplication::inputMethod()->update(Qt::ImCursorRectangle) on every screen output
        |
fcitx5-qt: cursorRectChanged() -> client-side candidate window updatePosition();
           SetCursorRectV2 whenever the rectangle changed
        |
fcitx5: two different cursor rectangles per frame -> the candidate window travels between them
```

## 3. Measurements

### 3.1 Terminal side: three writes per frame

Recording what pi writes to the terminal through a pty with
`strace -f -tt -e trace=write -s 8000` (see `../tools/count-writes-per-frame.py`), one streaming
frame of regular mode looks like:

```
write A: ESC[?2026h ESC[1A <CR> ESC[2K ...content... ESC[?2026l    (471 B)
write B: ESC[1B ESC[1G                                              (8 B)
write C: ESC[?25l                                                   (6 B)
```

Frame interval p50 = 80 ms on 0.87.1, and 26–35 ms on 0.99.1 (faster, so it flickers more often).
The same measurement in fullscreen mode shows **one write per frame**, with cursor positioning and
`?25l` *before* `?2026l`.

### 3.2 Input-method side: strict alternation

Recording the rectangles fcitx5 receives (rectangles only, no keystrokes):

```bash
dbus-monitor --session "type='method_call',member='SetCursorRectV2'" \
                       "type='method_call',member='SetCursorRect'"
```

Three seconds of streaming output:

```
76 SetCursorRectV2 calls; x values exactly 38x3768 + 38x8 (strict 1:1); p50 interval 39 ms
each pair: x=3768 (end of line) first, then 12-53 ms later the input-box position x=8/936...1192
y varies with scrolling; w=16 h=34 scale=2
```

The client is Konsole, on the portal path `/org/freedesktop/portal/inputcontext/N`, interface
`org.fcitx.Fcitx.InputContext1`.

> Easy to misread: `busctl --user call org.fcitx.Fcitx5 /controller org.fcitx.Fcitx.Controller1 CurrentUI`
> returns `classicui`, but that is only the **server-side** UI name. Konsole actually declares
> `FcitxCapabilityFlag_ClientSideInputPanel` (the client draws the candidate window) and
> `FcitxCapabilityFlag_RelativeRect` (on Wayland, hence `SetCursorRectV2` with a scale).

### 3.3 Terminal-side source

Konsole `src/terminalDisplay/TerminalDisplay.cpp` (since 20.08, commit `d86b0547`, BUG 420799):

```cpp
connect(_screenWindow.data(), &Konsole::ScreenWindow::outputChanged, this, []() {
    QGuiApplication::inputMethod()->update(Qt::ImCursorRectangle);
});
```

`Emulation::bufferedUpdate()` / `synchronizedUpdateChanged()` (`src/Emulation.cpp`) fire `showBulk()`
from 10/40 ms timers and at both `?2026h` / `?2026l` boundaries, i.e. several
`inputMethod()->update(ImCursorRectangle)` calls per frame; `TerminalDisplay::inputMethodQuery`
returns the terminal cursor position.

fcitx5-qt `qt6/platforminputcontext/qfcitxplatforminputcontext.cpp`: `update(ImCursorRectangle)` →
`cursorRectChanged()` → candidate window `updatePosition()`; `cursorRectangleWrapper()` queries
`QGuiApplication::inputMethod()->cursorRectangle()` directly.

## 4. Why an extension instead of patching the TUI class

pi bundles pi-tui **inline** into its own bundle, so an extension importing `@earendil-works/pi-tui`
gets a *different module instance* and cannot patch the class that is running. Every terminal write of
the TUI (33 call sites in the bundle, including `hideCursor()`) goes through `process.stdout.write` —
the only choke point an extension can reach, and exactly where the bug lives (the cursor move and
`?25l` are two *extra* writes).

## 5. The proper (upstream) fix

`packages/tui/src/tui-main-screen.ts`: append the cursor positioning and cursor visibility to the
frame's `BoundedTerminalWriter`, *before* `END_SYNCHRONIZED_OUTPUT`, and write once per frame — i.e.
mirror what `packages/tui/src/tui-alt-screen.ts:1731-1738` already does.

Patch: `upstream-fix.diff` (against `main` as of 2026-09-30; four call sites plus an optional `frame`
argument for `positionHardwareCursor`). The same change was implemented against the shipped bundle and
measured: **32/32** streaming frames with one write per frame and cursor positioning inside the block,
clean exit path.

## 6. Measurement notes (mistakes made here)

- A prompt must be submitted with `\r` (CR) in a pty; `\n` is only a newline in the editor.
- `strace -s` defaults to 32 and truncates long writes (`"..."..., N)`), which breaks frame
  delimiting and yields over-optimistic conclusions. Use `-s 8000`.
- `dbus-monitor` sees **every** client's rectangles, and Konsole's portal input context can be shared
  by several windows, so "did *this* window flicker" requires a controlled comparison (focused window,
  other sessions idle).
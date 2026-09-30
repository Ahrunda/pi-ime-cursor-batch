# 根因诊断与实测记录

环境：Arch Linux / KDE Plasma（Wayland）/ Konsole 26.08.1 / fcitx5 5.1.23 / fcitx5-qt 5.1.16
/ pi 0.99.1（普通模式）。`QT_IM_MODULE=fcitx` 会让 Konsole 使用 fcitx5-qt 平台输入法插件，
而不是 Wayland text-input 协议。

> English: [diagnosis.md](diagnosis.md)

## 1. 现象

pi 流式输出（或转圈）时输入中文，候选框在「终端行尾」和「输入框」之间来回跳，约 25–30 次/秒。
单纯打字（pi 空闲、每次按键触发一次重绘）也会跳。全屏模式不跳。

## 2. 链条

```
pi 普通模式：一帧 3 次 write
  正文（每行补空格补到整宽 → 光标停在行尾）
  光标移回输入框        ← 都在 ESC[?2026h…l 同步块之外
  ?25l
        ↓
Konsole：每次屏幕输出都 QGuiApplication::inputMethod()->update(Qt::ImCursorRectangle)
        ↓
fcitx5-qt：cursorRectChanged() → 客户端候选窗 updatePosition()；矩形变化时 SetCursorRectV2
        ↓
fcitx5：收到两个不同的光标矩形 → 候选框在两点间往返 = 闪烁
```

## 3. 实测证据

### 3.1 终端侧：每帧 3 次 write

用 pty + `strace -f -tt -e trace=write -s 8000` 记录 pi 往终端写的字节
（见 `../tools/count-writes-per-frame.py`）。普通模式流式输出时，帧（`?2026h` 到 `?2026l`）之间是：

```
write A: ESC[?2026h ESC[1A <CR> ESC[2K …正文… ESC[?2026l    (471B)
write B: ESC[1B ESC[1G                                      (8B)
write C: ESC[?25l                                           (6B)
```

帧间隔 p50 = 80 ms（0.87.1）→ 0.99.1 变成 p50 = 26–35 ms（更快，抖得更勤）。
全屏模式同一测量下：**每帧 1 次 write**，且光标定位与 `?25l` 都在 `?2026l` 之前。

### 3.2 输入法侧：矩形严格交替

监听 fcitx5 收到的光标矩形（只抓矩形，不抓按键）：

```bash
dbus-monitor --session "type='method_call',member='SetCursorRectV2'" \
                       "type='method_call',member='SetCursorRect'"
```

流式输出中 3 秒的原始数据：

```
76 次 SetCursorRectV2；x 取值 38×3768 + 38×8（严格 1:1）；相邻间隔 p50 = 39 ms
成对形式：x=3768（行尾）→ 12~53 ms 后 → x=8/936…1192（输入框）
y 随滚动变化；w=16 h=34 scale=2
```

客户端是 Konsole，路径 `/org/freedesktop/portal/inputcontext/N`（portal），接口
`org.fcitx.Fcitx.InputContext1`。

> 容易误判的一点：`busctl --user call org.fcitx.Fcitx5 /controller org.fcitx.Fcitx.Controller1 CurrentUI`
> 返回 `classicui`，但那只是**服务端** UI 名。Konsole 实际声明了
> `FcitxCapabilityFlag_ClientSideInputPanel`（候选框由客户端画）和
> `FcitxCapabilityFlag_RelativeRect`（Wayland 上 → 用 `SetCursorRectV2` + scale）。

### 3.3 终端侧源码

Konsole `src/terminalDisplay/TerminalDisplay.cpp`（20.08，commit `d86b0547`，BUG 420799）：

```cpp
connect(_screenWindow.data(), &Konsole::ScreenWindow::outputChanged, this, []() {
    QGuiApplication::inputMethod()->update(Qt::ImCursorRectangle);
});
```

`Emulation::bufferedUpdate()` / `synchronizedUpdateChanged()`（`src/Emulation.cpp`）会在
10ms/40ms 定时器与 `?2026h`/`?2026l` 两个边界上触发 `showBulk()`，也就是每帧若干次
`inputMethod()->update(ImCursorRectangle)`；`TerminalDisplay::inputMethodQuery(ImCursorRectangle)`
返回的正是终端光标位置。

fcitx5-qt `qt6/platforminputcontext/qfcitxplatforminputcontext.cpp`：`update(ImCursorRectangle)`
→ `cursorRectChanged()` → 候选窗 `updatePosition()`；`cursorRectangleWrapper()` 直接查
`QGuiApplication::inputMethod()->cursorRectangle()`。

## 4. 为什么用扩展而不是 patch TUI 类

pi 打包时把 pi-tui **内联**进了自己的 bundle，扩展 `import "@earendil-works/pi-tui"` 拿到的是
**另一份模块实例**，patch 不到正在跑的那个类。而 pi 的 TUI 所有终端输出（bundle 里 33 处调用点，
含 `hideCursor()`）都走 `process.stdout.write` —— 这是扩展唯一能收口的地方，也恰好是问题的关键
（光标定位与 `?25l` 是**两次额外的 write**）。

## 5. 正确的（上游）修法

`packages/tui/src/tui-main-screen.ts`：把光标定位与光标可见性写进本帧的
`BoundedTerminalWriter`、放在 `END_SYNCHRONIZED_OUTPUT` **之前**，整帧一次 `write()` ——
即照抄 `packages/tui/src/tui-alt-screen.ts:1731-1738` 已有的写法。

补丁：`upstream-fix.diff`（对 2026-09-30 的 `main` 分支，4 处调用点 + `positionHardwareCursor`
增加可选的 `frame` 参数）。该改法已在打包产物上按同一逻辑实现并实测：
流式 32 帧 **32/32** 满足「1 次 write + 光标定位在块内」，退出路径正常。

## 6. 测量方法备忘（踩过的坑）

- 用 pty 跑 pi 时必须发 `\r`（CR）才会提交；发 `\n` 只是编辑器换行。
- `strace -s` 默认 32，长写入会被截断成 `"…"..., N)`，帧无法切分 → 结论会偏乐观；用 `-s 8000`。
- `dbus-monitor` 抓到的是**所有**客户端的矩形，Konsole 的 portal 输入上下文可能被多个窗口共用，
  所以「某个窗口有没有抖」需要受控对比（前台窗口 + 其余会话空闲）。
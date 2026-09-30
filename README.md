# pi-ime-cursor-batch

修一个具体的毛病：**pi 在 Konsole(+fcitx5) 里流式输出时，用中文输入会让候选框不断闪**。

纯 pi 扩展实现——**不改 pi 核心、不改打包产物、pi 升级后依然有效**。

> English: [README.en.md](README.en.md)

## 症状

pi 一边输出（转圈/流式吐字）一边输入中文时，输入法候选框在**终端行尾**和**输入框**之间来回跳，
~25–30 次/秒，选词几乎是靠猜。全屏模式（`--tui-mode fullscreen`）没有这个问题。

## 原因（实测，不是推测）

pi 的**普通（main-screen）模式**一帧分 **3 次** `write()`：

```
write A: ESC[?2026h …正文… ESC[?2026l     ← 每行都补空格补到终端整宽，写完光标停在「行尾」
write B: ESC[1B ESC[1G                     ← 另起一次 write，把光标移回输入框
write C: ESC[?25l
```

后两次落在 `ESC[?2026h…l`（同步输出块）**之外**。而 Konsole 每次屏幕有输出都会执行
`QGuiApplication::inputMethod()->update(Qt::ImCursorRectangle)`
（`src/terminalDisplay/TerminalDisplay.cpp`，20.08 起，commit `d86b0547` / BUG 420799），
于是输入法在**同一帧里取到两个不同的光标位置**。监听 fcitx5 侧收到的矩形
（`org.fcitx.Fcitx.InputContext1.SetCursorRectV2`）得到的原始数据：

```
x = 3768（行尾） ↔ x = 8（输入框）   严格 1:1 交替
3 秒内 76 次，相邻间隔 p50 = 39 ms
成对形式：先 x=3768 → 12~53 ms 后 → x=输入框位置
```

alt-screen（全屏）渲染器**没有**这个问题：它把光标定位和 `?25l` 追加进本帧的
`BoundedTerminalWriter`、放在 `END_SYNCHRONIZED_OUTPUT` **之前**，整帧只 `write()` 一次
（`packages/tui/src/tui-alt-screen.ts`）。

## 这个扩展做什么

包住 `process.stdout.write`（pi 的 TUI 所有终端输出都走它，包括 `hideCursor()`）：

1. 把同一个 `process.nextTick` 窗口内的写入**攒成一批**；
2. flush 时把 `ESC[?2026l` **挪到这批的最后**。

于是终端在同步块的两个边界上看到的都是「停在输入框」的位置 → 矩形不再变化 → 候选框不动。

几个刻意的限制：

- 只对**含 `ESC[?2026h` 的写入**（以及已经开了帧的后续写入）生效；print/JSON 模式、日志、
  其它扩展的输出都是纯文本，**直接透传**，顺序不变；
- 只在 `ctx.mode === "tui"` 时安装；
- 攒批只延迟一个 `process.nextTick`（微秒级）；退出前在 `process.on("exit")` 里同步 flush。

## 安装

```bash
# 方式 1：作为本地包（会写进 ~/.pi/agent/settings.json）
pi install /path/to/pi-ime-cursor-batch

# 方式 2：从 git 装
pi install git:github.com/Ahrunda/pi-ime-cursor-batch

# 方式 3：最省事，直接把文件放进扩展目录
cp extensions/ime-cursor-batch.ts ~/.pi/agent/extensions/
```

装完**重开 pi**（或 `/reload`）即可，不需要任何配置。

## 撤销 / 关闭

```bash
rm ~/.pi/agent/extensions/ime-cursor-batch.ts   # 方式 3 的撤销
pi remove git:github.com/Ahrunda/pi-ime-cursor-batch  # 方式 1/2 的撤销
```

临时关闭（不卸载）：环境变量 `PI_IME_CURSOR_BATCH=0`。

## 验证（都是真实跑出来的）

`tools/count-writes-per-frame.py` 从 `strace` 日志里统计「每帧几次 write」以及
「光标定位是否落在同步块内」。在**未打补丁的 pi 0.99.1** 上：

| 场景 | 结果 |
|---|---|
| 只有扩展（`pi --no-extensions -e <扩展>`） | 69 帧里 **66 帧 = 1 次 write/帧** |
| 加载全部已装扩展的真实会话 | 73 帧里 **69 帧 = 1 次 write/帧**，无扩展报错 |
| 流式帧内容（26 个样本） | **26/26** 以 `?2026l` 结尾、**26/26** 含 `?25l`、**26/26** 光标定位在块内 |
| `/quit` 退出 | `2026h/2026l` 配对，`?25h`、`?2004l` 正常发出 |
| `pi -p`（print 模式） | 输出正常（该模式下不安装 wrapper） |

复现步骤（会真的跑一次 pi，需要已配置好的模型）：

```bash
script -qec "strace -f -tt -e trace=write -s 8000 -o /tmp/pi.log pi" /dev/null
tools/count-writes-per-frame.py /tmp/pi.log
```

> 注意 `-s 8000`：默认的 `-s 32` 会截断长写入，帧无法正确切分（这个坑我们用错过一次，
> 得出了偏乐观的结论）。

## 边界（说实话）

- 这是 **stdout 层的绕行**，不是官方修法。真正该改的是渲染器，见
  [`docs/upstream-fix.diff`](docs/upstream-fix.diff) 与 [`docs/diagnosis.md`](docs/diagnosis.md)。
  **上游若修好，请卸载本扩展**（两者同时用是安全的，本扩展只会包一次）。
- 极端大帧（>1 MiB）会中途 flush，此时光标序列仍可能落在块外——只影响那一种帧。
- 如果别的扩展也包 `process.stdout.write`，包装顺序决定谁先看到数据；本扩展在
  `session_start` 安装，并用 `globalThis` 上的 `Symbol.for` 保证只包一次。

## 参考

- Konsole：`src/terminalDisplay/TerminalDisplay.cpp`（每次输出都通知输入法，20.08 起）
- fcitx5-qt：`qt6/platforminputcontext/qfcitxplatforminputcontext.cpp`（`RelativeRect`、
  `ClientSideInputPanel` 能力位与 `SetCursorRectV2`）
- pi：`packages/tui/src/tui-main-screen.ts`（普通模式，问题所在）与
  `packages/tui/src/tui-alt-screen.ts`（全屏模式，正确写法）

## 许可

MIT，见 [LICENSE](LICENSE)。
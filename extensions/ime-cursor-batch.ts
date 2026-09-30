/**
 * ime-cursor-batch — stop IME candidate-window flicker in pi's main-screen TUI.
 *
 * Symptom (Konsole + fcitx5 on Wayland/KDE): while pi streams output, typing with a CJK IME
 * makes the candidate window jump between the end of the terminal line and the input box
 * (measured: x=8 -> x=3768, strict 1:1 alternation, ~25-30 Hz).
 *
 * Cause (measured): in regular (main-screen) mode pi emits each frame as three writes —
 * content, then the hardware-cursor move back to the editor, then `ESC[?25l` — and the last two
 * are written *outside* the `ESC[?2026h ... ESC[?2026l` synchronized-output block. Every rendered
 * line is padded to the full terminal width, so the content write leaves the cursor at the *end of
 * the line*, far away from the editor. Konsole calls
 * `QGuiApplication::inputMethod()->update(Qt::ImCursorRectangle)` on every screen update, so the
 * input method samples two different cursor rectangles per frame and moves the candidate window to
 * each of them. The alt-screen (fullscreen) renderer does not have this problem: it appends cursor
 * positioning and `?25l` to the frame buffer before closing the block, and writes once.
 *
 * What this extension does: wrap `process.stdout.write` (every TUI write goes through it, including
 * `hideCursor()`), batch the writes of one event-loop turn, and move every `ESC[?2026l` to the end of
 * the batch. Terminals then see the cursor parked at the editor at both block boundaries, so the
 * reported rectangle stops changing.
 *
 * Why not patch the TUI class instead: pi bundles pi-tui into its own bundle at build time, so an
 * extension `import`ing `@earendil-works/pi-tui` gets a different module instance than the one that
 * is running. `process.stdout.write` is the only choke point that an extension can actually reach.
 *
 * Details, measurements and the upstream fix: see README.md (English) / README.zh.md (中文) and docs/.
 *
 * Set `PI_IME_CURSOR_BATCH=0` to disable without uninstalling.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

type WriteFn = typeof process.stdout.write;

interface BatchState {
	original: WriteFn;
	pending: string;
	scheduled: boolean;
	callbacks: Array<() => void>;
}

// `ctx.reload()` re-imports extensions; a process-wide state key keeps the wrapper installed once.
const STATE_KEY = Symbol.for("pi.ime-cursor-batch.state");
const globalStore = globalThis as unknown as Record<symbol, BatchState | undefined>;

function flush(state: BatchState): void {
	state.scheduled = false;
	const pending = state.pending;
	state.pending = "";
	if (pending) {
		// Move the synchronized-output terminator to the end of the batch, so the cursor positioning
		// and `?25l` of this frame end up *inside* the block.
		const parts = pending.split(SYNC_END);
		const out = parts.length > 1 ? parts.join("") + SYNC_END.repeat(parts.length - 1) : pending;
		state.original.call(process.stdout, out);
	}
	const callbacks = state.callbacks;
	state.callbacks = [];
	for (const callback of callbacks) {
		callback();
	}
}

function install(): void {
	if (globalStore[STATE_KEY] || process.env.PI_IME_CURSOR_BATCH === "0") {
		return;
	}
	const state: BatchState = {
		original: process.stdout.write.bind(process.stdout) as WriteFn,
		pending: "",
		scheduled: false,
		callbacks: [],
	};
	globalStore[STATE_KEY] = state;

	const original = state.original;
	const patched = function (this: unknown, chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
		const enc = typeof encoding === "function" ? undefined : encoding;
		const cb = (typeof encoding === "function" ? encoding : callback) as (() => void) | undefined;

		const buffering = state.pending.length > 0;
		const startsFrame = typeof chunk === "string" && chunk.includes(SYNC_BEGIN);

		if (typeof chunk !== "string" || (!buffering && !startsFrame)) {
			// Not TUI frame data (print/JSON mode, logs, extension output, Buffer chunks): keep the
			// original order and write it straight out.
			flush(state);
			return original.call(process.stdout, chunk, enc, cb);
		}

		state.pending += chunk;
		if (cb) {
			state.callbacks.push(cb);
		}
		if (!state.scheduled) {
			state.scheduled = true;
			process.nextTick(() => flush(state));
		}
		return true;
	};

	process.stdout.write = patched as unknown as WriteFn;
	// `process.exit()` does not wait for `nextTick`, so flush synchronously on the way out.
	process.on("exit", () => flush(state));
}

export default function imeCursorBatch(pi: ExtensionAPI): void {
	// Only interactive TUI sessions have frames to batch (`ctx.mode === "tui"`, see docs/extensions.md).
	// `session_start` fires long before any streaming output.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		install();
	});
	pi.on("session_shutdown", () => {
		const state = globalStore[STATE_KEY];
		if (state) {
			flush(state);
		}
	});
}
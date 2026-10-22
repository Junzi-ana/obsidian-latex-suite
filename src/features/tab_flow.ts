import { EditorView } from "@codemirror/view";
import { getContextPlugin } from "src/utils/context";
import { setCursor } from "src/utils/editor_utils";
import { SPACES } from "./scan";
import { tabout } from "./tabout";

/** Closing brackets: jumping backwards lands right before them. */
const CLOSERS = new Set([")", "]", "}"]);

/** Opening brackets: jumping backwards lands right after them. */
const OPENERS = new Set(["(", "[", "{"]);

/** `\right)` is one unit, so land before the command and not between the two. */
const RIGHT_COMMANDS = ["\\right", "\\bigr", "\\Bigr", "\\biggr", "\\Biggr"]
	.sort((a, b) => b.length - a.length);

const DIFFERENTIAL = "\\mathrm{d}";

/** Longest first, so `\qquad` wins over `\quad`. */
const SPACING = [...SPACES].sort((a, b) => b.length - a.length);

/**
 * Step back over spaces and spacing commands, e.g. the `\;` in front of
 * `\mathrm{d}`.
 */
const skipSpacingBack = (text: string, pos: number): number => {
	let p = pos;
	for (;;) {
		while (p > 0 && text[p - 1] === " ") p--;

		const command = SPACING.find((token) => p >= token.length && text.startsWith(token, p - token.length));
		if (command === undefined) return p;

		p -= command.length;
	}
};

/** Where Shift-Tab should land in `text`, or null when there is nothing to jump to. */
const findAnchor = (text: string): number | null => {
	for (let i = text.length - 1; i >= 0; i--) {
		// The differential is one unit, and its spacing belongs to it.
		if (
			text[i] === "}"
			&& i + 1 >= DIFFERENTIAL.length
			&& text.startsWith(DIFFERENTIAL, i + 1 - DIFFERENTIAL.length)
		) {
			return skipSpacingBack(text, i + 1 - DIFFERENTIAL.length);
		}

		if (CLOSERS.has(text[i])) {
			const command = RIGHT_COMMANDS.find((token) => i >= token.length && text.startsWith(token, i - token.length));
			return command === undefined ? i : i - command.length;
		}

		if (OPENERS.has(text[i])) return i + 1;
	}

	return null;
};

/**
 * The last thing Tab tries inside math. Rather than falling through to the
 * editor's indent, go to the end of the line, and from there leave the
 * equation.
 */
export const tabForwardFallback = (view: EditorView): boolean => {
	const ctx = getContextPlugin(view);
	if (!ctx.mode.inMath()) return false;

	const bounds = ctx.getBounds();
	if (!bounds) return false;

	const doc = view.state.doc;
	const line = doc.lineAt(ctx.pos);

	let end = Math.min(line.to, bounds.inner_end);
	while (end > line.from && /\s/.test(doc.sliceString(end - 1, end))) end--;

	if (ctx.pos < end) {
		setCursor(view, end);
		return true;
	}

	if (tabout(view, ctx)) return true;

	// A multiline equation that does not end here: step to the next line.
	if (line.number < doc.lines) {
		setCursor(view, doc.line(line.number + 1).from);
	}

	return true;
};

/**
 * Shift-Tab inside math: jump back to the nearest structural anchor, i.e. the
 * spot just before a closing bracket, just after an opening bracket, or right
 * before the differential.
 */
export const tabBackwardJump = (view: EditorView): boolean => {
	const ctx = getContextPlugin(view);
	if (!ctx.mode.inMath()) return false;

	const bounds = ctx.getBounds();
	if (!bounds) return false;

	const text = view.state.doc.sliceString(bounds.inner_start, ctx.pos);
	const target = findAnchor(text);
	if (target !== null) setCursor(view, bounds.inner_start + target);

	return true;
};

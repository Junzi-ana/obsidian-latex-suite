import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/*
 * Cycle the size of the *outermost* balanced pair of round parentheses inside
 * the current selection(s).
 *
 * Semantics (all lengths are in UTF-16 code units of the selected text):
 *
 * 1. Only the first "outermost" group is touched. Scanning the selection from
 *    left to right, a group is a `(` ... `)` pair such that the `(` is not
 *    itself inside another pair contained in the selection, e.g. for the
 *    selection `(a)+((b))` only `(a)` is resized. Text outside the group but
 *    inside the selection (like the `^2` in `(f(x)+\frac12)^2`) is left alone.
 *
 * 2. If the selection contains unbalanced parentheses (a `)` without an
 *    opener before the group, or the outermost group never closes inside the
 *    selection), nothing is done: the key falls through to normal handling.
 *    This is the "just don't act" option - deterministic and safe.
 *
 * 3. Sizes cycle through the levels below, smallest to largest. The
 *    auto-sized `\left( ... \right)` form is treated as the top of the wheel:
 *    cycling a plain pair grows it `\big`, `\Big`, `\bigg`, `\Bigg`, then
 *    `\left`/`\right`; cycling a `\left(...\right)` pair shrinks it back to
 *    plain parentheses. `\bigl`/`\bigr` and friends are recognized as input
 *    but are normalized to the canonical (non-`l`/`r`) spellings above.
 *
 * After a successful cycle the selection is set to the resized pair (not the
 * original, possibly larger selection), so pressing the key again keeps
 * growing/shrinking the same group.
 */

const DELIMITER_SIZES: ReadonlyArray<{ readonly open: string; readonly close: string }> = [
	{ open: "(", close: ")" },
	{ open: "\\big(", close: "\\big)" },
	{ open: "\\Big(", close: "\\Big)" },
	{ open: "\\bigg(", close: "\\bigg)" },
	{ open: "\\Bigg(", close: "\\Bigg)" },
	{ open: "\\left(", close: "\\right)" },
];

const LEVEL_LEFT = DELIMITER_SIZES.length - 1;

/**
 * The (unmodified) key that cycles the bracket size when text is selected.
 * Pressing this key is only intercepted when a selection is active and an
 * outermost `(...)` group can actually be resized; otherwise the key falls
 * through to normal snippet / typing behaviour. Change this to remap.
 */
export const RESIZE_BRACKETS_KEY = "B";

// Matches a delimiter sizing command that ends exactly before the paren.
const OPEN_COMMAND_RE = /\\(left|big[lr]?|Big[lr]?|bigg[lr]?|Bigg[lr]?)$/;
const CLOSE_COMMAND_RE = /\\(right|big[lr]?|Big[lr]?|bigg[lr]?|Bigg[lr]?)$/;

function commandLevel(command: string): number {
	// `\bigl`/`\Bigr`/... map onto the same levels as `\big`/`\Big`/...
	// (the trailing l/r sits inside the capture group of the regex above;
	// "left"/"right" end in "t" so they are unaffected by the strip).
	const name = command.replace(/[lr]$/, "");
	switch (name) {
		case "left":
		case "right":
			return LEVEL_LEFT;
		case "big":
			return 1;
		case "Big":
			return 2;
		case "bigg":
			return 3;
		case "Bigg":
			return 4;
		default:
			return 0;
	}
}

export type ParenGroup = { open: number; close: number };

/**
 * Find the first outermost balanced `(...)` pair that lies completely inside
 * `text`. Returns `null` when there is no such group: unbalanced input (a
 * stray `)` before the first candidate opener, or an opener that never closes
 * inside `text`) also yields `null` so the caller simply does nothing.
 */
export function findOutermostParenGroup(text: string): ParenGroup | null {
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === ")") {
			// A closing paren with no opener before it inside this selection.
			return null;
		}
		if (ch === "(") {
			// First opener at nesting depth 0 -> candidate outermost group.
			// Find the paren that balances it, counting nested parens.
			let depth = 1;
			for (let j = i + 1; j < text.length; j++) {
				const c = text[j];
				if (c === "(") depth++;
				else if (c === ")") depth--;
				if (depth === 0) return { open: i, close: j };
			}
			// The outermost opener never closes inside the selection.
			return null;
		}
	}
	return null;
}

type ResizeResult = {
	newText: string;
	// offsets of the resized group inside newText
	relStart: number;
	relEnd: number;
};

/**
 * Compute the replacement for `text` (one selection range's content), given
 * the position of the group inside it. `open`/`close` are the paren indexes
 * inside `text`; each side may be preceded by a sizing command such as
 * `\left` / `\big` / `\bigl`, which is replaced together with its paren.
 */
function computeResize(text: string, group: ParenGroup): ResizeResult {
	const openMatch = OPEN_COMMAND_RE.exec(text.slice(0, group.open));
	const openCmd = openMatch ? openMatch[0] : "";
	const openStart = group.open - openCmd.length;
	const openLevel = openMatch ? commandLevel(openMatch[1]) : 0;

	const closeMatch = CLOSE_COMMAND_RE.exec(text.slice(0, group.close));
	const closeCmd = closeMatch ? closeMatch[0] : "";
	const closeStart = group.close - closeCmd.length;

	const target = DELIMITER_SIZES[(openLevel + 1) % DELIMITER_SIZES.length];

	const newText =
		text.slice(0, openStart) +
		target.open +
		text.slice(group.open + 1, closeStart) +
		target.close +
		text.slice(group.close + 1);

	const relStart = openStart;
	const relEnd =
		openStart +
		target.open.length +
		(closeStart - (group.open + 1)) +
		target.close.length;

	return { newText, relStart, relEnd };
}

/**
 * True when pressing the resize key on the current selection would do
 * something (used to enable/disable the command palette entry).
 */
export function canCycleOuterBracketSize(view: EditorView): boolean {
	for (const range of view.state.selection.ranges) {
		if (range.empty) continue;
		const text = view.state.sliceDoc(range.from, range.to);
		if (findOutermostParenGroup(text) !== null) return true;
	}
	return false;
}

/**
 * Cycle the size of the outermost paren group of every non-empty selection
 * range. Returns true when at least one range was modified (the caller should
 * consume the key press); false when there is nothing to resize (the caller
 * should let normal typing / snippet handling proceed).
 */
export function cycleOuterBracketSize(view: EditorView): boolean {
	const state = view.state;
	const ranges = state.selection.ranges;

	const changes: { from: number; to: number; insert: string }[] = [];
	const newRanges: { from: number; to: number }[] = [];
	let changed = false;
	// Offset accumulated by the replacements of earlier (more to the left)
	// ranges; the selection below is expressed against the *new* document.
	let delta = 0;

	for (const range of ranges) {
		if (range.empty) {
			newRanges.push({ from: range.from + delta, to: range.to + delta });
			continue;
		}
		const text = state.sliceDoc(range.from, range.to);
		const group = findOutermostParenGroup(text);
		if (group === null) {
			newRanges.push({ from: range.from + delta, to: range.to + delta });
			continue;
		}
		const result = computeResize(text, group);
		changes.push({ from: range.from, to: range.to, insert: result.newText });
		newRanges.push({
			from: range.from + delta + result.relStart,
			to: range.from + delta + result.relEnd,
		});
		delta += result.newText.length - (range.to - range.from);
		changed = true;
	}

	if (!changed) return false;

	const selectionRanges = newRanges.map(({ from, to }) =>
		EditorSelection.range(from, to)
	);

	view.dispatch({
		changes,
		selection: EditorSelection.create(selectionRanges, state.selection.mainIndex),
		userEvent: "input.type",
		scrollIntoView: true,
	});
	return true;
}

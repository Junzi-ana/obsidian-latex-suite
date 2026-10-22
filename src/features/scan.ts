import type { DelimiterPair } from "src/settings/settings";

export type TokenKind = "op" | "cut" | "sp" | "int";

/**
 * The vocabulary shared by every backwards scan: which tokens are operators
 * (the region keeps growing across them), boundaries (it stops at them) and
 * which bracket pairs are treated as one indivisible unit.
 */
export interface ScanConfig {
	/** Bracket pairs from the settings, e.g. `("(", ")")`. */
	pairs: DelimiterPair[];
	/** Operators from the settings. */
	operators: string[];
	/** Boundaries from the settings. */
	boundaries: string[];
}

/** A slice of the equation. */
export interface Wrapper {
	start: number;
	end: number;
}

/** Spacing commands are stepped over without affecting the scan. */
export const SPACES = ["\\,", "\\;", "\\:", "\\!", "\\quad", "\\qquad", "\\enspace", "\\thinspace"];

/** Integral signs are never crossed. */
const INTEGRALS = ["\\int", "\\iint", "\\iiint", "\\oint"];

/** Braces always pair up, whatever delimiters are configured. */
const FIXED_PAIRS: DelimiterPair[] = [["{", "}"]];

/** Characters that end a fraction numerator, whatever the settings say. */
const HARD_STOPS = ["$", "\n", "\t"];

const DIFFERENTIAL = "\\mathrm{d}";

interface Vocab {
	kind: Map<string, TokenKind>;
	commands: string[];
	open: Map<string, string>;
	close: Map<string, string>;
}

const buildVocab = (config: ScanConfig): Vocab => {
	const kind = new Map<string, TokenKind>();
	for (const token of config.boundaries) kind.set(token, "cut");
	for (const token of SPACES) kind.set(token, "sp");
	for (const token of INTEGRALS) kind.set(token, "int");
	for (const token of config.operators) if (!kind.has(token)) kind.set(token, "op");

	const commands = [...kind.keys()]
		.filter((token) => token.length > 1)
		.sort((a, b) => b.length - a.length);

	const open = new Map<string, string>();
	const close = new Map<string, string>();
	for (const [openBracket, closeBracket] of [...FIXED_PAIRS, ...config.pairs]) {
		if (!openBracket || !closeBracket) continue;
		open.set(openBracket, closeBracket);
		close.set(closeBracket, openBracket);
	}

	return { kind, commands, open, close };
};

/** Whether `command` sits at `start`, not glued to another letter: \in vs \int. */
const matchesCommand = (text: string, start: number, command: string): boolean =>
	text.startsWith(command, start)
	&& (!/[A-Za-z]$/.test(command) || !/[A-Za-z]/.test(text[start + command.length] ?? ""));

/** The token that ends exactly at index `i`, or null. */
const tokenAt = (text: string, i: number, vocab: Vocab): string | null => {
	const char = text[i];
	if (char === undefined) return null;
	if (vocab.kind.has(char)) return char;

	for (const command of vocab.commands) {
		// startsWith() of a negative index would silently compare at 0.
		if (i + 1 < command.length) continue;
		if (matchesCommand(text, i + 1 - command.length, command)) return command;
	}

	return null;
};

/** `\mathrm{d}` followed by an integration variable, ending at index `i`. */
const isDifferentialAt = (text: string, i: number): boolean => {
	const start = i + 1 - DIFFERENTIAL.length;
	if (start < 0 || text.slice(start, i + 1) !== DIFFERENTIAL) return false;

	let p = i + 1;
	while (text[p] === " ") p++;
	return p < text.length && /[A-Za-z\\]/.test(text[p]);
};

/** Step over `_`/`^` scripts of an integral sign, landing on the integrand. */
const skipScripts = (text: string, p: number): number => {
	for (;;) {
		if (text[p] === " ") {
			p++;
			continue;
		}

		if (text[p] === "_" || text[p] === "^") {
			p++;
			if (text[p] === "{") {
				let depth = 0;
				do {
					if (text[p] === "{") depth++;
					else if (text[p] === "}") depth--;
					p++;
				} while (p < text.length && depth > 0);
			} else {
				p++;
			}
			continue;
		}

		if (text.startsWith("\\limits", p)) {
			p += "\\limits".length;
			continue;
		}

		return p;
	}
};

interface ControlTokens {
	control: string | null;
	repeat: number;
	/** Index just past the last character that is not part of the control tokens. */
	end: number;
}

/** Peel `k` dots or `k` repetitions of one operator off the end of `text`. */
const peelControlTokens = (text: string, vocab: Vocab): ControlTokens => {
	let control: string | null = null;
	let repeat = 0;
	let end = text.length;

	if (text[end - 1] === "." && text[end - 2] !== "\\") {
		control = ".";
		while (text[end - 1] === ".") {
			end--;
			repeat++;
		}
		return { control, repeat, end };
	}

	let token: string | null;
	while ((token = tokenAt(text, end - 1, vocab)) && vocab.kind.get(token) === "op" && (control === null || token === control)) {
		control = token;
		end -= token.length;
		repeat++;
	}
	return { control, repeat, end };
};

/** The innermost opening bracket that has no closing bracket yet, or null. */
const innermostUnclosed = (text: string, end: number, vocab: Vocab): string | null => {
	let depth = 0;
	for (let i = end - 1; i >= 0; i--) {
		if (vocab.close.has(text[i])) {
			depth++;
		} else if (vocab.open.has(text[i])) {
			if (depth === 0) return text[i];
			depth--;
		}
	}
	return null;
};

/**
 * The part of `text` to wrap in brackets, or null when the typed closing
 * bracket should be left alone.
 *
 * @param text everything from the start of the equation up to the cursor
 * @param pair the delimiter pair being closed
 */
export const findWrapper = (text: string, pair: DelimiterPair, config: ScanConfig): Wrapper | null => {
	const vocab = buildVocab(config);

	// 1) Trailing control tokens: k dots, or k repetitions of one operator.
	const { control, repeat, end } = peelControlTokens(text, vocab);

	// 2) The typed bracket already belongs to an opening bracket of its own kind.
	if (innermostUnclosed(text, end, vocab) === pair[0]) return null;

	// 3) Backwards scan. Balanced brackets and differentials are stepped over as a whole.
	let depth = 0;
	let pending = 0; // a \mathrm{d}x still waiting for its integral sign
	let pendingCut = -1; // boundary met while waiting, used if the integral never shows up
	let passing = false;
	let matched = 0;

	let start = 0;
	scan: for (let i = end - 1; i >= 0; i--) {
		if (isDifferentialAt(text, i)) {
			pending++;
			i -= DIFFERENTIAL.length - 1;
			continue;
		}

		const bracket = text[i];
		if (vocab.close.has(bracket)) {
			depth++;
			continue;
		}
		if (vocab.open.has(bracket)) {
			if (depth > 0) {
				depth--;
				continue;
			}
			if (bracket === pair[0]) return null;
			start = i + 1;
			break scan;
		}

		const token = tokenAt(text, i, vocab);
		if (token === null) continue;

		const kind = vocab.kind.get(token);

		if (kind === "int") {
			if (pending > 0) {
				pending--;
			} else {
				// Wrap the integrand only, never the integral sign itself.
				start = skipScripts(text, i + 1);
				break scan;
			}
		} else if (kind === "sp") {
			// spacing carries no meaning for the scan
		} else if (pending > 0) {
			if (kind === "cut") pendingCut = i + 1;
		} else if (passing || kind === "cut") {
			start = i + 1;
			break scan;
		} else if (control === ".") {
			if (++matched === repeat) {
				start = i + 1;
				break scan;
			}
		} else if (token === control && ++matched === repeat) {
			passing = true;
		}

		i -= token.length - 1;
	}

	if (start === 0 && pendingCut > 0) start = pendingCut;

	while (start < end && /\s/.test(text[start])) start++;

	return { start, end };
};

/**
 * The numerator of a fraction typed with auto-fraction, or null when there is
 * nothing to take.
 *
 * Without control tokens one term is taken. `k` dots take `k` terms, and `k`
 * repetitions of one operator take `k + 1` terms, i.e. `k` joins.
 *
 * @param text everything from the start of the equation up to the cursor
 */
export const findNumerator = (text: string, config: ScanConfig): Wrapper | null => {
	const vocab = buildVocab(config);
	const { control, repeat, end } = peelControlTokens(text, vocab);

	const terms = control === null ? 1 : control === "." ? repeat : repeat + 1;

	let depth = 0;
	let pending = 0; // a \mathrm{d}x still waiting for its integral sign
	let operators = 0;

	let start = 0;
	scan: for (let i = end - 1; i >= 0; i--) {
		if (HARD_STOPS.includes(text[i])) {
			start = i + 1;
			break scan;
		}

		if (isDifferentialAt(text, i)) {
			pending++;
			i -= DIFFERENTIAL.length - 1;
			continue;
		}

		const bracket = text[i];
		if (vocab.close.has(bracket)) {
			depth++;
			continue;
		}
		if (vocab.open.has(bracket)) {
			if (depth > 0) {
				depth--;
				continue;
			}
			start = i + 1;
			break scan;
		}

		const token = tokenAt(text, i, vocab);
		if (token === null) continue;

		const kind = vocab.kind.get(token);

		if (kind === "sp") {
			// spacing carries no meaning for the scan
		} else if (kind === "int") {
			if (pending > 0) {
				pending--;
			} else {
				// Keep the whole integral, it is one term.
				start = i + 1 - token.length;
				break scan;
			}
		} else if (pending > 0) {
			// inside an integral: its operators belong to the same term
		} else if (kind === "cut") {
			start = i + 1;
			break scan;
		} else if (kind === "op") {
			if (++operators >= terms) {
				start = i + 1;
				break scan;
			}
		}

		i -= token.length - 1;
	}

	while (start < end && /\s/.test(text[start])) start++;
	if (start >= end) return null;

	return { start, end };
};

/** The token that starts at index `i`, or null. */
const tokenStartingAt = (text: string, i: number, vocab: Vocab): string | null => {
	const char = text[i];
	if (vocab.kind.has(char)) return char;

	for (const command of vocab.commands) {
		if (matchesCommand(text, i, command)) return command;
	}

	return null;
};

/** Index of the bracket closing the one at `start`, or null when it never closes. */
const matchBracketForward = (text: string, start: number, vocab: Vocab): number | null => {
	const open = text[start];
	const close = vocab.open.get(open);
	if (close === undefined) return null;

	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close && --depth === 0) return i;
	}
	return null;
};

/** If a differential `\mathrm{d}<variable>` starts at `i`, the index just past it. */
const differentialEndAt = (text: string, i: number): number | null => {
	if (!text.startsWith(DIFFERENTIAL, i)) return null;

	let p = i + DIFFERENTIAL.length;
	while (text[p] === " ") p++;
	if (p >= text.length) return null;
	if (/[A-Za-z]/.test(text[p])) return p + 1;

	const command = /^\\[A-Za-z]+/.exec(text.slice(p));
	return command === null ? null : p + command[0].length;
};

export interface ClosingPlacement {
	/** Index in the text before the cursor where the control tokens start. */
	controlStart: number;
	/** Index in the text after the cursor where the closing bracket belongs. */
	insertAt: number;
}

/**
 * Where the closing bracket of `pair` belongs when the close trigger is pressed,
 * or null when the cursor is not inside an unclosed bracket of that kind.
 *
 * @param before the equation text from its start up to the cursor
 * @param after the equation text from the cursor to its end
 */
export const findClosingBracket = (before: string, after: string, pair: DelimiterPair, config: ScanConfig): ClosingPlacement | null => {
	const vocab = buildVocab(config);
	const { control, repeat, end } = peelControlTokens(before, vocab);

	// Only close a bracket that is still open and of the kind being closed.
	if (innermostUnclosed(before, end, vocab) !== pair[0]) return null;

	// Without control tokens one operator is included, which means two terms.
	const terms = control === null ? 2 : control === "." ? repeat : 0;

	const place = (insertAt: number): ClosingPlacement => {
		// Never leave a dangling operator inside the brackets, e.g. (a+)|+b.
		while (insertAt > 0) {
			const previous = tokenAt(after, insertAt - 1, vocab);
			if (previous === null || vocab.kind.get(previous) !== "op") break;
			insertAt -= previous.length;
		}
		return { controlStart: end, insertAt };
	};

	let inIntegral = false;
	let operators = 0;
	let matched = 0;
	let passing = false;

	for (let i = 0; i < after.length;) {
		const differentialEnd = differentialEndAt(after, i);
		if (differentialEnd !== null) {
			inIntegral = false;
			i = differentialEnd;
			continue;
		}

		const char = after[i];
		if (vocab.open.has(char)) {
			const closeIndex = matchBracketForward(after, i, vocab);
			if (closeIndex === null) return place(i);
			i = closeIndex + 1;
			continue;
		}
		if (vocab.close.has(char)) {
			// The bracket is already closed: leave the key to tabout.
			if (char === pair[1]) return null;
			return place(i);
		}

		const token = tokenStartingAt(after, i, vocab);
		if (token === null) {
			i++;
			continue;
		}

		const kind = vocab.kind.get(token);

		if (kind === "sp") {
			i += token.length;
			continue;
		}
		if (passing || kind === "cut") return place(i);

		if (kind === "int") {
			// Everything up to the differential belongs to the integral and is one term.
			inIntegral = true;
			i += token.length;
			continue;
		}

		if (kind === "op" && !inIntegral) {
			if (terms > 0) {
				if (++operators >= terms) return place(i);
			} else if (token === control && ++matched === repeat) {
				passing = true;
			}
		}

		i += token.length;
	}

	return place(after.length);
};

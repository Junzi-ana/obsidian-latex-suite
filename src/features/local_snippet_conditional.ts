import type {
	LocalSnippetConditional,
	LocalSnippetConditionalRule,
} from "../settings/settings";

/**
 * Support code for "conditioned" local snippets: one regex trigger plus a
 * table that maps the text captured by the first capturing group to the text
 * the whole match should be replaced with.
 *
 * The table is persisted as the *source* of a replacement function (JSON
 * cannot store functions) and compiled again when the snippets are parsed.
 * Everything in this file is pure so it can be unit-checked by eye and reused
 * by both the store and the modal.
 */

/** Compile the stored source into a replacement function, or null on failure. */
export function compileReplacementFn(
	source: string,
): ((match: RegExpExecArray) => unknown) | null {
	try {
		// eslint-disable-next-line no-new-func -- snippet sources are evaluated by design
		const factory = new Function(`"use strict"; return (${source});`) as () => unknown;
		const fn = factory();
		return typeof fn === "function" ? (fn as (match: RegExpExecArray) => unknown) : null;
	} catch (e) {
		console.error("Local snippet: failed to compile replacement function", e, source);
		return null;
	}
}

/**
 * Build the replacement source for `rules`.
 *
 * - `group` is 0-based: 0 picks the text of the first capturing group
 *   (`match[1]`), 1 the second, and so on;
 * - a miss returns `false`, which makes the snippet engine do nothing at all
 *   (no empty string, no undo entry).
 */
export function buildConditionalSource(
	rules: LocalSnippetConditionalRule[],
	group = 0,
): string {
	const table: Record<string, string> = {};
	for (const rule of rules) table[rule.key] = rule.output;
	const index = Math.max(0, Math.trunc(group)) + 1; // match[1] is the first group
	return `(m) => (${JSON.stringify(table)})[m[${index}]] ?? false`;
}

/** Try to recover the rule table from a generated source (for hand-written ones). */
export function parseConditionalSource(source: string): LocalSnippetConditional | null {
	const match = /\(\s*(\{[\s\S]*?\})\s*\)\s*\[\s*m\[\s*(\d+)\s*\]\s*\]/.exec(source);
	if (!match) return null;
	const group = Number(match[2]) - 1;
	if (!Number.isFinite(group) || group < 0) return null;
	try {
		const table = JSON.parse(match[1]) as Record<string, unknown>;
		const rules: LocalSnippetConditionalRule[] = [];
		for (const [key, output] of Object.entries(table)) {
			if (typeof output !== "string") return null;
			rules.push({ key, output });
		}
		return rules.length ? { rules, group } : null;
	} catch {
		return null;
	}
}

/** Number of capturing groups in a regex source (character classes are skipped). */
export function countCaptureGroups(source: string): number {
	let count = 0;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "[") {
			for (i++; i < source.length && source[i] !== "]"; i++) {
				if (source[i] === "\\") i++;
			}
			continue;
		}
		if (ch === "(") {
			if (source[i + 1] !== "?") {
				count++;
			} else if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") {
				count++; // named group (?<name>...)
			}
		}
	}
	return count;
}

/** Index of the `)` matching the `(` at `start`. */
function matchingParen(source: string, start: number): number {
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "[") {
			i = charClassEnd(source, i);
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** First top-level alternative of a group body ("a|b" -> "a"). */
function firstAlternative(inner: string): string {
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "[") {
			i = charClassEnd(inner, i);
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "|" && depth === 0) return inner.slice(0, i);
	}
	return inner;
}

/** Index of the `]` closing the character class opened at `open`. */
function charClassEnd(source: string, open: number): number {
	for (let j = open + 1; j < source.length; j++) {
		if (source[j] === "\\") {
			j++;
			continue;
		}
		if (source[j] === "]") return j;
	}
	return source.length;
}

/** Sample text for an escaped regex element: \d -> "0", \w -> "a", \s -> " ". */
const escapedSample = (escaped: string): string =>
	escaped === "d" ? "0" : escaped === "w" ? "a" : escaped === "s" ? " " : escaped;

/** Sample text for the inside of a character class, best effort. */
function charClassSample(inner: string): string {
	let candidate = "";
	for (let j = 0; j < inner.length; j++) {
		if (inner[j] === "\\") {
			const s = escapedSample(inner[j + 1] ?? "");
			if (!candidate && s) candidate = s;
			j++;
			continue;
		}
		if (!candidate && inner[j] !== "-" && inner[j] !== "^") candidate = inner[j];
	}
	return candidate || "a";
}

/** Peel a `(?:`, `(?<name>` prefix or an empty lookahead off a group body. */
const peelGroupBody = (body: string): { body: string; isCapture: boolean } => {
	if (body.startsWith("?:")) return { body: body.slice(2), isCapture: false };
	if (body.startsWith("?=") || body.startsWith("?!")) return { body: "", isCapture: false };
	if (body.startsWith("?<")) {
		const close = body.indexOf(">");
		return { body: close === -1 ? "" : body.slice(close + 1), isCapture: true };
	}
	return { body, isCapture: true };
};

/** Shared state while sampling a whole trigger: which capture group gets filled. */
interface SampleFill {
	index: number;
	text: string;
}

/** One representative character sequence for a regex fragment (best effort). */
function sampleOf(fragment: string, fill?: SampleFill, captures?: { count: number }): string {
	const inner = firstAlternative(fragment);
	let out = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === "\\") {
			out += escapedSample(inner[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === "[") {
			const close = charClassEnd(inner, i);
			out += charClassSample(inner.slice(i + 1, close));
			i = close;
			continue;
		}
		if (ch === "(") {
			const end = matchingParen(inner, i);
			if (end === -1) {
				i = inner.length;
				continue;
			}
			const peeled = peelGroupBody(inner.slice(i + 1, end));
			if (peeled.isCapture && fill && captures) {
				if (captures.count === fill.index) {
					out += fill.text;
					captures.count++;
					i = end;
					continue;
				}
				captures.count++;
			}
			out += peeled.body ? sampleOf(peeled.body, fill, captures) : "";
			i = end;
			continue;
		}
		if (ch === ")" || ch === "^" || ch === "$") {
			continue;
		}
		if (ch === ".") {
			out += "a";
			continue;
		}
		if (ch === "*" || ch === "+" || ch === "?") {
			continue;
		}
		if (ch === "{") {
			const end = inner.indexOf("}", i);
			i = end === -1 ? i : end;
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Best-effort example input for one row: capturing group `group` is filled
 * with `key`, every other group with a minimal sample. Used only for the live
 * preview; the real input comes from the editor.
 */
export function expandConditionalExample(trigger: string, key: string, group = 0): string {
	return sampleOf(trigger, { index: Math.max(0, group), text: key }, { count: 0 });
}

export type ConditionalPreviewRow = {
	example: string;
	output: string;
	matched: boolean;
};

/**
 * Live preview: for every row, build an example input and run it through the
 * same anchoring the snippet engine uses (`(?:trigger)$`).
 */
export function previewConditional(
	trigger: string,
	rules: LocalSnippetConditionalRule[],
	options: string,
	group = 0,
): ConditionalPreviewRow[] {
	let regex: RegExp | null = null;
	if (trigger.trim()) {
		try {
			const flags = options.includes("i") ? "i" : "";
			regex = new RegExp(`(?:${trigger})$`, flags);
		} catch {
			regex = null;
		}
	}
	const index = Math.max(0, Math.trunc(group)) + 1;
	return rules.map((rule) => {
		const example = expandConditionalExample(trigger, rule.key, group);
		if (!regex) return { example, output: rule.output, matched: false };
		const match = regex.exec(example);
		const matched = !!match && match[index] === rule.key;
		return { example, output: rule.output, matched };
	});
}

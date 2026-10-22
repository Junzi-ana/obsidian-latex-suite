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
			for (i++; i < source.length && source[i] !== "]"; i++) {
				if (source[i] === "\\") i++;
			}
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
			for (i++; i < inner.length && inner[i] !== "]"; i++) {
				if (inner[i] === "\\") i++;
			}
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "|" && depth === 0) return inner.slice(0, i);
	}
	return inner;
}

/** One representative character sequence for a regex fragment (best effort). */
function sampleOf(fragment: string): string {
	const inner = firstAlternative(fragment);
	let out = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === "\\") {
			const next = inner[i + 1] ?? "";
			if (next === "d") out += "0";
			else if (next === "w") out += "a";
			else if (next === "s") out += " ";
			else if (next === "b" || next === "B") out += "";
			else out += next;
			i++;
			continue;
		}
		if (ch === "[") {
			let j = i + 1;
			if (inner[j] === "^") {
				out += "a";
				for (; j < inner.length && inner[j] !== "]"; j++) {
					if (inner[j] === "\\") j++;
				}
				i = j;
				continue;
			}
			let candidate = "";
			for (; j < inner.length && inner[j] !== "]"; j++) {
				if (inner[j] === "\\") {
					const escaped = inner[j + 1] ?? "";
					candidate = candidate || (escaped === "d" ? "0" : escaped === "w" ? "a" : escaped === "s" ? " " : escaped);
					j++;
					continue;
				}
				if (!candidate && inner[j] !== "-") candidate = inner[j];
			}
			out += candidate || "a";
			i = j;
			continue;
		}
		if (ch === "(") {
			const end = matchingParen(inner, i);
			if (end === -1) {
				out += "";
				i = inner.length;
				continue;
			}
			let body = inner.slice(i + 1, end);
			if (body.startsWith("?:")) body = body.slice(2);
			else if (body.startsWith("?=") || body.startsWith("?!")) body = "";
			out += body ? sampleOf(body) : "";
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
			if (ch === "?" && out === "") out += "";
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
	let out = "";
	let captureIndex = 0;
	for (let i = 0; i < trigger.length; i++) {
		const ch = trigger[i];
		if (ch === "\\") {
			const next = trigger[i + 1] ?? "";
			if (next === "d") out += "0";
			else if (next === "w") out += "a";
			else if (next === "s") out += " ";
			else out += next;
			i++;
			continue;
		}
		if (ch === "[") {
			let j = i + 1;
			let candidate = "";
			for (; j < trigger.length && trigger[j] !== "]"; j++) {
				if (trigger[j] === "\\") {
					const escaped = trigger[j + 1] ?? "";
					candidate = candidate || (escaped === "d" ? "0" : escaped === "w" ? "a" : escaped);
					j++;
					continue;
				}
				if (!candidate && trigger[j] !== "-" && trigger[j] !== "^") candidate = trigger[j];
			}
			out += candidate || "a";
			i = j;
			continue;
		}
		if (ch === "(") {
			const end = matchingParen(trigger, i);
			if (end === -1) {
				i = trigger.length;
				continue;
			}
			const body = trigger.slice(i + 1, end);
			const isCapture = body[0] !== "?" || (body[1] === "<" && body[2] !== "=" && body[2] !== "!");
			if (isCapture && captureIndex === Math.max(0, group)) {
				out += key;
				captureIndex++;
			} else {
				if (isCapture) captureIndex++;
				let innerBody = body;
				if (innerBody.startsWith("?:")) innerBody = innerBody.slice(2);
				else if (innerBody.startsWith("?=") || innerBody.startsWith("?!")) innerBody = "";
				else if (innerBody.startsWith("?<")) {
					const close = innerBody.indexOf(">");
					innerBody = close === -1 ? "" : innerBody.slice(close + 1);
				}
				out += innerBody ? sampleOf(innerBody) : "";
			}
			i = end;
			continue;
		}
		if (ch === ")" || ch === "^" || ch === "$") continue;
		if (ch === ".") {
			out += "a";
			continue;
		}
		if (ch === "*" || ch === "+" || ch === "?") continue;
		if (ch === "{") {
			const end = trigger.indexOf("}", i);
			i = end === -1 ? i : end;
			continue;
		}
		out += ch;
	}
	return out;
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

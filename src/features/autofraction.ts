import { EditorView } from "@codemirror/view";
import { SelectionRange } from "@codemirror/state";
import { findMatchingBracket } from "src/utils/editor_utils";
import { queueSnippet } from "src/snippets/codemirror/snippet_queue_state_field";
import { expandSnippets } from "src/snippets/snippet_management";
import { autoEnlargeBrackets } from "./auto_enlarge_brackets";
import { Context } from "src/utils/context";
import { getLatexSuiteConfig } from "src/snippets/codemirror/config";
import { ArrayNode, emptyInsertOptions, TabstopNode, TextNode } from "src/snippets/luasnip_api/node";
import { findNumerator } from "./scan";


export const runAutoFraction = (view: EditorView, ctx: Context): boolean => {

	for (const range of ctx.ranges) {
		runAutoFractionCursor(view, ctx, range);
	}

	const success = expandSnippets(view);
	
	if (success) {
		autoEnlargeBrackets(view);
	}

	return success;
}


const greek = "alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|Psi|omega|Omega";
const regex = new RegExp("(" + greek + ") ([^ ])", "g");

export const runAutoFractionCursor = (view: EditorView, ctx: Context, range: SelectionRange):boolean => {

	const settings = getLatexSuiteConfig(view);
	const {from, to} = range;

	// Don't run autofraction in excluded environments
	for (const env of settings.autofractionExcludedEnvs) {
		if (ctx.isWithinEnvironment(to, env)) {
			return false;
		}
	}

	// Get the bounds of the equation
	const result = ctx.getBounds();
	if (!result) return false;
	const eqnStart = result.inner_start;


	const curLine = view.state.sliceDoc(eqnStart, to);

	let start = eqnStart;
	// Where the numerator ends: the control tokens after it are left out.
	let end = to;

	if (from != to) {
		// We have a selection
		// Set start to the beginning of the selection

		start = from;
	}
	else {
		// Find the contents of the fraction.

		// Allow spaces after greek letters by replacing them with a dummy
		// character (#). One character for one, so the indices still line up.
		regex.lastIndex = 0;
		const scanned = curLine.replace(regex, "$1#$2");

		// The numerator shares the Operators and Boundaries lists of
		// auto-brackets, plus a space, which always ends it. Operators are
		// counted rather than cut, so the control tokens (k dots, k repetitions
		// of one operator) pick how many terms go into the numerator.
		const found = findNumerator(scanned, {
			pairs: settings.autoBracketsDelimiters,
			operators: settings.autoBracketsOperators,
			boundaries: [" ", ...settings.autoBracketsBoundaries],
		});
		if (found === null) return false;

		start = found.start + eqnStart;
		end = found.end + eqnStart;
	}

	// Don't run on an empty line
	if (start === to) { return false; }

	// Run autofraction
	let numerator = view.state.sliceDoc(start, end);

	// Remove unnecessary outer parentheses
	if (numerator.at(0) === "(" && numerator.at(-1) === ")") {
		const closing = findMatchingBracket(numerator, 0, "(", ")", false);
		if (closing === numerator.length - 1) {
			numerator = numerator.slice(1, -1);
		}
	}

	const snippet = new ArrayNode([
		new TextNode(settings.autofractionSymbol + "{"),
		// If the content inside parentheses is empty, the numerator would be empty and that's rarely desired.
		numerator === "" ? new TabstopNode(0) : new TextNode(numerator),
		new TextNode("}{"),
		new TabstopNode(1),
		new TextNode("}"),
		new TabstopNode(2),
	]);
	// The keypressed shouldn't be inserted back in after an undo, if we have a selection.
	const keyPressed = from != to ? undefined : "/";

	queueSnippet(view, start, to, snippet.applyInsert(emptyInsertOptions), keyPressed);

	return true;
}

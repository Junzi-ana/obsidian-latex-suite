import { EditorView } from "@codemirror/view";
import { SelectionRange } from "@codemirror/state";
import { Context } from "src/utils/context";
import { DelimiterPair } from "src/settings/settings";
import { getLatexSuiteConfig } from "src/snippets/codemirror/config";
import { queueSnippet } from "src/snippets/codemirror/snippet_queue_state_field";
import { expandSnippets } from "src/snippets/snippet_management";
import { ArrayNode, emptyInsertOptions, TextNode } from "src/snippets/luasnip_api/node";
import { findClosingBracket, findWrapper } from "./scan";

/**
 * Insert the opening bracket of `pair` in front of the innermost term
 * when the closing bracket is typed, e.g. `a+b` + `)` becomes `(a+b)`.
 */
export const runAutoBrackets = (view: EditorView, ctx: Context, pair: DelimiterPair): boolean => {
	for (const range of ctx.ranges) {
		runAutoBracketsCursor(view, ctx, range, pair);
	}

	return expandSnippets(view);
};

const runAutoBracketsCursor = (view: EditorView, ctx: Context, range: SelectionRange, pair: DelimiterPair): boolean => {
	if (range.from !== range.to) return false;

	const bounds = ctx.getBounds(range.to);
	if (!bounds) return false;

	const settings = getLatexSuiteConfig(view);
	const text = view.state.sliceDoc(bounds.inner_start, range.to);
	const wrapper = findWrapper(text, pair, {
		pairs: settings.autoBracketsDelimiters,
		operators: settings.autoBracketsOperators,
		boundaries: settings.autoBracketsBoundaries,
	});
	if (wrapper === null) return false;

	const inner = text.slice(wrapper.start, wrapper.end).replace(/[ \t]+$/, "");
	if (inner.trim() === "") return false;

	const snippet = new ArrayNode([
		new TextNode(pair[0]),
		new TextNode(inner),
		new TextNode(pair[1]),
	]);
	// The control tokens between `end` and the cursor are swallowed together with the selection.
	queueSnippet(view, bounds.inner_start + wrapper.start, range.to, snippet.applyInsert(emptyInsertOptions), pair[1]);

	return true;
};

/**
 * Insert the closing bracket of `pair` on the close trigger, e.g. `(a+b+c`
 * with the cursor after `a+b` becomes `(a+b)+c`.
 */
export const runClosingBracket = (view: EditorView, ctx: Context, pair: DelimiterPair): boolean => {
	const range = view.state.selection.main;
	if (range.from !== range.to) return false;

	const bounds = ctx.getBounds(range.head);
	if (!bounds) return false;

	const settings = getLatexSuiteConfig(view);
	const placement = findClosingBracket(
		view.state.sliceDoc(bounds.inner_start, range.head),
		view.state.sliceDoc(range.head, bounds.inner_end),
		pair,
		{
			pairs: settings.autoBracketsDelimiters,
			operators: settings.autoBracketsOperators,
			boundaries: settings.autoBracketsBoundaries,
		},
	);
	if (placement === null) return false;

	const controlFrom = bounds.inner_start + placement.controlStart;
	const insertAt = range.head + placement.insertAt;
	const shift = range.head - controlFrom;

	view.dispatch({
		changes: [
			{ from: controlFrom, to: range.head, insert: "" },
			{ from: insertAt, to: insertAt, insert: pair[1] },
		],
		selection: { anchor: insertAt - shift + pair[1].length },
	});

	return true;
};

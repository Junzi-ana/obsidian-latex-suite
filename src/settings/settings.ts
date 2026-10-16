import { Snippet } from "../snippets/snippets";
import { Environment } from "../snippets/environment";
import { DEFAULT_SNIPPETS } from "src/utils/default_snippets";
import { DEFAULT_SNIPPET_VARIABLES } from "src/utils/default_snippet_variables";
import type { EditorView } from "@codemirror/view";
import * as v from "valibot"

export type snippetDebugLevel = "off" | "info" | "verbose";

/**
 * A local (document / tag scoped) snippet entry, as edited in the local
 * snippet UI. Stored as structured JSON, so no manual backslash escaping is
 * needed (unlike the global snippet textarea).
 */
export type LocalSnippetEntry = {
	trigger: string;
	replacement: string;
	options: string;
	priority?: number;
	description?: string;
};

/**
 * A local snippet *item*. Unlike the global snippets, one item carries its
 * own bindings: it may be bound to a single note (`file` = its vault path)
 * and to any number of tags (`tags`). Both are optional but at least one must
 * be set, so a snippet may apply to exactly one note, to every note carrying
 * any of its tags, or to a note *and* all notes carrying those tags. Editing
 * an item later can change its bindings freely.
 */
export type LocalSnippetItem = LocalSnippetEntry & {
	file?: string;
	tags?: string[];
};

/**
 * Local snippets are stored as one flat, ordered list of items. When a note
 * is active, the applicable items are the ones bound to that note, followed
 * by the ones bound to each of the note's tags (sorted by tag name); all of
 * them are tried before the global snippets, so a local snippet with the same
 * trigger wins over a global one.
 */
export type LocalSnippetData = {
	items: LocalSnippetItem[];
};

/**
 * Runtime hook that the core snippet matching code uses to reach the store
 * that holds the per-document / per-tag snippets of the current plugin
 * instance. Kept structural here so settings.ts stays free of import cycles.
 */
export interface LocalSnippetStoreLike {
	/** true when no local snippets exist at all (fast path for keypresses) */
	isEmpty(): boolean;
	/**
	 * The parsed local snippets that apply to `view` (its note + the note's
	 * tags), in priority order, or an empty array when none apply.
	 */
	getSnippetsFor(view: EditorView): Snippet[];
	/** open the "create local snippet from selection" dialog for `view` */
	openCreateLocalSnippetModal(view: EditorView): boolean;
}

type CMKeyMap = string;
type VimKeyMap = string;

export interface LatexSuiteBasicSettings {
	snippetsEnabled: boolean;
	suppressSnippetTriggerOnIME: boolean;
	suppressIMEWarning: boolean;
	removeSnippetWhitespace: boolean;
	autoDelete$: boolean;
	loadSnippetsFromFile: boolean;
	loadSnippetVariablesFromFile: boolean;
	snippetsFileLocation: string;
	snippetVariablesFileLocation: string;
	autofractionEnabled: boolean;
	concealEnabled: boolean;
	concealRevealTimeout: number;
	colorPairedBracketsEnabled: boolean;
	highlightCursorBracketsEnabled: boolean;
	mathPreviewEnabled: boolean;
	mathPreviewPositionIsAbove: boolean;
	mathPreviewCursor: string;
	mathPreviewBracketHighlighting: boolean;
	mathPreviewLivePreviewDisplay: boolean;
	autofractionSymbol: string;
	autofractionBreakingChars: string;
	matrixShortcutsEnabled: boolean;
	taboutEnabled: boolean;
	taboutExitEquationOnlyOnEOL: boolean;
	autoEnlargeBrackets: boolean;
	autoEnlargeBracketsSpace: boolean;
	wordDelimiters: string;
	snippetDebug: snippetDebugLevel;
	vimEnabled: boolean;
	vimSelectMode: VimKeyMap;
	vimVisualMode: VimKeyMap;
	vimMatrixEnter: VimKeyMap;
	snippetRecursion: number;
	snippetIMEVersion: boolean;
	highlightDollarEnabled: boolean;
}

/** triggers following the same format as https://codemirror.net/docs/ref/#view.KeyBinding */
export interface LatexSuiteCMKeymapSettings {
	snippetsTrigger: CMKeyMap;
	snippetNextTabstopTrigger: CMKeyMap;
	snippetPreviousTabstopTrigger: CMKeyMap;
	taboutTrigger: CMKeyMap;
}

/**
 * Settings that require further processing (e.g. conversion to an array) before being used.
 */
export interface LatexSuiteRawSettings {
	autofractionExcludedEnvs: string;
	matrixShortcutsEnvNames: string;
	matrixShortcutsMacroNames: string;
	taboutClosingSymbols: string;
	autoEnlargeBracketsTriggers: string;
	forceMathLanguages: string;
}

interface LatexSuiteParsedSettings {
	autofractionExcludedEnvs: Environment[];
	matrixShortcutsEnvNames: string[];
	matrixShortcutsMacroNames: string[];
	taboutClosingSymbols: Set<string>;
	autoEnlargeBracketsTriggers: string[];
	forceMathLanguages: string[];
}

export type LatexSuitePluginSettings = {snippets: string, snippetVariables: string, localSnippets: LocalSnippetData} & LatexSuiteBasicSettings & LatexSuiteRawSettings & LatexSuiteCMKeymapSettings;
export type LatexSuiteCMSettings = {snippets: Snippet[], localSnippetStore?: LocalSnippetStoreLike} & LatexSuiteBasicSettings & LatexSuiteParsedSettings & LatexSuiteCMKeymapSettings;

export const DEFAULT_SETTINGS: LatexSuitePluginSettings = {
	snippets: DEFAULT_SNIPPETS,
	snippetVariables: DEFAULT_SNIPPET_VARIABLES,
	localSnippets: { items: [] },

	// Basic settings
	snippetsEnabled: true,
	snippetsTrigger: "Tab",
	snippetNextTabstopTrigger: "Tab",
	snippetPreviousTabstopTrigger: "Shift-Tab",
	suppressSnippetTriggerOnIME: true,
	suppressIMEWarning: false,
	removeSnippetWhitespace: true,
	autoDelete$: true,
	loadSnippetsFromFile: false,
	loadSnippetVariablesFromFile: false,
	snippetsFileLocation: "",
	snippetVariablesFileLocation: "",
	concealEnabled: false,
	concealRevealTimeout: 0,
	colorPairedBracketsEnabled: true,
	highlightCursorBracketsEnabled: true,
	mathPreviewEnabled: true,
	mathPreviewPositionIsAbove: true,
	mathPreviewCursor: "▶",
	mathPreviewBracketHighlighting: false,
	mathPreviewLivePreviewDisplay: false,
	autofractionEnabled: true,
	autofractionSymbol: "\\frac",
	autofractionBreakingChars: "+-=\t",
	matrixShortcutsEnabled: true,
	taboutEnabled: true,
	taboutExitEquationOnlyOnEOL: true,
	taboutTrigger: "Tab",
	autoEnlargeBrackets: true,
	autoEnlargeBracketsSpace: true,
	wordDelimiters: "., +-\\n\t:;!?\\/{}[]()=~$'\"|`<>*^%#@&",

	// Raw settings
	autofractionExcludedEnvs:
	`[
		["^{", "}"],
		["\\\\pu{", "}"]
	]`,
	matrixShortcutsEnvNames: "pmatrix, cases, align, gather, bmatrix, Bmatrix, vmatrix, Vmatrix, array, matrix",
	matrixShortcutsMacroNames: "eqalign",
	taboutClosingSymbols: "), ], \\rbrack, \\}, \\rbrace, \\rangle, \\rvert, \\rVert, \\rfloor, \\rceil, \\urcorner, }",
	autoEnlargeBracketsTriggers: "sum, int, frac, prod, bigcup, bigcap",
	forceMathLanguages: "math",
	snippetDebug: "off",
	vimEnabled: false,
	vimSelectMode: "<C-g>",
	vimVisualMode: "<C-g>",
	vimMatrixEnter: "o",
	snippetRecursion: 0,
	snippetIMEVersion: false,
	highlightDollarEnabled: true,
}

const EnvironmentSchema = v.pipe(
	v.string(),
	v.parseJson(),
	v.array(v.looseTuple([v.string(), v.string()], "Every item needs to be an array with 2 items"), "Needs to be an array [item1,item2]"),
	v.mapItems(([openSymbol, closeSymbol]) => ({ openSymbol, closeSymbol })),
);

export function processLatexSuiteSettings(snippets: Snippet[], settings: LatexSuitePluginSettings):LatexSuiteCMSettings {

	function strToArray(str: string) {
		return str.replace(/\s/g,"").split(",");
	}

	function getAutofractionExcludedEnvs(envsStr: string) {
		let envs: Environment[] = [];

		try {
			envs = v.parse(EnvironmentSchema, envsStr);
		}
		catch (e) {
			console.error(e);
		}

		return envs;
	}

	return {
		...settings,

		// Override raw settings with parsed settings
		snippets: snippets,
		autofractionExcludedEnvs: getAutofractionExcludedEnvs(settings.autofractionExcludedEnvs),
		matrixShortcutsEnvNames: strToArray(settings.matrixShortcutsEnvNames),
		matrixShortcutsMacroNames: strToArray(settings.matrixShortcutsMacroNames),
		taboutClosingSymbols: new Set<string>(strToArray(settings.taboutClosingSymbols)),
		// Add backslash to triggers that are LaTeX commands
		autoEnlargeBracketsTriggers: strToArray(settings.autoEnlargeBracketsTriggers)
			.map(trigger => /[A-Za-z]+/.test(trigger) ? `\\${trigger}` : trigger), 
		forceMathLanguages: strToArray(settings.forceMathLanguages),
	}
}

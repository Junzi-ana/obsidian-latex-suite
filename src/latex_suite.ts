import { EditorView, ViewPlugin, ViewUpdate, KeyBinding, runScopeHandlers } from "@codemirror/view";
import { runSnippets } from "./features/run_snippets";
import { runAutoFraction } from "./features/autofraction";
import { runAutoBrackets, runClosingBracket } from "./features/auto_brackets";
import { tabout, shouldTaboutByCloseBracket } from "./features/tabout";
import { tabBackwardJump, tabForwardFallback } from "./features/tab_flow";
import { addCellMatrixShortcut, exitMatrixShortCut, newlineMatrixShortcut, priorityTaboutMatrixShortcut } from "./features/matrix_shortcuts";

import { getContextPlugin, getMathBoundsPlugin } from "./utils/context";
import { getCharacterAtPos, replaceRange } from "./utils/editor_utils";
import { setSelectionToNextTabstop, tempKeyPress } from "./snippets/snippet_management";
import { removeAllTabstops } from "./snippets/codemirror/tabstops_state_field";
import { getLatexSuiteConfig } from "./snippets/codemirror/config";
import { clearSnippetQueue } from "./snippets/codemirror/snippet_queue_state_field";
import { handleUndoRedo } from "./snippets/codemirror/history";

import { handleMathTooltip } from "./editor_extensions/math_tooltip";
import { isComposing, forceEndComposition } from "./utils/editor_utils";
import { LatexSuiteCMSettings } from "./settings/settings";
import { Type } from "./parser/mathjax-parser";
import type { Snippet } from "./snippets/snippets";

export const handleUpdate = (update: ViewUpdate) => {
	const settings = getLatexSuiteConfig(update.state);

	// The math tooltip handler is driven by view updates because it utilizes
	// information about visual line, which is not available in EditorState
	if (settings.mathPreviewEnabled && !update.transactions.some(tr => tr.annotation(tempKeyPress))) {
		handleMathTooltip(update);
	}

	if (handleUndoRedo(update)) {
		return;
	}

	const userEvent = update.transactions.filter((tr) => tr.isUserEvent("input.type"));
	if (userEvent.length === 0 || !settings.snippetIMEVersion) {
			return;
	}

	// HACK: reusing logic from handleKeydown with empty string
	const success = handleKeydown("", false, update.view.composing, update.view);
	if (success) {
		console.debug("Handled input event as snippet trigger");
	}

}

export const keyboardEventPlugin = ViewPlugin.fromClass(class {
	lastKeyboardEvent: KeyboardEvent | null = null;
	// The last *ordinary* (non-composition) key that was pressed, with a
	// timestamp. Used by `onInput` to tell a plain key press (whose character
	// reaches the editor as a normal DOM insertion right after the keydown we
	// already handled) apart from a character the IME committed on its own -
	// the latter has no matching plain keydown (some IMEs swallow the key, so
	// `lastKeyboardEvent` may be null), which is what used to leave commits
	// such as "@" + IME-"S" unexpanded.
	lastPlainKey = "";
	lastPlainKeyAt = 0;
	// When an IME composition finishes (e.g. Chinese / Japanese input), the
	// composed text is committed to the editor as a DOM mutation that reaches
	// `onInput`. We record when that happened so `onInput` can replay the text
	// character by character and trigger snippets on each one (see
	// `handleImeText`). A timestamp is used instead of a boolean because the
	// commit can arrive slightly after `compositionend` (the editor reads it
	// back from the DOM), and an unrelated keydown may land in between.
	imeCompositionEndedAt = 0;

	onKeydown(event: KeyboardEvent, view: EditorView) {
		const isCompositionKey =
			event.key == "Unidentified" || event.key == "Process" || event.key == "Dead";
		if (isCompositionKey) {
			this.lastKeyboardEvent = event;
			return;
		} else {
			this.lastKeyboardEvent = null;
			this.lastPlainKey = event.key;
			this.lastPlainKeyAt = Date.now();
		}
		const snippetIMEVersion = getLatexSuiteConfig(view).snippetIMEVersion;

		const success =
			(!snippetIMEVersion &&
				handleKeydown(
					event.key,
					event.ctrlKey || event.metaKey,
					isComposing(view, event),
					view,
				)) ||
			runScopeHandlers(view, event, "latex-suite");

		if (success) event.preventDefault();
	}

	onCompositionStart() {
		this.imeCompositionEndedAt = 0;
		this.lastPlainKey = "";
		this.lastPlainKeyAt = 0;
	}

	onCompositionEnd() {
		this.imeCompositionEndedAt = Date.now();
	}
}, {
	eventHandlers: {
		keydown(event, view) {
			view.plugin(keyboardEventPlugin)!.onKeydown(event, view);
		},
		compositionstart(event, view) {
			view.plugin(keyboardEventPlugin)!.onCompositionStart();
		},
		compositionend(event, view) {
			view.plugin(keyboardEventPlugin)!.onCompositionEnd();
		},
	},

})

/**
 * Insert a character at the current cursor exactly like a normal key press
 * would (replacing the current selection when there is one).
 */
const insertCharacter = (view: EditorView, ch: string) => {
	const sel = view.state.selection.main;
	view.dispatch({
		changes: { from: sel.from, to: sel.to, insert: ch },
		selection: { anchor: sel.from + ch.length },
		userEvent: "input.type",
		scrollIntoView: true,
	});
};

/**
 * Handle text that was committed by an IME (Chinese / Japanese / etc.).
 *
 * IMEs commit the composed text as a single change. Latex Suite normally
 * triggers snippets per key press, so this text is replayed character by
 * character: each character is first offered to the automatic snippets (as if
 * it had been typed), and only inserted literally when nothing matches. This
 * makes chains such as `@a.1hat` expand step by step (@a -> \alpha, then
 * `.1` -> subscript, then `hat`) even when the whole string arrives in one
 * commit.
 *
 * `from`/`to` are the range the change replaces. An IME commit usually
 * replaces nothing (`from == to`), but some editors/IMEs report the commit as
 * replacing the inline composition text (or as an autocorrect replacement).
 * That text has to be removed first, otherwise the replayed characters would
 * be appended after it and could never match a trigger - the bug where typing
 * `@` and then committing `S` from the IME left `@S` unexpanded.
 *
 * @returns true when the text was fully handled (the caller should then return
 *          true from `onInput` so CodeMirror does not apply its own insertion).
 */
const handleImeText = (view: EditorView, from: number, to: number, text: string): boolean => {
	const settings = getLatexSuiteConfig(view);
	if (!settings.snippetsEnabled) return false;
	// Multi-cursor / non-empty-selection commits are left to CodeMirror's
	// default handling to avoid subtle breakage.
	if (view.state.selection.ranges.length !== 1) return false;
	if (!view.state.selection.main.empty) return false;

	// Drop the text the commit replaces (inline composition text, autocorrect
	// target, ...) before replaying, and park the cursor at the commit point.
	if (to > from) {
		view.dispatch({
			changes: { from, to, insert: "" },
			selection: { anchor: from },
			userEvent: "input.type",
			scrollIntoView: false,
		});
	}

	let expandedAny = false;
	const chars = Array.from(text); // split by code points
	for (const ch of chars) {
		// Newlines are ordinary line breaks; don't offer them to snippets.
		if (ch === "\n" || ch === "\r") {
			insertCharacter(view, ch);
			continue;
		}
		// Characters wider than one UTF-16 unit (e.g. some CJK chars and
		// surrogate pairs) can never match a snippet trigger (handleKeydown
		// rejects keys with length > 1), so insert them directly.
		if (ch.length !== 1) {
			insertCharacter(view, ch);
			continue;
		}
		// Treat the character as a freshly typed key. isIME is intentionally
		// false here: the composition has already ended, so snippets should be
		// allowed to run even when "suppress on IME" is enabled (this matches
		// the behaviour of the upstream `snippetIMEVersion` option).
		const success = handleKeydown(ch, false, false, view);
		if (success) {
			expandedAny = true;
			continue;
		}
		// Nothing matched - insert the character ourselves, since returning
		// true from `onInput` suppresses CodeMirror's default insertion.
		insertCharacter(view, ch);
	}
	if (expandedAny) forceEndComposition(view);
	return true;
};

export const onInput = (view: EditorView, from: number, to: number, text: string): boolean => {
	const snippetIMEVersion = getLatexSuiteConfig(view).snippetIMEVersion;
	if (snippetIMEVersion) {
		return false;
	}
	const plugin = view.plugin(keyboardEventPlugin);
	const lastKeyboardEvent = plugin?.lastKeyboardEvent;
	if (text === "\0\0") return true;

	// Everything that reaches this input handler comes from a DOM mutation
	// (plain typing, IME commits, autocorrect, ...). Paste / autocomplete /
	// drag-drop are dispatched by CodeMirror directly and never come through
	// here.
	//
	// A *plain* single-character key press is the one case we do not replay:
	// its keydown already ran `handleKeydown` (and preventDefault when a
	// snippet expanded), and if nothing matched, CodeMirror should just insert
	// the character. Everything else is treated as an IME-style commit and
	// replayed character by character - this covers
	//   * multi-character commits (e.g. typing "mk" or "a@S" through the IME),
	//   * changes that replace existing content (`from != to`: an IME commit
	//     replacing its inline composition text, autocorrect, ...), and
	//   * single characters whose keydown never reached us because the IME
	//     swallowed it, which is what used to leave "@" + IME-"S" unexpanded.
	//
	// We honour "Don't trigger snippets when IME is active": when that option
	// is on, committed IME text is left to CodeMirror's plain insertion.
	const settings = getLatexSuiteConfig(view);
	const recentlyComposed =
		!!plugin &&
		plugin.imeCompositionEndedAt !== 0 &&
		Date.now() - plugin.imeCompositionEndedAt < 1000;
	const isPlainKeyPress =
		text.length === 1 &&
		from === to &&
		!recentlyComposed &&
		(text === "\n" ||
			text === "\r" ||
			text === "\t" ||
			(!!plugin && plugin.lastPlainKey === text && Date.now() - plugin.lastPlainKeyAt < 500));

	if (!isPlainKeyPress && text.length > 0 && !settings.suppressSnippetTriggerOnIME) {
		if (handleImeText(view, from, to, text)) return true;
	}

	if (text.length == 1 && lastKeyboardEvent) {
		if (text === "\t") text = "Tab";
		const success = handleKeydown(
			text,
			lastKeyboardEvent.ctrlKey || lastKeyboardEvent.metaKey,
			isComposing(view, lastKeyboardEvent),
			view
		);
		if (success) {
			forceEndComposition(view);
			return true;
		}
	}
	return false;
}

/**
 * Snippets that should be considered for `view`: the global snippets plus any
 * document- and tag-scoped local snippets that apply to the note being
 * edited. Local snippets are prepended, so when a local snippet shares its
 * trigger with a global one the local entry wins (file-scoped entries beat
 * tag-scoped ones because they come first, in the same merge).
 */
function effectiveSnippets(settings: LatexSuiteCMSettings, view: EditorView): Snippet[] {
	if (!settings.localSnippetStore || settings.localSnippetStore.isEmpty()) {
		return settings.snippets;
	}
	const localSnippets = settings.localSnippetStore.getSnippetsFor(view);
	if (localSnippets.length === 0) return settings.snippets;
	return [...localSnippets, ...settings.snippets];
}

export const handleKeydown = (key: string, ctrlKey: boolean, isIME: boolean, view: EditorView) => {
	if (key.length > 1) {
		return false
	}

	const settings = getLatexSuiteConfig(view);

	if (
		!settings.snippetsEnabled ||
		// Prevent IME from triggering keydown events.
		(settings.suppressSnippetTriggerOnIME && isIME) ||
		// Allows Ctrl + z for undo, instead of triggering a snippet ending with z
		ctrlKey
	) {
		return false;
	}
	const snippets = effectiveSnippets(settings, view).filter((s) => s.options.automatic);
	try {
		const options = {recursive: settings.snippetRecursion, debug: settings.snippetDebug};
		if (runSnippets(view, {snippets, key}, options)) return true;
	} catch (e) {
		clearSnippetQueue(view);
		console.error(e);
	}
	return false;
};

type LatexSuiteKeyBinding = KeyBinding & {scope: "latex-suite"};

/**
 * Get the keymaps specific for Latex Suite. These keymaps only run in scope `latex-suite`.
 * @param settings The settings with the keybindings to use
 * @returns The keymaps for the LaTeX suite based on the provided settings
 */
export function getKeymaps(settings: LatexSuiteCMSettings): LatexSuiteKeyBinding[] {
	// Order matters for keybindings, 
	// as they are checked in order from the beginning of the array to the end
	const keybindings: KeyBinding[] = [];

	/*
	 * Create a local (document/tag-scoped) snippet (Ctrl+Shift+Y). Works with
	 * or without a selection (without one the replacement is left empty). Only
	 * consumes the key when the store can resolve a markdown note for this
	 * editor.
	 */
	keybindings.push({
		key: "Mod-Shift-y",
		run: function createLocalSnippet(view: EditorView) {
			const store = getLatexSuiteConfig(view).localSnippetStore;
			if (!store) return false;
			return store.openCreateLocalSnippetModal(view);
		},
	});

	/*
	 * When backspace is pressed, if the cursor is inside an empty inline math,
	 * delete both $ symbols, not just the first one.
	 */
	if (settings.autoDelete$) {
		keybindings.push({
			key: "Backspace",
			run: function autoDelete$(view: EditorView) {
				if (!getLatexSuiteConfig(view).autoDelete$) return false;
				const boundPlugin = getMathBoundsPlugin(view)
				const pos = view.state.selection.main.head
				// check if the cursor is surrounded by Dollar Dollar or only one Dollar.
				const tree = boundPlugin.getTree(view.state)
				const node = tree.resolveInner(pos, -1)
				if (node.name !== Type.Dollar) return false;
				const prevSibling = node.prevSibling;
				const nextSibling = node.nextSibling;
				if (prevSibling || (nextSibling && nextSibling.name !== Type.Dollar)) return false;
				const charAtPos = getCharacterAtPos(view, pos);
				const charAtPrevPos = getCharacterAtPos(view, pos - 1);
				if (charAtPos === "$" && charAtPrevPos === "$") {
					replaceRange(view, pos - 1, pos + 1, "");
					// Note: not sure if removeAllTabstops is necessary
					removeAllTabstops(view);
					return true;
				}
				return false;
			},
		});
	}
	
	const snippet_triggers = new Set(
		settings.snippets.map((s) => s.triggerKey).filter((s) => s !== "")
	);
	snippet_triggers.add(settings.snippetsTrigger);
	const runMaker = (key: string) => {
		return (view: EditorView) => {
			const settings = getLatexSuiteConfig(view);
			// Prevent IME from triggering keydown events.
			if (settings.suppressSnippetTriggerOnIME && view.composing)
				return false;
			// Global + (document/tag-scoped) local snippets for this view
			const snippets = effectiveSnippets(settings, view).filter(
				(s) =>
					s.triggerKey === key ||
					(!s.triggerKey &&
						!s.options.automatic &&
						key === settings.snippetsTrigger),
			);
			try {
				const options = {recursive: settings.snippetRecursion, debug: settings.snippetDebug};
				return runSnippets(view, {snippets}, options);
			} catch (e) {
				clearSnippetQueue(view);
				console.error(e);
				return false;
			}
		};
	};
	if (settings.snippetsEnabled) {
		keybindings.push(
			...Array.from(snippet_triggers, (key) => {
				return {
					key,
					run: runMaker(key),
				};
			})
		);
	}

	keybindings.push({
		key: settings.snippetNextTabstopTrigger,
		run: function nextTabstop(view: EditorView) {
			return setSelectionToNextTabstop(view, false);
		},
	});

	keybindings.push({
		key: settings.snippetPreviousTabstopTrigger,
		run: function previousTabstop(view: EditorView) {
			return setSelectionToNextTabstop(view, true);
		},
	});

	// Shift-Tab also walks back to the previous bracket or differential.
	keybindings.push({
		key: "Shift-Tab",
		run: tabBackwardJump,
	});
	if (settings.autofractionEnabled) {
		keybindings.push({
			key: "/",
			run: function autofraction (view: EditorView) {
				if (!getLatexSuiteConfig(view).autofractionEnabled) return false;
				const ctx = getContextPlugin(view);
				if (!ctx.mode.strictlyInMath()) return false;
				return runAutoFraction(view, ctx);
			},
		});
	}

	// Matrix shortcuts are intentionally put before tabout shortcuts,
	const matrixShortcuts = [
		{
			key: "Enter",
			run: newlineMatrixShortcut,
		},
		{
			key: "Tab",
			run: addCellMatrixShortcut,
		},
		{
			key: "Shift-Enter",
			run: exitMatrixShortCut,
		},
	];
	if (settings.taboutEnabled && settings.taboutTrigger === "Tab") {
		matrixShortcuts.unshift({
			key: settings.taboutTrigger,
			run: priorityTaboutMatrixShortcut
		})
	}
	if (settings.matrixShortcutsEnabled) {
		keybindings.push(...matrixShortcuts);
	}

	// Goes before tabout, so that Tab closes an unclosed bracket instead of leaving the equation.
	if (settings.autoBracketsOnTab) {
		for (const pair of settings.autoBracketsDelimiters) {
			keybindings.push({
				key: "Tab",
				run: function closeBracket(view: EditorView) {
					const config = getLatexSuiteConfig(view);
					if (!config.autoBracketsOnTab || !config.autoBracketsEnabled) return false;
					const ctx = getContextPlugin(view);
					if (!ctx.mode.inMath()) return false;
					return runClosingBracket(view, ctx, pair);
				},
			});
		}
	}

	const taboutShortcuts = [
		{
			key: settings.taboutTrigger,
			run: function exitEquation(view: EditorView) {
				if (!view.state.selection.main.empty) return false;
				const ctx = getContextPlugin(view);
				return tabout(view, ctx);
			},
		},
		...[")", "}", "]"].map((key) => ({
			key,
			run: function nextClosingBracket(view: EditorView) {
				if (!shouldTaboutByCloseBracket(view, key)) return false;
				const ctx = getContextPlugin(view);
				return tabout(view, ctx);
			},
		})),
	];
	if (settings.taboutEnabled) {
		keybindings.push(...taboutShortcuts);
	}

	// Placed last so that tabbing over an existing closing bracket wins over wrapping.
	if (settings.autoBracketsEnabled) {
		for (const pair of settings.autoBracketsDelimiters) {
			keybindings.push({
				key: pair[1],
				run: function autoBrackets(view: EditorView) {
					if (!getLatexSuiteConfig(view).autoBracketsEnabled) return false;
					const ctx = getContextPlugin(view);
					if (!ctx.mode.inMath()) return false;
					return runAutoBrackets(view, ctx, pair);
				},
			});
		}
	}

	// Runs last: inside math, Tab must never fall through to the editor's indent.
	keybindings.push({
		key: "Tab",
		run: tabForwardFallback,
	});

	return keybindings.map((keybinding) => ({
		...keybinding,
		scope: "latex-suite",
	}));
}


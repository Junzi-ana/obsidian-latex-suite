import type { EditorView } from "@codemirror/view";
import { MarkdownView, TFile } from "obsidian";
import type LatexSuitePlugin from "src/main";
import type { Snippet } from "../snippets/snippets";
import type { LocalSnippetData, LocalSnippetEntry, LocalSnippetItem } from "../settings/settings";
import { parseSnippetObjects } from "../snippets/parse";
import { sortSnippets } from "../snippets/sort";
import { openLocalSnippetCreateModal } from "./local_snippets_ui";

/**
 * Store for local (document- and tag-scoped) snippets.
 *
 * Every local snippet is one *item* that optionally binds to a note (`file`)
 * and/or a tag (`tag`). Items are stored as a flat list inside the plugin
 * settings and are only merged into the snippet list at match time: on every
 * key press the core code asks this store for the items that apply to the
 * active note (its file-bound items first, then the items bound to each tag
 * the note carries) and tries those before the global snippets. When there
 * are no local snippets at all - the common case - nothing is looked up and
 * there is no overhead.
 *
 * Raw items are parsed into `Snippet` instances lazily (cached per matching
 * context until the next mutation) with the exact same parser used for global
 * snippets, so all snippet semantics (options, ${VISUAL}, placeholders,
 * auto/manual triggering) apply unchanged.
 *
 * Older versions stored local snippets as two maps (`byFile` / `byTag`); that
 * shape is migrated to the flat item list on the fly.
 */
export class LocalSnippetStore {
	// bumped whenever the raw data changes; invalidates the parse caches
	private revision = 0;
	private cache = new Map<string, Snippet[]>();
	// cm6 EditorView -> note path, refreshed on layout changes
	private viewPaths = new WeakMap<object, string>();

	constructor(readonly plugin: LatexSuitePlugin) {}

	/**
	 * Refresh the EditorView -> note-path index by scanning all markdown
	 * leaves. Called on plugin load and whenever Obsidian reports a layout
	 * change (pane splits, tab switches, renames, ...). Kept as a fallback
	 * the DOM `data-path` walk below, because that attribute is not present
	 * in every Obsidian view.
	 */
	indexViews() {
		this.viewPaths = new WeakMap();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const editor = leaf.view.editor as { cm?: object } | undefined;
			const cm = editor?.cm;
			if (cm && leaf.view.file) {
				this.viewPaths.set(cm, leaf.view.file.path);
			}
		});
	}

	/** The normalized local snippet items (a fresh copy; never mutated in place). */
	get items(): LocalSnippetItem[] {
		return normalizeData(this.plugin.settings.localSnippets).items;
	}

	isEmpty(): boolean {
		return this.items.length === 0;
	}

	// ------------------------------------------------------------------ //
	// Context resolution: which file is `view` editing, and its tags      //
	// ------------------------------------------------------------------ //

	/** Vault path of the note edited by `view`, or null when undeterminable. */
	pathOfView(view: EditorView): string | null {
		const cached = this.viewPaths.get(view);
		if (cached !== undefined) return cached || null;

		// Fallback: some Obsidian views carry the note path as data-path on an
		// ancestor element (e.g. .markdown-source-view).
		let el: HTMLElement | null = view.dom.parentElement;
		while (el) {
			if (el.hasAttribute && el.hasAttribute("data-path")) {
				const path = el.getAttribute("data-path");
				if (path) {
					this.viewPaths.set(view, path);
					return path;
				}
			}
			el = el.parentElement;
		}
		this.viewPaths.set(view, "");
		return null;
	}

	/** Tags of the note at `path` (frontmatter `tags` + inline `#tags`). */
	tagsOfPath(path: string): string[] {
		const tags = new Set<string>();
		const abstractFile = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(abstractFile instanceof TFile) || abstractFile.extension !== "md") {
			return [];
		}
		const cache = this.plugin.app.metadataCache.getFileCache(abstractFile);

		const add = (tag: unknown) => {
			if (typeof tag !== "string") return;
			const cleaned = tag.trim().replace(/^#+/, "");
			if (cleaned) tags.add(cleaned);
		};

		// Frontmatter: `tags: [a, b]` or `tags: a, b` (string or list)
		const fmTags = (cache?.frontmatter as Record<string, unknown> | undefined)?.tags;
		if (typeof fmTags === "string") {
			for (const tag of fmTags.split(/[\s,]+/)) add(tag);
		} else if (Array.isArray(fmTags)) {
			for (const tag of fmTags) add(tag);
		}
		// Inline tags, e.g. `#foo` (stored with a leading `#`)
		for (const t of cache?.tags ?? []) add(t.tag);

		return Array.from(tags).sort();
	}

	// ------------------------------------------------------------------ //
	// Lookup used by the snippet engine on every keypress                 //
	// ------------------------------------------------------------------ //

	getSnippetsFor(view: EditorView): Snippet[] {
		if (this.isEmpty()) return [];
		const path = this.pathOfView(view);
		if (!path) return [];

		const tags = this.tagsOfPath(path);
		return this.parseContext(path, tags);
	}

	/**
	 * Applicable items for a note: file-bound items first, then the items
	 * bound to each of the note's tags (in tag-name order). An item bound to
	 * both the note and one of its tags is only counted once (in the file
	 * bucket), keeping the "file beats tag" override rule; an item bound to
	 * several of the note's tags is likewise counted once, at its first
	 * matching tag.
	 */
	applicableItems(filePath: string, tags: string[]): LocalSnippetItem[] {
		const items = this.items;
		const selected: LocalSnippetItem[] = [];
		const seen = new Set<number>();

		for (let i = 0; i < items.length; i++) {
			if (items[i].file === filePath) {
				selected.push(items[i]);
				seen.add(i);
			}
		}
		for (const tag of [...tags].sort()) {
			for (let i = 0; i < items.length; i++) {
				if (seen.has(i)) continue;
				if (items[i].tags?.includes(tag)) {
					selected.push(items[i]);
					seen.add(i);
				}
			}
		}
		return selected;
	}

	private parseContext(filePath: string, tags: string[]): Snippet[] {
		const cacheKey = `${this.revision}\u0000${filePath}\u0000${[...tags].sort().join("\u0001")}`;
		const cached = this.cache.get(cacheKey);
		if (cached !== undefined) return cached;

		const parsed = parseEntries(this.applicableItems(filePath, tags));
		this.cache.set(cacheKey, parsed);
		return parsed;
	}

	// ------------------------------------------------------------------ //
	// Mutations (called by the UI / plugin events)                        //
	// ------------------------------------------------------------------ //

	/** Replace the whole local snippet list; persists the settings. */
	async saveItems(items: LocalSnippetItem[]) {
		this.commitAndSave({ items });
	}

	/** Unbind every item of a deleted note; drop items left without bindings. */
	async removeFileSnippets(path: string) {
		const items: LocalSnippetItem[] = [];
		for (const it of this.items) {
			if (it.file !== path) {
				items.push(it);
				continue;
			}
			// the note is gone: strip the file binding, but keep the item if
			// it is still bound to at least one tag
			const { file: _gone, ...rest } = it;
			void _gone;
			if (rest.tags && rest.tags.length) items.push(rest as LocalSnippetItem);
		}
		this.commitAndSave({ items });
	}

	/** Move the file binding when a note is renamed. */
	async renameFileSnippets(oldPath: string, newPath: string) {
		const items = this.items.map((item) =>
			item.file === oldPath ? { ...item, file: newPath } : item,
		);
		this.commitAndSave({ items });
	}

	/**
	 * Open the "create a local snippet" dialog for `view`. Returns false when
	 * there is nothing the snippet could be attached to.
	 */
	openCreateLocalSnippetModal(view: EditorView): boolean {
		const path = this.pathOfView(view);
		const abstractFile = path ? this.plugin.app.vault.getAbstractFileByPath(path) : null;
		if (!(abstractFile instanceof TFile) || abstractFile.extension !== "md") return false;

		const sel = view.state.selection.main;
		const prefill = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);

		openLocalSnippetCreateModal(this, abstractFile, prefill);
		return true;
	}

	private async commitAndSave(d: LocalSnippetData) {
		this.plugin.settings.localSnippets = d;
		this.revision++;
		this.cache.clear();
		await this.plugin.saveData(this.plugin.settings);
	}
}

// ---------------------------------------------------------------------- //
// Helpers                                                                //
// ---------------------------------------------------------------------- //

const cleanBinding = (v: unknown): string | undefined => {
	if (typeof v !== "string") return undefined;
	const cleaned = v.trim().replace(/^#+/, "");
	return cleaned || undefined;
};

function normalizeEntry(raw: unknown): LocalSnippetEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.trigger !== "string" || typeof e.replacement !== "string") return null;
	const options = typeof e.options === "string" ? e.options : "";
	const priority = typeof e.priority === "number" && Number.isFinite(e.priority) ? e.priority : undefined;
	const description = typeof e.description === "string" && e.description ? e.description : undefined;
	return {
		trigger: e.trigger,
		replacement: e.replacement,
		options,
		...(priority !== undefined && { priority }),
		...(description !== undefined && { description }),
	};
}

function normalizeTags(raw: unknown, single?: unknown): string[] | undefined {
	const tags = new Set<string>();
	const add = (v: unknown) => {
		const cleaned = cleanBinding(v);
		if (cleaned) tags.add(cleaned);
	};
	if (Array.isArray(raw)) for (const t of raw) add(t);
	else add(raw);
	add(single);
	return tags.size ? Array.from(tags) : undefined;
}

function normalizeItem(raw: unknown): LocalSnippetItem | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	const entry = normalizeEntry(e);
	if (!entry) return null;
	const file = cleanBinding(e.file);
	// accept both the current `tags` list and the older single `tag` field
	const tags = normalizeTags(e.tags, e.tag);
	if (file === undefined && tags === undefined) return null;
	return { ...entry, ...(file !== undefined && { file }), ...(tags !== undefined && { tags }) };
}

function normalizeItems(raw: unknown): LocalSnippetItem[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(normalizeItem).filter((i): i is LocalSnippetItem => i !== null);
}

/**
 * Normalize whatever is stored under `localSnippets` into the flat item list,
 * migrating the legacy `{ byFile: {...}, byTag: {...} }` layout if needed.
 */
function normalizeData(raw: unknown): LocalSnippetData {
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

	if (Array.isArray(src.items)) {
		return { items: normalizeItems(src.items) };
	}

	// legacy layout: { byFile: Record<path, entry[]>, byTag: Record<tag, entry[]> }
	const items: LocalSnippetItem[] = [];
	const byFile = src.byFile as Record<string, unknown> | undefined;
	if (byFile && typeof byFile === "object") {
		for (const [path, list] of Object.entries(byFile)) {
			if (!path || !Array.isArray(list)) continue;
			for (const rawEntry of list) {
				const entry = normalizeEntry(rawEntry);
				if (entry) items.push({ ...entry, file: path });
			}
		}
	}
	const byTag = src.byTag as Record<string, unknown> | undefined;
	if (byTag && typeof byTag === "object") {
		for (const [tag, list] of Object.entries(byTag)) {
			if (!tag || !Array.isArray(list)) continue;
			const tags = normalizeTags(tag.replace(/^#+/, ""));
			if (!tags) continue;
			for (const rawEntry of list) {
				const entry = normalizeEntry(rawEntry);
				if (entry) items.push({ ...entry, tags });
			}
		}
	}
	return { items };
}

/** Parse raw items into Snippet instances (invalid items are skipped). */
function parseEntries(items: LocalSnippetItem[]): Snippet[] {
	const parsed: Snippet[] = [];
	for (const item of items) {
		try {
			parsed.push(...parseSnippetObjects([item]));
		} catch (e) {
			console.error("Failed to parse local snippet, skipping:", item, e);
		}
	}
	// Same ordering rules as the global snippet list: priority, then trigger
	// length, then original order.
	return sortSnippets(parsed);
}

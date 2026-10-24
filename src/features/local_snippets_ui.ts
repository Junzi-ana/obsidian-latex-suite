import { MarkdownView, Modal, Notice, setIcon, TFile } from "obsidian";
import type {
	LocalSnippetConditional,
	LocalSnippetConditionalRule,
	LocalSnippetItem,
} from "../settings/settings";
import type { LocalSnippetStore } from "./local_snippets";
import { parseSnippetObjects } from "../snippets/parse";
import {
	buildConditionalSource,
	compileReplacementFn,
	countCaptureGroups,
	parseConditionalSource,
	previewConditional,
} from "./local_snippet_conditional";
import {
	bindTag,
	confirmAction,
	copyItems,
	deleteItems,
	moveItems,
	pickMarkdownFile,
	unbindItems,
} from "./local_snippets_bulk";
import type { BulkKind, BulkOutcome } from "./local_snippets_bulk";

const OPTIONS_HELP =
	"A=自动 · r=正则 · w=词边界 · v=visual · U=关撤销 | 模式: m/M/n 数学(块/块/行内) t=文本 c/C=代码块/代码 | 留空=任意位置";

type Mode = "new" | "edit" | "bulk";

const BULK_LABELS: Array<{ kind: BulkKind; label: string }> = [
	{ kind: "move", label: "移动到…" },
	{ kind: "copy", label: "复制到…" },
	{ kind: "tag", label: "绑定标签" },
	{ kind: "unbind", label: "解除绑定" },
	{ kind: "delete", label: "删除" },
];

/**
 * Combined window for local snippets: left = create / edit form (or, in bulk
 * mode, the batch panel), right = the list grouped by the note and/or tags
 * each item is bound to.
 *
 * Bindings are independent: an item may bind to the current note, to any
 * number of tags, or both (at least one binding is required). Because
 * bindings are attributes of the item they can be changed later, one by one
 * or in bulk.
 *
 * Bulk mode exists because "which note/tag should this belong to?" is often
 * answered only later: it lets several items be moved, copied, tagged,
 * unbound or deleted at once, while the left pane carries the target picker.
 *
 * Conditioned entries (the collapsible "高级 · 条件化匹配" section) describe
 * several variants with one regex trigger: the text captured by the first
 * capturing group selects a row from a table. A miss does nothing at all.
 */
class LocalSnippetWorkspaceModal extends Modal {
	private mode: Mode = "new";
	private editKey = ""; // identity of the item being edited

	// bindings (independent of each other)
	private bindFile = false;
	private bindTags: string[] = [];
	private tagCustomOpen = false;
	private customDraft = "";

	// form field values
	private triggerText = "";
	private optionsText = "mA";
	private priorityText = "";
	private descriptionText = "";
	private replacementText = "";

	// conditioned matching
	private condOpen = false;
	private condEnabled = false;
	private condAdvanced = false;
	private condRules: LocalSnippetConditionalRule[] = [];
	private condGroup = 0; // 0-based index of the capturing group the table keys come from
	private condSource = "";
	private liveEl: HTMLElement | null = null;

	// list state
	private searchQuery = "";
	private collapsed = new Set<string>();
	private selected = new Set<number>();
	private bulkKind: BulkKind = "move";
	private bulkTargetPath: string | null = null;
	private bulkKeepTags = true;
	private bulkTag = "";
	private bulkTagDraft = "";
	private bulkTagCustomOpen = false;
	private bulkDropFile = false;
	private bulkUnbindFile = false;
	private bulkUnbindTags = new Set<string>();

	private baseFile: TFile | null;
	private prefill: string;
	private origFile: string | undefined; // file binding of the item being edited
	private origReplacement = "";

	private headEl!: HTMLElement;
	private leftEl!: HTMLElement;
	private rightEl!: HTMLElement;

	constructor(
		private store: LocalSnippetStore,
		opts: { baseFile?: TFile | null; prefill?: string } = {},
	) {
		super(store.plugin.app);
		this.baseFile =
			opts.baseFile ??
			this.store.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file ??
			null;
		this.prefill = opts.prefill ?? "";
		this.replacementText = this.prefill;
		this.bindFile = !!this.baseFile;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("latex-suite-local-workspace-modal");
		modalEl.style.width = "min(96vw, 1080px)";

		// the header gets re-rendered (e.g. after save/delete to refresh the
		// counts); keep it in one dedicated container so it never duplicates
		this.headEl = contentEl.createDiv();
		this.renderHeader();
		const layout = contentEl.createDiv({ cls: "ls-layout" });
		this.leftEl = layout.createDiv({ cls: "ls-left" });
		this.rightEl = layout.createDiv({ cls: "ls-right" });

		this.renderLeft();
		this.renderList();
		this.focusTrigger();
	}

	// ------------------------------------------------------------------ //
	// Header                                                             //
	// ------------------------------------------------------------------ //

	private renderHeader() {
		const el = this.headEl;
		if (!el) return;
		el.empty();
		const head = el.createDiv({ cls: "ls-head" });
		const titles = head.createDiv({ cls: "ls-head-titles" });
		titles.createDiv({ cls: "ls-title" }).setText("局部 Snippets");
		titles.createDiv({ cls: "ls-subtitle" }).setText(
			this.mode === "bulk"
				? "批量模式：右侧勾选条目，左侧选择要执行的动作；点『完成』返回单条编辑。"
				: "左侧新建/编辑；绑定可同时包含『此文件』与多个标签；右侧点击条目即载入左侧。",
		);
		const items = this.store.items;
		const files = new Set<string>();
		const tags = new Set<string>();
		for (const it of items) {
			if (it.file) files.add(it.file);
			for (const t of it.tags ?? []) tags.add(t);
		}
		head
			.createDiv({ cls: "ls-stats" })
			.setText(`文档 ${files.size} · 标签 ${tags.size} · 共 ${items.length} 条`);
	}

	// ------------------------------------------------------------------ //
	// List (right)                                                       //
	// ------------------------------------------------------------------ //

	/** The three panes all need refreshing when selection or mode changes. */
	private rerenderAll() {
		this.renderHeader();
		this.renderLeft();
		this.renderList();
	}

	/** A styled checkbox span; the click handler stays with the caller. */
	private makeCheckbox(parent: HTMLElement, checked: boolean, opts?: { partial?: boolean; title?: string; extraCls?: string }): HTMLElement {
		const base = `ls-bind-check${opts?.extraCls ? ` ${opts.extraCls}` : ""}`;
		const cls = `${base}${checked ? " is-checked" : opts?.partial ? " is-partial" : ""}`;
		const box = parent.createSpan(opts?.title ? { cls, attr: { title: opts.title } } : { cls });
		if (checked) setIcon(box.createSpan({ cls: "ls-bind-tick" }), "check");
		else if (opts?.partial) setIcon(box.createSpan({ cls: "ls-bind-tick" }), "minus");
		return box;
	}

	private renderList() {
		const { rightEl } = this;
		const scrollTop = rightEl.scrollTop;
		rightEl.empty();

		const toolbar = rightEl.createDiv({ cls: "ls-toolbar" });
		const searchBox = toolbar.createDiv({ cls: "ls-search" });
		const icon = searchBox.createSpan({ cls: "ls-search-icon" });
		setIcon(icon, "search");
		const input = searchBox.createEl("input", {
			cls: "ls-search-input",
			attr: { type: "text", placeholder: "过滤 trigger / options / replacement…" },
		});
		input.value = this.searchQuery;
		input.addEventListener("input", () => {
			this.searchQuery = input.value;
			this.renderList();
			window.setTimeout(() => {
				const box = this.rightEl.querySelector<HTMLInputElement>(".ls-search-input");
				if (box) {
					box.focus();
					box.setSelectionRange(box.value.length, box.value.length);
				}
			}, 0);
		});

		const tools = toolbar.createDiv({ cls: "ls-tools" });
		if (this.mode === "bulk") {
			const all = tools.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "全选" });
			all.addEventListener("click", () => {
				for (const index of this.visibleIndices()) this.selected.add(index);
				this.rerenderAll();
			});
			const none = tools.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "清除" });
			none.addEventListener("click", () => {
				this.selected.clear();
				this.rerenderAll();
			});
			const done = tools.createEl("button", { cls: "ls-btn ls-btn-light", text: "完成" });
			done.addEventListener("click", () => this.exitBulk());
		} else {
			const edit = tools.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "编辑" });
			edit.setAttribute("title", "进入批量模式：勾选多条后统一移动 / 复制 / 绑定标签 / 删除");
			edit.addEventListener("click", () => this.enterBulk());
		}

		const foldAll = tools.createEl("button", {
			cls: "ls-btn ls-btn-icon",
			attr: { title: "全部折叠 / 展开" },
		});
		setIcon(foldAll, "chevrons-up-down");
		foldAll.addEventListener("click", () => this.toggleAllGroups());

		if (this.searchQuery) {
			const clear = tools.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "清除筛选" });
			clear.addEventListener("click", () => {
				this.searchQuery = "";
				this.renderList();
			});
		}

		const items = this.store.items;
		this.pruneSelection(items.length);

		if (!items.length) {
			rightEl.createDiv({ cls: "ls-empty" }).setText(
				"还没有局部 Snippet —— 在左侧填好 trigger / options，选好绑定后点『保存』即可。",
			);
			rightEl.scrollTop = scrollTop;
			return;
		}

		const query = this.searchQuery.toLowerCase();
		const matches = (it: LocalSnippetItem) =>
			!query ||
			(
				it.trigger +
				"\n" +
				it.options +
				"\n" +
				(it.description ?? "") +
				"\n" +
				it.replacement +
				"\n" +
				(it.replacementFn ?? "") +
				"\n" +
				(it.conditional?.rules ?? []).map((r) => `${r.key} ${r.output}`).join("\n")
			)
				.toLowerCase()
				.includes(query);

		let shown = 0;

		const addGroup = (
			kind: "文档" | "标签",
			scopeKey: string,
			entries: Array<{ item: LocalSnippetItem; index: number }>,
			note?: TFile | null,
		) => {
			const filtered = entries.filter((entry) => matches(entry.item));
			if (!filtered.length) return;
			shown += filtered.length;

			const groupKey = `${kind === "文档" ? "file" : "tag"}:${scopeKey}`;
			const isCollapsed = !this.searchQuery && this.collapsed.has(groupKey);

			const group = rightEl.createDiv({ cls: "ls-group" });
			const groupHead = group.createDiv({ cls: "ls-group-head" });
			groupHead.setAttribute("title", isCollapsed ? "展开分组" : "折叠分组");

			const caret = groupHead.createSpan({ cls: `ls-caret${isCollapsed ? " is-collapsed" : ""}` });
			setIcon(caret, isCollapsed ? "chevron-right" : "chevron-down");

			if (this.mode === "bulk") {
				const indices = filtered.map((entry) => entry.index);
				const selectedCount = indices.filter((index) => this.selected.has(index)).length;
				const box = this.makeCheckbox(groupHead, selectedCount === indices.length, {
					partial: selectedCount > 0 && selectedCount < indices.length,
					title: "选中 / 取消整组",
				});
				box.addEventListener("click", (ev) => {
					ev.stopPropagation();
					const allSelected = selectedCount === indices.length;
					for (const index of indices) {
						if (allSelected) this.selected.delete(index);
						else this.selected.add(index);
					}
					this.rerenderAll();
				});
			}

			const ident = groupHead.createDiv({ cls: "ls-group-ident" });
			ident.createSpan({ cls: `ls-group-kind ls-kind-${kind === "文档" ? "file" : "tag"}` }).setText(kind);
			const name = ident.createSpan({ cls: "ls-group-name" });
			if (kind === "文档") {
				name.setText(note ? note.basename : scopeKey);
				if (note) {
					const open = ident.createEl("a", { cls: "ls-group-open", text: "打开" });
					open.addEventListener("click", (ev) => {
						ev.stopPropagation();
						void this.store.plugin.app.workspace.getLeaf(false).openFile(note);
					});
				}
			} else {
				name.setText(`#${scopeKey}`);
			}
			groupHead.createSpan({ cls: "ls-group-count" }).setText(String(filtered.length));

			groupHead.addEventListener("click", () => {
				if (this.collapsed.has(groupKey)) this.collapsed.delete(groupKey);
				else this.collapsed.add(groupKey);
				this.renderList();
			});

			if (isCollapsed) return;

			filtered.forEach(({ item, index }) => {
				const isEditing = this.mode === "edit" && this.editKey === this.itemKey(item);
				const isChecked = this.mode === "bulk" && this.selected.has(index);
				const row = group.createDiv({
					cls: `ls-item${isEditing ? " is-selected" : ""}${isChecked ? " is-checked" : ""}${this.mode === "bulk" ? " is-bulk" : ""}`,
				});

				if (this.mode === "bulk") {
					this.makeCheckbox(row, isChecked, { extraCls: "ls-item-check" });
				}

				const del = row.createEl("button", {
					cls: "ls-item-del",
					attr: { title: "删除条目（连同它的全部绑定）" },
				});
				setIcon(del, "trash-2");
				del.addEventListener("click", (ev) => {
					ev.stopPropagation();
					void this.deleteItem(item);
				});

				row.createSpan({ cls: "ls-item-trigger" }).setText(item.trigger);

				const meta: string[] = [];
				if (item.options) meta.push(item.options);
				if (item.priority !== undefined) meta.push(`p${item.priority}`);
				if (item.replacementFn) meta.push("条件化");
				row.createSpan({ cls: "ls-item-meta" }).setText(meta.join(" · "));

				if (item.description) row.createSpan({ cls: "ls-item-desc" }).setText(item.description);
				row.createSpan({ cls: "ls-item-preview" }).setText(this.previewOf(item));

				// indicate the *other* binding(s) when listed inside one group
				const extra: string[] = [];
				const otherTags = (item.tags ?? []).filter((t) => t !== scopeKey);
				if (kind === "文档" && otherTags.length) {
					extra.push(`同时绑定标签 ${otherTags.map((t) => `#${t}`).join("、")}`);
				}
				if (kind === "标签") {
					if (item.file) extra.push("同时绑定此文件");
					if (otherTags.length) extra.push(`也绑定 ${otherTags.map((t) => `#${t}`).join("、")}`);
				}
				if (extra.length) row.createSpan({ cls: "ls-item-scope" }).setText(extra.join(" · "));

				row.addEventListener("click", () => {
					if (this.mode === "bulk") {
						if (this.selected.has(index)) this.selected.delete(index);
						else this.selected.add(index);
						this.rerenderAll();
					} else {
						this.startEditing(item);
					}
				});
			});
		};

		// group by file bindings, then by tag bindings (insertion order)
		const seenFiles = new Set<string>();
		const seenTags = new Set<string>();
		for (const it of items) {
			if (it.file && !seenFiles.has(it.file)) seenFiles.add(it.file);
			for (const t of it.tags ?? []) if (!seenTags.has(t)) seenTags.add(t);
		}
		const fileScopes = [...seenFiles].sort();
		const tagScopes = [...seenTags].sort();
		const byFile = (f: string) =>
			items.map((item, index) => ({ item, index })).filter((entry) => entry.item.file === f);
		const byTag = (t: string) =>
			items
				.map((item, index) => ({ item, index }))
				.filter((entry) => entry.item.tags?.includes(t));

		if (fileScopes.length) {
			rightEl.createEl("h4", { text: "按文档" });
			for (const path of fileScopes) {
				addGroup("文档", path, byFile(path), this.fileAt(path));
			}
		}
		if (tagScopes.length) {
			rightEl.createEl("h4", { text: "按标签" });
			for (const tag of tagScopes) {
				addGroup("标签", tag, byTag(tag));
			}
		}
		if (!shown) rightEl.createDiv({ cls: "ls-empty" }).setText("没有匹配的局部 Snippet。");

		rightEl.scrollTop = scrollTop;
	}

	/** Indices currently rendered (respecting the search filter). */
	private visibleIndices(): number[] {
		const query = this.searchQuery.toLowerCase();
		const indices: number[] = [];
		this.store.items.forEach((item, index) => {
			if (!query) {
				indices.push(index);
				return;
			}
			const blob = `${item.trigger}\n${item.options}\n${item.description ?? ""}\n${item.replacement}\n${item.replacementFn ?? ""}`;
			if (blob.toLowerCase().includes(query)) indices.push(index);
		});
		return indices;
	}

	private pruneSelection(count: number) {
		for (const index of [...this.selected]) {
			if (index >= count) this.selected.delete(index);
		}
	}

	private toggleAllGroups() {
		const keys: string[] = [];
		const seenFiles = new Set<string>();
		const seenTags = new Set<string>();
		for (const item of this.store.items) {
			if (item.file && !seenFiles.has(item.file)) seenFiles.add(item.file);
			for (const tag of item.tags ?? []) if (!seenTags.has(tag)) seenTags.add(tag);
		}
		for (const path of seenFiles) keys.push(`file:${path}`);
		for (const tag of seenTags) keys.push(`tag:${tag}`);
		const allCollapsed = keys.length > 0 && keys.every((key) => this.collapsed.has(key));
		if (allCollapsed) this.collapsed.clear();
		else for (const key of keys) this.collapsed.add(key);
		this.renderList();
	}

	private fileAt(path: string): TFile | null {
		const abstractFile = this.store.plugin.app.vault.getAbstractFileByPath(path);
		return abstractFile instanceof TFile ? abstractFile : null;
	}

	private itemKey(item: LocalSnippetItem): string {
		return JSON.stringify([
			item.file ?? null,
			[...(item.tags ?? [])].sort(),
			item.trigger,
			item.options,
			item.replacement,
			item.replacementFn ?? null,
		]);
	}

	/** Row preview: plain replacement, or the rule table's first rows. */
	private previewOf(item: LocalSnippetItem): string {
		const rules = item.conditional?.rules;
		if (rules?.length) {
			const shown = rules.slice(0, 3).map((rule) => `${rule.key} → ${rule.output}`);
			if (rules.length > 3) shown.push(`…+${rules.length - 3}`);
			return shown.join("  ");
		}
		return this.preview(item.replacement);
	}

	private preview(text: string): string {
		const oneLine = text.replace(/\n/g, " ");
		return oneLine.length > 120 ? oneLine.slice(0, 117) + "…" : oneLine;
	}

	// ------------------------------------------------------------------ //
	// Editing state                                                      //
	// ------------------------------------------------------------------ //

	private startEditing(item: LocalSnippetItem) {
		this.mode = "edit";
		this.editKey = this.itemKey(item);
		this.origFile = item.file;
		this.origReplacement = item.replacement;
		this.triggerText = item.trigger;
		this.optionsText = item.options;
		this.priorityText = item.priority !== undefined ? String(item.priority) : "";
		this.descriptionText = item.description ?? "";
		this.replacementText = item.replacement;
		this.bindFile = !!item.file;
		this.bindTags = item.tags ? [...item.tags] : [];
		this.tagCustomOpen = false;
		this.customDraft = "";

		// restore the conditioned view: prefer the stored table, fall back to
		// the generated source, and finally to the hand-written editor
		const storedRules = item.conditional?.rules;
		if (storedRules?.length) {
			this.condEnabled = true;
			this.condOpen = true;
			this.condAdvanced = false;
			this.condRules = storedRules.map((rule) => ({ ...rule }));
			this.condGroup = item.conditional?.group ?? 0;
			this.condSource = "";
		} else if (item.replacementFn) {
			const parsed = parseConditionalSource(item.replacementFn);
			this.condEnabled = true;
			this.condOpen = true;
			this.condRules = parsed ? parsed.rules : [];
			this.condGroup = parsed?.group ?? 0;
			this.condAdvanced = !parsed;
			this.condSource = parsed ? "" : item.replacementFn;
		} else {
			this.resetConditional();
		}

		this.renderLeft();
		this.renderList();
	}

	private resetConditional() {
		this.condOpen = false;
		this.condEnabled = false;
		this.condAdvanced = false;
		this.condRules = [];
		this.condGroup = 0;
		this.condSource = "";
		this.liveEl = null;
	}

	/** Reset to "new" mode; content cleared, bindings kept for chaining. */
	private resetToNew() {
		this.mode = "new";
		this.editKey = "";
		this.triggerText = "";
		this.optionsText = "mA";
		this.priorityText = "";
		this.descriptionText = "";
		this.replacementText = "";
		this.origReplacement = "";
		this.tagCustomOpen = false;
		this.customDraft = "";
		this.resetConditional();
		this.rerenderAll();
		this.focusTrigger();
	}

	private focusTrigger() {
		window.setTimeout(() => {
			this.leftEl.querySelector<HTMLInputElement>(".ls-field-trigger input")?.focus();
		}, 30);
	}

	private renderLeft() {
		if (this.mode === "bulk") this.renderBulkPanel();
		else this.renderForm();
	}

	// ------------------------------------------------------------------ //
	// Bulk mode                                                          //
	// ------------------------------------------------------------------ //

	private enterBulk() {
		this.mode = "bulk";
		this.selected.clear();
		this.bulkKind = "move";
		this.bulkTargetPath = null;
		this.bulkTag = "";
		this.bulkTagDraft = "";
		this.bulkTagCustomOpen = false;
		this.bulkDropFile = false;
		this.bulkUnbindFile = false;
		this.bulkUnbindTags.clear();
		this.rerenderAll();
	}

	private exitBulk() {
		this.mode = "new";
		this.selected.clear();
		this.rerenderAll();
		this.focusTrigger();
	}

	private renderBulkPanel() {
		const left = this.leftEl;
		left.empty();

		const selectedCount = this.selected.size;
		const paneHead = left.createDiv({ cls: "ls-pane-head" });
		paneHead.createSpan({ cls: "ls-pane-title" }).setText("批量编辑");
		paneHead.createSpan({ cls: "ls-scope-pill" }).setText(`已选 ${selectedCount} 条`);

		const body = left.createDiv({ cls: "ls-body" });

		const seg = body.createDiv({ cls: "ls-seg ls-seg-wide" });
		for (const option of BULK_LABELS) {
			const btn = seg.createEl("button", {
				cls: `ls-seg-btn${this.bulkKind === option.kind ? " is-active" : ""}`,
				text: option.label,
			});
			btn.addEventListener("click", () => {
				this.bulkKind = option.kind;
				this.renderLeft();
			});
		}

		if (this.bulkKind === "move" || this.bulkKind === "copy") {
			const targetRow = body.createDiv({ cls: "ls-bulk-target" });
			targetRow.createSpan({ cls: "ls-field-label" }).setText("目标文档");
			const targetName = this.bulkTargetPath
				? this.bulkTargetPath.replace(/\.md$/i, "")
				: "未选择";
			targetRow
				.createSpan({ cls: `ls-bulk-target-name${this.bulkTargetPath ? "" : " is-empty"}` })
				.setText(targetName);
			const pick = targetRow.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "选择…" });
			pick.addEventListener("click", () => {
				void (async () => {
					const file = await pickMarkdownFile(this.store.plugin.app);
					if (!file) return;
					this.bulkTargetPath = file.path;
					this.renderLeft();
				})();
			});

			const keepTags = body.createDiv({ cls: "ls-bind-row" });
			const check = keepTags.createEl("button", {
				cls: `ls-bind-check${this.bulkKeepTags ? " is-checked" : ""}`,
				attr: { type: "button" },
			});
			if (this.bulkKeepTags) setIcon(check.createSpan({ cls: "ls-bind-tick" }), "check");
			const toggle = () => {
				this.bulkKeepTags = !this.bulkKeepTags;
				this.renderLeft();
			};
			check.addEventListener("click", toggle);
			const label = keepTags.createEl("span", { cls: "ls-bind-label", text: "保留标签绑定" });
			label.addEventListener("click", toggle);

			body.createDiv({ cls: "ls-bind-note" }).setText(
				this.bulkKind === "move"
					? "把所选条目的文件绑定换成目标文档；原标题下的同一条目会跟着消失。"
					: "在目标文档下新增副本，原条目保持不变。",
			);
		}

		if (this.bulkKind === "tag") {
			body.createDiv({ cls: "ls-field-label" }).setText("追加标签（不影响已有绑定）");
			const tags = this.bulkTagCandidates();
			const chips = body.createDiv({ cls: "ls-chips" });
			for (const tag of tags) {
				const active = this.bulkTag === tag;
				const chip = chips.createEl("button", {
					cls: `ls-chip${active ? " is-active" : ""}`,
					text: `#${tag}`,
				});
				chip.addEventListener("click", () => {
					this.bulkTag = active ? "" : tag;
					this.renderLeft();
				});
			}
			const customChip = chips.createEl("button", { cls: "ls-chip ls-chip-custom", text: "＋ 自定义" });
			customChip.addEventListener("click", () => {
				this.bulkTagCustomOpen = true;
				this.renderLeft();
				window.setTimeout(() => {
					this.leftEl.querySelector<HTMLInputElement>(".ls-bulk-tag-input input")?.focus();
				}, 30);
			});
			if (this.bulkTagCustomOpen) {
				const wrap = body.createDiv({ cls: "ls-custom-tag ls-bulk-tag-input" });
				const custom = wrap.createEl("input", {
					cls: "ls-input ls-mono",
					attr: { type: "text", placeholder: "标签名（不带 #），回车确认" },
				});
				custom.value = this.bulkTagDraft;
				custom.addEventListener("input", () => (this.bulkTagDraft = custom.value));
				custom.addEventListener("keydown", (ev) => {
					if (ev.key !== "Enter") return;
					const value = this.bulkTagDraft.trim().replace(/^#+/, "");
					if (value) this.bulkTag = value;
					this.bulkTagCustomOpen = false;
					this.renderLeft();
				});
			}
			if (this.bulkTag) {
				body.createDiv({ cls: "ls-bind-note" }).setText(`将追加：#${this.bulkTag}`);
			}

			const dropRow = body.createDiv({ cls: "ls-bind-row" });
			const dropCheck = dropRow.createEl("button", {
				cls: `ls-bind-check${this.bulkDropFile ? " is-checked" : ""}`,
				attr: { type: "button" },
			});
			if (this.bulkDropFile) setIcon(dropCheck.createSpan({ cls: "ls-bind-tick" }), "check");
			const dropToggle = () => {
				this.bulkDropFile = !this.bulkDropFile;
				this.renderLeft();
			};
			dropCheck.addEventListener("click", dropToggle);
			const dropLabel = dropRow.createEl("span", {
				cls: "ls-bind-label",
				text: "同时解除文件绑定（改为纯标签绑定）",
			});
			dropLabel.addEventListener("click", dropToggle);
		}

		if (this.bulkKind === "unbind") {
			const hasFile = this.selectedItems().some((item) => item.file !== undefined);
			const fileRow = body.createDiv({ cls: "ls-bind-row" });
			const fileCheck = fileRow.createEl("button", {
				cls: `ls-bind-check${this.bulkUnbindFile ? " is-checked" : ""}`,
				attr: { type: "button" },
			});
			if (this.bulkUnbindFile) setIcon(fileCheck.createSpan({ cls: "ls-bind-tick" }), "check");
			const fileToggle = () => {
				this.bulkUnbindFile = !this.bulkUnbindFile;
				this.renderLeft();
			};
			fileCheck.addEventListener("click", fileToggle);
			const fileLabel = fileRow.createEl("span", { cls: "ls-bind-label", text: "解除文件绑定" });
			fileLabel.addEventListener("click", fileToggle);
			if (!hasFile) fileRow.createSpan({ cls: "ls-bind-note" }).setText("（所选条目没有文件绑定）");

			const knownTags = this.bulkTagCandidates();
			if (knownTags.length) {
				body.createDiv({ cls: "ls-field-label" }).setText("解除这些标签");
				const chips = body.createDiv({ cls: "ls-chips" });
				for (const tag of knownTags) {
					const active = this.bulkUnbindTags.has(tag);
					const chip = chips.createEl("button", {
						cls: `ls-chip${active ? " is-active" : ""}`,
						text: `#${tag}`,
					});
					chip.addEventListener("click", () => {
						if (active) this.bulkUnbindTags.delete(tag);
						else this.bulkUnbindTags.add(tag);
						this.renderLeft();
					});
				}
			}
			body.createDiv({ cls: "ls-bind-note" }).setText(
				"解绑后若一条绑定都不剩，该条目会被跳过（请改用删除，避免它凭空消失）。",
			);
		}

		if (this.bulkKind === "delete") {
			body.createDiv({ cls: "ls-bind-note" }).setText(
				"删除条目连同它的全部绑定；同一件事在右侧行内垃圾桶按钮也能做。",
			);
		}

		const actions = left.createDiv({ cls: "ls-actions" });
		actions
			.createSpan({ cls: "ls-action-hint" })
			.setText(selectedCount ? "动作只作用于已勾选的条目" : "先在右侧勾选条目");
		const buttons = actions.createDiv({ cls: "ls-buttons" });
		const cancel = buttons.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "退出" });
		cancel.addEventListener("click", () => this.exitBulk());
		const apply = buttons.createEl("button", {
			cls: `ls-btn ${this.bulkKind === "delete" ? "ls-btn-danger" : "ls-btn-primary"}`,
			text: this.bulkKind === "delete" ? "删除所选" : "应用",
		});
		apply.addEventListener("click", () => void this.applyBulk());
	}

	private bulkTagCandidates(): string[] {
		const tags = new Set<string>();
		if (this.baseFile) for (const tag of this.store.tagsOfPath(this.baseFile.path)) tags.add(tag);
		for (const item of this.store.items) for (const tag of item.tags ?? []) tags.add(tag);
		for (const item of this.selectedItems()) for (const tag of item.tags ?? []) tags.add(tag);
		return [...tags].sort();
	}

	private selectedItems(): LocalSnippetItem[] {
		const items = this.store.items;
		return [...this.selected]
			.filter((index) => index < items.length)
			.sort((a, b) => a - b)
			.map((index) => items[index]);
	}

	private async applyBulk() {
		const items = this.store.items;
		const indices = [...this.selected].filter((index) => index < items.length).sort((a, b) => a - b);
		if (!indices.length) {
			new Notice("先勾选要处理的条目");
			return;
		}

		let outcome: BulkOutcome | undefined;
		switch (this.bulkKind) {
			case "move": {
				if (!this.bulkTargetPath) {
					new Notice("先选择目标文档");
					return;
				}
				outcome = moveItems(items, indices, this.bulkTargetPath, this.bulkKeepTags);
				break;
			}
			case "copy": {
				if (!this.bulkTargetPath) {
					new Notice("先选择目标文档");
					return;
				}
				outcome = copyItems(items, indices, this.bulkTargetPath, this.bulkKeepTags);
				break;
			}
			case "tag": {
				const tag = this.bulkTag.trim().replace(/^#+/, "") || this.bulkTagDraft.trim().replace(/^#+/, "");
				if (!tag) {
					new Notice("先选择或输入标签");
					return;
				}
				outcome = bindTag(items, indices, tag, this.bulkDropFile);
				break;
			}
			case "unbind": {
				if (!this.bulkUnbindFile && !this.bulkUnbindTags.size) {
					new Notice("先勾选要解除的绑定");
					return;
				}
				outcome = unbindItems(items, indices, {
					file: this.bulkUnbindFile,
					tags: [...this.bulkUnbindTags],
				});
				break;
			}
			case "delete": {
				const ok = await confirmAction(
					this.store.plugin.app,
					"删除局部 Snippet",
					`将删除 ${indices.length} 条局部 Snippet，连同它们的全部绑定。此操作不可撤销。`,
					"删除",
				);
				if (!ok) return;
				outcome = deleteItems(items, indices);
				break;
			}
		}

		if (!outcome) return;
		await this.store.saveItems(outcome.items);

		if (outcome.skipped.length) {
			const head = `已处理 ${outcome.affected} 条，跳过 ${outcome.skipped.length} 条：`;
			new Notice(`${head}\n${outcome.skipped.slice(0, 6).join("\n")}`, 9000);
		} else {
			new Notice(`已处理 ${outcome.affected} 条`);
		}
		this.exitBulk();
	}

	// ------------------------------------------------------------------ //
	// Form (left)                                                        //
	// ------------------------------------------------------------------ //

	private renderForm() {
		const left = this.leftEl;
		left.empty();

		const paneHead = left.createDiv({ cls: "ls-pane-head" });
		paneHead
			.createSpan({ cls: "ls-pane-title" })
			.setText(this.mode === "edit" ? "编辑 Snippet" : "新建 Snippet");
		if (this.mode === "edit") {
			paneHead.createSpan({ cls: "ls-scope-pill" }).setText(this.describeBindings());
		}

		const body = left.createDiv({ cls: "ls-body" });
		this.renderBindings(body);

		// trigger
		const fTrigger = body.createDiv({ cls: "ls-field ls-field-trigger" });
		fTrigger.createSpan({ cls: "ls-field-label" }).setText("trigger");
		const triggerInput = fTrigger.createEl("input", { cls: "ls-input ls-mono" });
		triggerInput.value = this.triggerText;
		triggerInput.addEventListener("input", () => {
			this.triggerText = triggerInput.value;
			this.refreshLive();
		});
		fTrigger
			.createSpan({ cls: "ls-field-hint" })
			.setText(
				this.condEnabled
					? "条件化：需含 1 个捕获组，例如 Ft([0g])；options 会自动补 r"
					: "输入这些字符即触发；逐字匹配，不用回车",
			);

		// options + priority in one row
		const optRow = body.createDiv({ cls: "ls-field-row" });
		const fOpt = optRow.createDiv({ cls: "ls-field ls-grow" });
		fOpt.createSpan({ cls: "ls-field-label" }).setText("options");
		const optInput = fOpt.createEl("input", { cls: "ls-input ls-mono" });
		optInput.value = this.optionsText;
		optInput.addEventListener("input", () => {
			this.optionsText = optInput.value;
			this.refreshLive();
		});
		const fPrio = optRow.createDiv({ cls: "ls-field ls-narrow" });
		fPrio.createSpan({ cls: "ls-field-label" }).setText("priority（可选）");
		const prioInput = fPrio.createEl("input", { cls: "ls-input ls-mono" });
		prioInput.value = this.priorityText;
		prioInput.addEventListener("input", () => (this.priorityText = prioInput.value));

		// description
		const fDesc = body.createDiv({ cls: "ls-field" });
		fDesc.createSpan({ cls: "ls-field-label" }).setText("description（可选）");
		const descInput = fDesc.createEl("input", { cls: "ls-input" });
		descInput.value = this.descriptionText;
		descInput.addEventListener("input", () => (this.descriptionText = descInput.value));

		// replacement, or the conditioned rule table that replaces it
		if (this.condEnabled) {
			this.renderConditionalBlock(body);
		} else {
			const fRepl = body.createDiv({ cls: "ls-field" });
			const replHead = fRepl.createDiv({ cls: "ls-repl-head" });
			replHead.createSpan({ cls: "ls-field-label" }).setText("replacement");
			replHead.createSpan({ cls: "ls-field-hint" }).setText("无需双写反斜杠；支持 $0 / ${1:x} / ${VISUAL}");
			const replArea = fRepl.createEl("textarea", { cls: "ls-input ls-mono ls-textarea" });
			replArea.value = this.replacementText;
			replArea.addEventListener("input", () => (this.replacementText = replArea.value));

			this.renderConditionalLauncher(body);
		}

		body.createDiv({ cls: "ls-options-hint" }).setText(OPTIONS_HELP);

		// actions
		const actions = left.createDiv({ cls: "ls-actions" });
		actions.createSpan({ cls: "ls-action-hint" }).setText(
			this.mode === "edit"
				? "另存 = 复制为新条目 · 保存 = 原位修改"
				: "保存后即可在右侧列表中看到它",
		);
		const buttons = actions.createDiv({ cls: "ls-buttons" });
		if (this.mode === "edit") {
			const saveAs = buttons.createEl("button", { cls: "ls-btn ls-btn-primary", text: "另存" });
			saveAs.addEventListener("click", () => void this.save(true));
		}
		const save = buttons.createEl("button", { cls: "ls-btn ls-btn-light", text: "保存" });
		save.addEventListener("click", () => void this.save(false));
	}

	// ---- conditioned matching ------------------------------------------ //

	/** Collapsed entry point shown when conditioning is off. */
	private renderConditionalLauncher(body: HTMLElement) {
		const launcher = body.createDiv({ cls: "ls-adv-launch" });
		const caret = launcher.createSpan({ cls: "ls-caret" });
		setIcon(caret, "chevron-right");
		launcher
			.createSpan({ cls: "ls-adv-launch-label" })
			.setText("高级 · 条件化匹配（一条 trigger 管多种写法）");
		launcher.addEventListener("click", () => {
			this.condOpen = true;
			this.condEnabled = true;
			// seed the table with whatever was typed as a plain replacement
			if (!this.condRules.length) {
				this.condRules = [{ key: "", output: this.replacementText }];
			} else if (!this.condRules[0].output.trim() && this.replacementText.trim()) {
				this.condRules[0].output = this.replacementText;
			}
			this.renderLeft();
			window.setTimeout(() => {
				this.leftEl.querySelector<HTMLInputElement>(".ls-rule-row:not(.ls-rule-head) input")?.focus();
			}, 30);
		});
	}

	private renderConditionalBlock(body: HTMLElement) {
		const box = body.createDiv({ cls: "ls-adv is-open" });
		const head = box.createDiv({ cls: "ls-adv-head" });
		const caret = head.createSpan({ cls: `ls-caret${this.condOpen ? "" : " is-collapsed"}` });
		setIcon(caret, this.condOpen ? "chevron-down" : "chevron-right");
		head.createSpan({ cls: "ls-adv-title" }).setText("高级 · 条件化匹配");
		head.createSpan({ cls: "ls-adv-badge" }).setText("已启用");
		const close = head.createEl("button", { cls: "ls-btn ls-btn-ghost ls-adv-close", text: "关闭" });
		close.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.condEnabled = false;
			this.condOpen = false;
			this.replacementText = this.origReplacement || this.condRules[0]?.output || "";
			this.renderLeft();
		});
		head.addEventListener("click", () => {
			this.condOpen = !this.condOpen;
			this.renderLeft();
		});

		if (!this.condOpen) return;

		box
			.createDiv({ cls: "ls-adv-desc" })
			.setText(
				"以 trigger 指定捕获组的文本为键查表（组别 0 = 第一个括号组）；命中则整条替换为右列文本，未命中什么都不做。输出里可用 [[0]]/[[1]] 引用各捕获组。",
			);

		if (this.condAdvanced) {
			const wrap = box.createDiv({ cls: "ls-field" });
			const label = wrap.createDiv({ cls: "ls-repl-head" });
			label.createSpan({ cls: "ls-field-label" }).setText("replacement 函数（手写 JS）");
			label
				.createSpan({ cls: "ls-field-hint" })
				.setText("形如 (m) => …；返回 false 表示不展开");
			const area = wrap.createEl("textarea", { cls: "ls-input ls-mono ls-textarea" });
			area.value = this.condSource;
			area.addEventListener("input", () => (this.condSource = area.value));

			const back = box.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "返回规则表" });
			back.addEventListener("click", () => {
				const parsed = parseConditionalSource(this.condSource);
				if (parsed) {
					this.condRules = parsed.rules;
					this.condGroup = parsed.group ?? 0;
					this.condAdvanced = false;
				} else {
					new Notice("这段 JS 不是『查表』形式，无法转回规则表；继续手写即可。");
				}
				this.renderLeft();
			});
			return;
		}

		const table = box.createDiv({ cls: "ls-rules" });
		const header = table.createDiv({ cls: "ls-rule-row ls-rule-head" });
		header.createSpan({ text: "组别" });
		header.createSpan({ text: "捕获值" });
		header.createSpan({ text: "输出（完整替换文本）" });
		header.createSpan({ text: "" });

		this.condRules.forEach((rule, index) => {
			const row = table.createDiv({ cls: "ls-rule-row" });

			// the group index is shared by every row: one table reads one group
			const groupInput = row.createEl("input", {
				cls: "ls-input ls-mono ls-rule-group",
				attr: {
					type: "number",
					min: "0",
					step: "1",
					title: "捕获组序号：0 = 第一个括号组，1 = 第二个…（所有行共用）",
				},
			});
			groupInput.value = String(this.condGroup);
			groupInput.addEventListener("input", () => {
				const value = Number(groupInput.value);
				this.condGroup = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
				this.leftEl.querySelectorAll<HTMLInputElement>(".ls-rule-group").forEach((input) => {
					if (input !== groupInput) input.value = String(this.condGroup);
				});
				this.refreshLive();
			});

			const keyInput = row.createEl("input", { cls: "ls-input ls-mono", attr: { placeholder: "g" } });
			keyInput.value = rule.key;
			keyInput.addEventListener("input", () => {
				this.condRules[index].key = keyInput.value;
				this.refreshLive();
			});
			const outInput = row.createEl("input", {
				cls: "ls-input ls-mono",
				attr: { placeholder: "完整替换文本" },
			});
			outInput.value = rule.output;
			outInput.addEventListener("input", () => {
				this.condRules[index].output = outInput.value;
				this.refreshLive();
			});
			const del = row.createEl("button", { cls: "ls-rule-del", attr: { title: "删除这一行" } });
			setIcon(del, "x");
			del.addEventListener("click", () => {
				this.condRules.splice(index, 1);
				if (!this.condRules.length) this.condRules.push({ key: "", output: "" });
				this.renderLeft();
			});
		});

		const rowActions = box.createDiv({ cls: "ls-rule-actions" });
		const add = rowActions.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "＋ 添加一行" });
		add.addEventListener("click", () => {
			this.condRules.push({ key: "", output: "" });
			this.renderLeft();
			window.setTimeout(() => {
				const rows = this.leftEl.querySelectorAll<HTMLElement>(".ls-rules .ls-rule-row");
				rows[rows.length - 1]?.querySelector<HTMLInputElement>("input")?.focus();
			}, 30);
		});
		const hand = rowActions.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "改为手写 JS" });
		hand.addEventListener("click", () => {
			this.condSource = buildConditionalSource(this.validRules(), this.condGroup);
			this.condAdvanced = true;
			this.renderLeft();
		});

		this.liveEl = box.createDiv({ cls: "ls-live" });
		this.refreshLive();
	}

	/** Rules that are complete enough to preview / generate. */
	private validRules(): LocalSnippetConditionalRule[] {
		return this.condRules
			.map((rule) => ({ key: rule.key.trim(), output: rule.output }))
			.filter((rule) => rule.key !== "" && rule.output !== "");
	}

	private refreshLive() {
		const el = this.liveEl;
		if (!el || !el.isConnected) return;
		el.empty();

		const rules = this.validRules();
		const preview = el.createDiv({ cls: "ls-preview" });
		if (!rules.length) {
			preview.createDiv({ cls: "ls-preview-empty" }).setText("填完一行后，这里会显示预演");
		} else {
			const rows = previewConditional(
				this.triggerText.trim(),
				rules,
				this.normalizedOptions(),
				this.condGroup,
			);
			for (const row of rows) {
				const line = preview.createDiv({
					cls: `ls-preview-row${row.matched ? " is-ok" : " is-miss"}`,
				});
				line.createSpan({ cls: "ls-preview-in" }).setText(row.example || "（示例）");
				line.createSpan({ cls: "ls-preview-arrow" }).setText("→");
				line
					.createSpan({ cls: "ls-preview-out" })
					.setText(row.matched ? row.output : "未命中 · 不展开");
				const mark = line.createSpan({ cls: "ls-preview-mark" });
				setIcon(mark, row.matched ? "check" : "minus");
			}
		}

		const codeWrap = el.createDiv({ cls: "ls-adv-code" });
		const codeHead = codeWrap.createDiv({ cls: "ls-code-head" });
		codeHead.createSpan({ cls: "ls-field-label" }).setText("生成的 JS（只读）");
		const copy = codeHead.createEl("button", { cls: "ls-btn ls-btn-ghost", text: "复制" });
		const source = rules.length ? buildConditionalSource(rules, this.condGroup) : "";
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(source);
			new Notice("已复制");
		});
		codeWrap.createEl("pre", { cls: "ls-code" }).setText(source || "（填完规则后显示）");
	}

	// ---- bindings ------------------------------------------------------ //

	/**
	 * Bindings are independent choices: "bind to this file" (checkbox) and
	 * "bind to tags" (any number, toggled by clicking; clicking a selected tag
	 * again removes it, a custom tag is added on top of existing ones).
	 */
	private renderBindings(body: HTMLElement) {
		const box = body.createDiv({ cls: "ls-bind" });

		// -- file binding -------------------------------------------------
		if (this.baseFile) {
			const fileRow = box.createDiv({ cls: "ls-bind-row" });
			const check = fileRow.createEl("button", {
				cls: `ls-bind-check${this.bindFile ? " is-checked" : ""}`,
				attr: { type: "button", title: this.bindFile ? "取消绑定到此文件" : "绑定到此文件" },
			});
			if (this.bindFile) {
				const tick = check.createSpan({ cls: "ls-bind-tick" });
				setIcon(tick, "check");
			}
			check.addEventListener("click", () => {
				this.bindFile = !this.bindFile;
				this.renderLeft();
			});
			const label = fileRow.createEl("span", { cls: "ls-bind-label" });
			label.setText("绑定到此文件");
			label.addEventListener("click", () => {
				this.bindFile = !this.bindFile;
				this.renderLeft();
			});
			fileRow.createSpan({ cls: "ls-bind-file" }).setText(`· ${this.baseFile.basename}`);
		} else {
			box.createDiv({ cls: "ls-bind-note" }).setText(
				"没有可绑定的文件：请在某个 Markdown 笔记中打开窗口，或只绑定标签。",
			);
		}

		// -- tag bindings (multiple) --------------------------------------
		box.createDiv({ cls: "ls-bind-tag-head" }).setText(
			"标签（可选，可多选 · 再次点击已选标签可取消）",
		);
		const knownTags = this.baseFile ? this.store.tagsOfPath(this.baseFile.path) : [];

		if (this.bindTags.length) {
			const bound = box.createDiv({ cls: "ls-bind-tags" });
			for (const tag of this.bindTags) {
				const pill = bound.createSpan({ cls: "ls-bound-pill" });
				pill.createSpan({ text: `#${tag}` });
				const remove = pill.createEl("span", {
					cls: "ls-bound-x",
					attr: { title: `解除标签 #${tag}` },
				});
				remove.setText(" ×");
				remove.addEventListener("click", () => {
					this.bindTags = this.bindTags.filter((t) => t !== tag);
					this.renderLeft();
				});
			}
		}

		const chips = box.createDiv({ cls: "ls-chips" });
		for (const tag of knownTags) {
			const active = this.bindTags.includes(tag);
			const chip = chips.createEl("button", {
				cls: `ls-chip${active ? " is-active" : ""}`,
				text: `#${tag}`,
			});
			chip.addEventListener("click", () => {
				// toggle: clicking an already-selected tag removes it
				this.bindTags = active
					? this.bindTags.filter((t) => t !== tag)
					: [...this.bindTags, tag];
				this.renderLeft();
			});
		}
		const customChip = chips.createEl("button", {
			cls: `ls-chip ls-chip-custom${this.tagCustomOpen ? " is-active" : ""}`,
			text: "＋ 自定义标签",
		});
		customChip.addEventListener("click", () => {
			this.tagCustomOpen = true;
			this.renderLeft();
			window.setTimeout(() => {
				this.leftEl.querySelector<HTMLInputElement>(".ls-custom-tag input")?.focus();
			}, 30);
		});

		if (!knownTags.length) {
			box.createDiv({ cls: "ls-bind-note" }).setText("当前笔记没有标签，可直接使用『＋ 自定义标签』。");
		}

		if (this.tagCustomOpen) {
			const customWrap = box.createDiv({ cls: "ls-custom-tag" });
			const customInput = customWrap.createEl("input", {
				cls: "ls-input ls-mono",
				attr: { type: "text", placeholder: "输入标签名（不带 #），回车添加到绑定" },
			});
			customInput.value = this.customDraft;
			const commit = () => {
				const v = this.customDraft.trim().replace(/^#+/, "");
				if (v && !this.bindTags.includes(v)) this.bindTags = [...this.bindTags, v];
				this.tagCustomOpen = false;
				this.customDraft = "";
				this.renderLeft();
			};
			customInput.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") commit();
			});
			customInput.addEventListener("input", () => {
				this.customDraft = customInput.value;
			});
		}
	}

	private describeBindings(): string {
		const parts: string[] = [];
		if (this.bindFile) {
			if (this.baseFile) parts.push(this.baseFile.basename);
			else if (this.origFile) {
				const base = this.origFile.split("/").pop() ?? this.origFile;
				parts.push(base.replace(/\.md$/i, ""));
			}
		}
		for (const tag of this.bindTags) parts.push(`#${tag}`);
		return parts.length ? parts.join(" + ") : "未绑定";
	}

	// ------------------------------------------------------------------ //
	// Save / delete                                                      //
	// ------------------------------------------------------------------ //

	/** Options actually stored: conditioning always needs a regex trigger. */
	private normalizedOptions(): string {
		const raw = this.optionsText.trim();
		if (!this.condEnabled || raw.includes("r")) return raw;
		return `r${raw}`;
	}

	private buildItem(): LocalSnippetItem | null {
		const trigger = this.triggerText.trim();
		const options = this.normalizedOptions();
		const priorityStr = this.priorityText.trim();

		if (!trigger) {
			new Notice("trigger 不能为空");
			return null;
		}

		let priority: number | undefined;
		if (priorityStr) {
			priority = Number(priorityStr);
			if (!Number.isFinite(priority)) {
				new Notice("priority 必须是数字（可留空）");
				return null;
			}
		}

		let replacement = this.replacementText;
		let replacementFn: string | undefined;
		let conditional: LocalSnippetConditional | undefined;

		if (this.condEnabled) {
			const rules = this.validRules();
			if (!rules.length) {
				new Notice("条件化匹配至少需要一行完整的『捕获值 → 输出』");
				return null;
			}
			const seen = new Set<string>();
			for (const rule of rules) {
				if (seen.has(rule.key)) {
					new Notice(`捕获值重复：${rule.key}`);
					return null;
				}
				seen.add(rule.key);
			}
			const captures = countCaptureGroups(trigger);
			if (captures < 1) {
				new Notice("条件化的 trigger 需要至少一个捕获组，例如 Ft([0g])");
				return null;
			}
			if (this.condGroup + 1 > captures) {
				new Notice(
					`组别 ${this.condGroup} 超出范围：trigger 只有 ${captures} 个捕获组（组别从 0 开始）`,
				);
				return null;
			}
			try {
				new RegExp(trigger);
			} catch (e) {
				new Notice(`trigger 不是合法的正则：${(e as Error).message}`);
				return null;
			}

			const source = this.condAdvanced
				? this.condSource.trim()
				: buildConditionalSource(rules, this.condGroup);
			if (!source) {
				new Notice("手写的 replacement 函数不能为空");
				return null;
			}
			if (!compileReplacementFn(source)) {
				new Notice("生成的 replacement 函数无法编译，请检查手写内容");
				return null;
			}
			replacement = rules[0].output;
			replacementFn = source;
			if (!this.condAdvanced) conditional = { rules, group: this.condGroup };
		} else if (!replacement) {
			new Notice("replacement 不能为空");
			return null;
		}

		// a pending, not yet committed custom tag counts as a binding too
		const tags = this.bindTags.slice();
		if (this.tagCustomOpen && this.customDraft.trim()) {
			const draft = this.customDraft.trim().replace(/^#+/, "");
			if (draft && !tags.includes(draft)) tags.push(draft);
		}

		const item: LocalSnippetItem = {
			trigger,
			replacement,
			...(replacementFn !== undefined && { replacementFn }),
			...(conditional !== undefined && { conditional }),
			options,
			...(priority !== undefined && { priority }),
			...(this.descriptionText.trim() && { description: this.descriptionText.trim() }),
		};

		if (this.bindFile) {
			// when no note is open in this window we can still keep (but not
			// change) the file binding of the item being edited
			if (this.baseFile) item.file = this.baseFile.path;
			else if (this.mode === "edit") item.file = this.origFile;
		}
		if (tags.length) item.tags = tags;

		if (item.file === undefined && item.tags === undefined) {
			new Notice("请至少绑定『此文件』或一个标签");
			return null;
		}

		try {
			parseSnippetObjects([item]);
		} catch (e) {
			console.error(e);
			new Notice(`Snippet 无效：${(e as Error).message.slice(0, 300)}`);
			return null;
		}
		return item;
	}

	/** saveAs = true duplicates the form as a new item; otherwise update in place. */
	async save(saveAs: boolean) {
		const built = this.buildItem();
		if (!built) return;

		const items = this.store.items;

		if (this.mode === "edit" && !saveAs) {
			const idx = this.indexOfItem(items, this.editKey);
			if (idx !== -1) items[idx] = built;
			else items.push(built);
		} else {
			items.push(built);
		}

		await this.store.saveItems(items);
		this.resetToNew();
	}

	private indexOfItem(items: LocalSnippetItem[], key: string): number {
		for (let i = 0; i < items.length; i++) {
			if (this.itemKey(items[i]) === key) return i;
		}
		return -1;
	}

	private async deleteItem(item: LocalSnippetItem) {
		const key = this.itemKey(item);
		let removed = false;
		const items = this.store.items.filter((it) => {
			if (!removed && this.itemKey(it) === key) {
				removed = true;
				return false;
			}
			return true;
		});
		await this.store.saveItems(items);
		this.selected.clear();

		if (this.mode === "edit" && this.editKey === key) this.resetToNew();
		else {
			this.rerenderAll();
		}
	}
}

export function openLocalSnippetCreateModal(store: LocalSnippetStore, file: TFile, prefill: string) {
	new LocalSnippetWorkspaceModal(store, { baseFile: file, prefill }).open();
}

export function openLocalSnippetManagerModal(store: LocalSnippetStore) {
	new LocalSnippetWorkspaceModal(store).open();
}

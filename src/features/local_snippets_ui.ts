import { MarkdownView, Modal, Notice, setIcon, TFile } from "obsidian";
import type { LocalSnippetItem } from "../settings/settings";
import type { LocalSnippetStore } from "./local_snippets";
import { parseSnippetObjects } from "../snippets/parse";

const OPTIONS_HELP =
	"A=自动 · r=正则 · w=词边界 · v=visual · U=关撤销 | 模式: m/M/n 数学(块/块/行内) t=文本 c/C=代码块/代码 | 留空=任意位置";

/**
 * Combined window for local snippets: left = create / edit form, right = the
 * list grouped by the note and/or tags each item is bound to.
 *
 * Bindings are independent: an item may bind to the current note, to any
 * number of tags, or both (at least one binding is required). Because
 * bindings are attributes of the item they can be changed later from the edit
 * form. "另存" copies the form into a brand-new item without touching the one
 * being edited; "保存" writes the form back into the selected item.
 */
class LocalSnippetWorkspaceModal extends Modal {
	private mode: "new" | "edit" = "new";
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

	private searchQuery = "";
	private baseFile: TFile | null;
	private prefill: string;
	private origFile: string | undefined; // file binding of the item being edited

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

		this.renderForm();
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
			"左侧新建/编辑；绑定可同时包含『此文件』与多个标签；右侧点击条目即载入左侧。",
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
		if (this.searchQuery) {
			const clear = toolbar.createEl("button", { cls: "ls-btn ls-btn-ghost" });
			clear.setText("清除");
			clear.addEventListener("click", () => {
				this.searchQuery = "";
				this.renderList();
			});
		}

		const items = this.store.items;
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
			(it.trigger + "\n" + it.options + "\n" + (it.description ?? "") + "\n" + it.replacement)
				.toLowerCase()
				.includes(query);

		let shown = 0;

		const addGroup = (
			kind: "文档" | "标签",
			scopeKey: string,
			list: LocalSnippetItem[],
			note?: TFile | null,
		) => {
			const filtered = list.filter(matches);
			if (!filtered.length) return;
			shown += filtered.length;

			const group = rightEl.createDiv({ cls: "ls-group" });
			const groupHead = group.createDiv({ cls: "ls-group-head" });
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

			filtered.forEach((item) => {
				const isSelected = this.mode === "edit" && this.editKey === this.itemKey(item);
				const row = group.createDiv({ cls: `ls-item${isSelected ? " is-selected" : ""}` });
				const del = row.createEl("button", { cls: "ls-item-del", attr: { title: "删除" } });
				setIcon(del, "trash-2");
				del.addEventListener("click", (ev) => {
					ev.stopPropagation();
					void this.deleteItem(item);
				});

				row.createSpan({ cls: "ls-item-trigger" }).setText(item.trigger);

				const meta: string[] = [];
				if (item.options) meta.push(item.options);
				if (item.priority !== undefined) meta.push(`p${item.priority}`);
				row.createSpan({ cls: "ls-item-meta" }).setText(meta.join(" · "));

				if (item.description) row.createSpan({ cls: "ls-item-desc" }).setText(item.description);
				row.createSpan({ cls: "ls-item-preview" }).setText(this.preview(item.replacement));

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
					this.startEditing(item);
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
		const byFile = (f: string) => items.filter((it) => it.file === f);
		const byTag = (t: string) => items.filter((it) => it.tags?.includes(t));

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
		]);
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
		this.triggerText = item.trigger;
		this.optionsText = item.options;
		this.priorityText = item.priority !== undefined ? String(item.priority) : "";
		this.descriptionText = item.description ?? "";
		this.replacementText = item.replacement;
		this.bindFile = !!item.file;
		this.bindTags = item.tags ? [...item.tags] : [];
		this.tagCustomOpen = false;
		this.customDraft = "";
		this.renderForm();
		this.renderList();
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
		this.tagCustomOpen = false;
		this.customDraft = "";
		this.renderHeader();
		this.renderForm();
		this.renderList();
		this.focusTrigger();
	}

	private focusTrigger() {
		window.setTimeout(() => {
			this.leftEl.querySelector<HTMLInputElement>(".ls-field-trigger input")?.focus();
		}, 30);
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
		triggerInput.addEventListener("input", () => (this.triggerText = triggerInput.value));
		fTrigger.createSpan({ cls: "ls-field-hint" }).setText("输入这些字符即触发；逐字匹配，不用回车");

		// options + priority in one row
		const optRow = body.createDiv({ cls: "ls-field-row" });
		const fOpt = optRow.createDiv({ cls: "ls-field ls-grow" });
		fOpt.createSpan({ cls: "ls-field-label" }).setText("options");
		const optInput = fOpt.createEl("input", { cls: "ls-input ls-mono" });
		optInput.value = this.optionsText;
		optInput.addEventListener("input", () => (this.optionsText = optInput.value));
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

		// replacement
		const fRepl = body.createDiv({ cls: "ls-field" });
		const replHead = fRepl.createDiv({ cls: "ls-repl-head" });
		replHead.createSpan({ cls: "ls-field-label" }).setText("replacement");
		replHead.createSpan({ cls: "ls-field-hint" }).setText("无需双写反斜杠；支持 $0 / ${1:x} / ${VISUAL}");
		const replArea = fRepl.createEl("textarea", { cls: "ls-input ls-mono ls-textarea" });
		replArea.value = this.replacementText;
		replArea.addEventListener("input", () => (this.replacementText = replArea.value));

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
				this.renderForm();
			});
			const label = fileRow.createEl("span", { cls: "ls-bind-label" });
			label.setText("绑定到此文件");
			label.addEventListener("click", () => {
				this.bindFile = !this.bindFile;
				this.renderForm();
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
					this.renderForm();
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
				this.renderForm();
			});
		}
		const customChip = chips.createEl("button", {
			cls: `ls-chip ls-chip-custom${this.tagCustomOpen ? " is-active" : ""}`,
			text: "＋ 自定义标签",
		});
		customChip.addEventListener("click", () => {
			this.tagCustomOpen = true;
			this.renderForm();
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
				this.renderForm();
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

	private buildItem(): LocalSnippetItem | null {
		const trigger = this.triggerText.trim();
		const replacement = this.replacementText;
		const options = this.optionsText.trim();
		const priorityStr = this.priorityText.trim();

		if (!trigger) {
			new Notice("trigger 不能为空");
			return null;
		}
		if (!replacement) {
			new Notice("replacement 不能为空");
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

		// a pending, not yet committed custom tag counts as a binding too
		const tags = this.bindTags.slice();
		if (this.tagCustomOpen && this.customDraft.trim()) {
			const draft = this.customDraft.trim().replace(/^#+/, "");
			if (draft && !tags.includes(draft)) tags.push(draft);
		}

		const item: LocalSnippetItem = {
			trigger,
			replacement,
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

		if (this.mode === "edit" && this.editKey === key) this.resetToNew();
		else {
			this.renderList();
			this.renderHeader();
		}
	}
}

export function openLocalSnippetCreateModal(store: LocalSnippetStore, file: TFile, prefill: string) {
	new LocalSnippetWorkspaceModal(store, { baseFile: file, prefill }).open();
}

export function openLocalSnippetManagerModal(store: LocalSnippetStore) {
	new LocalSnippetWorkspaceModal(store).open();
}

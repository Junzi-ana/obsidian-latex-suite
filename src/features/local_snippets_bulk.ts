import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";
import type { LocalSnippetItem } from "../settings/settings";

/**
 * Pure helpers behind the bulk edit panel of the local snippet workspace, plus
 * two tiny pickers (target note, delete confirmation).
 *
 * Every mutation takes the full item list plus the *indices* that are
 * selected and returns a new list, so the UI never mutates store data in
 * place. Indices (not signatures) are used because the same item may show up
 * in both a document group and a tag group.
 */

export type BulkKind = "move" | "copy" | "tag" | "unbind" | "delete";

export type BulkOutcome = {
	items: LocalSnippetItem[];
	affected: number;
	/** Human readable reasons for items that were left untouched. */
	skipped: string[];
};

const unique = (values: string[]): string[] => Array.from(new Set(values));

/** Point the file binding of the selected items at `targetPath`. */
export function moveItems(
	items: LocalSnippetItem[],
	indices: number[],
	targetPath: string,
	keepTags: boolean,
): BulkOutcome {
	const picked = new Set(indices);
	let affected = 0;
	const next = items.map((item, index) => {
		if (!picked.has(index)) return item;
		affected++;
		const moved: LocalSnippetItem = { ...item, file: targetPath };
		if (!keepTags) delete moved.tags;
		return moved;
	});
	return { items: next, affected, skipped: [] };
}

/** Append copies of the selected items, bound to `targetPath`. */
export function copyItems(
	items: LocalSnippetItem[],
	indices: number[],
	targetPath: string,
	copyTags: boolean,
): BulkOutcome {
	const picked = new Set(indices);
	const copies: LocalSnippetItem[] = [];
	items.forEach((item, index) => {
		if (!picked.has(index)) return;
		const copy: LocalSnippetItem = { ...item, file: targetPath };
		if (!copyTags) delete copy.tags;
		if (copy.tags) copy.tags = [...copy.tags];
		copies.push(copy);
	});
	return { items: [...items, ...copies], affected: copies.length, skipped: [] };
}

/** Add `tag` to the selected items; optionally drop their file binding. */
export function bindTag(
	items: LocalSnippetItem[],
	indices: number[],
	tag: string,
	dropFile: boolean,
): BulkOutcome {
	const picked = new Set(indices);
	const skipped: string[] = [];
	let affected = 0;
	const next = items.map((item, index) => {
		if (!picked.has(index)) return item;
		const alreadyBound = !!item.tags?.includes(tag);
		if (alreadyBound && (!dropFile || item.file === undefined)) {
			skipped.push(`${item.trigger}：已绑定 #${tag}`);
			return item;
		}
		affected++;
		const bound: LocalSnippetItem = { ...item, tags: unique([...(item.tags ?? []), tag]) };
		if (dropFile) delete bound.file;
		return bound;
	});
	return { items: next, affected, skipped };
}

/** Remove the file binding and/or the given tags from the selected items. */
export function unbindItems(
	items: LocalSnippetItem[],
	indices: number[],
	options: { file: boolean; tags: string[] },
): BulkOutcome {
	const picked = new Set(indices);
	const skipped: string[] = [];
	let affected = 0;
	const next = items.map((item, index) => {
		if (!picked.has(index)) return item;
		if (!options.file && !options.tags.length) return item;

		const nextItem: LocalSnippetItem = { ...item };
		if (options.file) delete nextItem.file;
		if (options.tags.length && nextItem.tags) {
			const remaining = nextItem.tags.filter((tag) => !options.tags.includes(tag));
			if (remaining.length) nextItem.tags = remaining;
			else delete nextItem.tags;
		}

		if (nextItem.file === undefined && (!nextItem.tags || !nextItem.tags.length)) {
			skipped.push(`${item.trigger}：解绑后会失去全部绑定，已跳过（请改用删除）`);
			return item;
		}
		affected++;
		return nextItem;
	});
	return { items: next, affected, skipped };
}

/** Remove the selected items entirely (all of their bindings go with them). */
export function deleteItems(items: LocalSnippetItem[], indices: number[]): BulkOutcome {
	const picked = new Set(indices);
	return {
		items: items.filter((_, index) => !picked.has(index)),
		affected: picked.size,
		skipped: [],
	};
}

/** Vault-wide note picker used by "move to…" / "copy to…". */
class FilePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onPick: (file: TFile | null) => void,
	) {
		super(app);
		this.setPlaceholder("选择目标文档（输入文件名筛选）");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}

	onClose(): void {
		super.onClose();
		this.onPick(null);
	}
}

export function pickMarkdownFile(app: App): Promise<TFile | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (file: TFile | null) => {
			if (settled) return;
			settled = true;
			resolve(file);
		};
		new FilePickerModal(app, done).open();
	});
}

/** Minimal confirmation dialog (Obsidian has no built-in confirm). */
export function confirmAction(
	app: App,
	title: string,
	body: string,
	confirmText = "确定",
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const modal = new Modal(app);
		modal.titleEl.setText(title);
		modal.contentEl.createEl("p", { text: body });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "取消" });
		cancel.addEventListener("click", () => {
			finish(false);
			modal.close();
		});
		const confirmBtn = buttons.createEl("button", { cls: "mod-warning", text: confirmText });
		confirmBtn.addEventListener("click", () => {
			finish(true);
			modal.close();
		});
		const originalClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			finish(false);
			originalClose();
		};
		modal.open();
	});
}

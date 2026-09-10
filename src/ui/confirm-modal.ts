import { App, Modal, Setting } from "obsidian";

/** A confirmation that shows the work rather than describing it.
 *
 * §8.5 requires confirmation before a potentially destructive fix and §9.7
 * requires an automation to show what it will do. Both are the same dialog, and
 * both live or die on the same detail: the list is the *actual* planned
 * operations, rendered from the same objects that will be applied. A dialog
 * saying "this will fix 12 issues" is not a confirmation, it is a countdown. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private options: {
			title: string;
			intro?: string;
			lines: string[];
			confirmText: string;
			warning?: string;
			onConfirm: () => void | Promise<void>;
		}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("engineering-toolkit");
		contentEl.createEl("h3", { text: this.options.title });
		if (this.options.intro) contentEl.createEl("p", { text: this.options.intro });

		if (this.options.lines.length === 0) {
			contentEl.createEl("p", { cls: "et-muted", text: "Nothing to do." });
		} else {
			const list = contentEl.createEl("ul", { cls: "et-plan" });
			// Capped, and the cap is stated. A truncated list that does not say it
			// is truncated is the same failure as no list at all.
			for (const line of this.options.lines.slice(0, 40)) list.createEl("li", { text: line });
			if (this.options.lines.length > 40) {
				list.createEl("li", { cls: "et-muted", text: `…and ${this.options.lines.length - 40} more, not shown.` });
			}
		}

		if (this.options.warning) contentEl.createEl("p", { cls: "et-warning", text: this.options.warning });

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.options.confirmText)
					.setCta()
					.setDisabled(this.options.lines.length === 0)
					.onClick(async () => {
						this.close();
						await this.options.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

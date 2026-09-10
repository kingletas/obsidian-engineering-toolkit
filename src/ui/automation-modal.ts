import { App, Modal, Setting } from "obsidian";
import { ACTION_KINDS, CONDITION_OPS, EVENT_KINDS, type Action, type AutomationRule, type Condition } from "../automation/types";

/** The rule editor. Deliberately plain: §9.1's "the goal is not to recreate
 * Zapier" is easiest to hold by not building a canvas, a branch editor or a
 * drag surface, none of which the WHEN / IF / DO model in §9.2 needs. */
export class AutomationModal extends Modal {
	private draft: AutomationRule;

	constructor(
		app: App,
		rule: AutomationRule,
		private onSave: (rule: AutomationRule) => void | Promise<void>
	) {
		super(app);
		// Deep-copied so cancelling really cancels. Editing the stored object in
		// place and relying on the caller not to save is the sort of thing that
		// works until a modal is closed with Escape.
		this.draft = JSON.parse(JSON.stringify(rule)) as AutomationRule;
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("engineering-toolkit");
		contentEl.createEl("h3", { text: "Automation" });

		new Setting(contentEl).setName("Name").addText((text) =>
			text.setValue(this.draft.name).onChange((value) => {
				this.draft.name = value;
			})
		);

		new Setting(contentEl)
			.setName("When")
			.setDesc("The event that triggers the rule.")
			.addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(EVENT_KINDS.map((kind) => [kind, kind.replace(/-/g, " ")])))
					.setValue(this.draft.event)
					.onChange((value) => {
						this.draft.event = value as AutomationRule["event"];
						this.render();
					})
			);

		if (this.draft.event === "property-changed") {
			new Setting(contentEl)
				.setName("Property to watch")
				.setDesc("Empty means any property.")
				.addText((text) =>
					text.setValue(this.draft.watchProperty ?? "").onChange((value) => {
						this.draft.watchProperty = value.trim();
					})
				);
		}

		contentEl.createEl("h4", { text: "If" });
		contentEl.createEl("p", { cls: "et-muted", text: "Every condition must hold. Fields: folder, type, status, tag, path, title, or prop:<key>." });

		this.draft.conditions.forEach((condition, i) => {
			const setting = new Setting(contentEl);
			setting.addText((text) =>
				text.setPlaceholder("field").setValue(condition.field).onChange((value) => {
					condition.field = value.trim();
				})
			);
			setting.addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(CONDITION_OPS.map((op) => [op, op.replace(/-/g, " ")])))
					.setValue(condition.op)
					.onChange((value) => {
						condition.op = value as Condition["op"];
					})
			);
			setting.addText((text) =>
				text.setPlaceholder("value").setValue(condition.value).onChange((value) => {
					condition.value = value;
				})
			);
			setting.addExtraButton((button) =>
				button.setIcon("trash").setTooltip("Remove").onClick(() => {
					this.draft.conditions.splice(i, 1);
					this.render();
				})
			);
		});

		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Add condition").onClick(() => {
				this.draft.conditions.push({ field: "folder", op: "equals", value: "" });
				this.render();
			})
		);

		contentEl.createEl("h4", { text: "Then" });
		contentEl.createEl("p", { cls: "et-muted", text: "`{{date}}`, `{{time}}`, `{{title}}` and `{{path}}` are substituted. There is no delete action, and there will not be one." });

		this.draft.actions.forEach((action, i) => {
			const setting = new Setting(contentEl);
			setting.addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(ACTION_KINDS.map((kind) => [kind, kind.replace(/-/g, " ")])))
					.setValue(action.kind)
					.onChange((value) => {
						action.kind = value as Action["kind"];
						this.render();
					})
			);
			setting.addText((text) =>
				text.setPlaceholder(targetHint(action.kind)).setValue(action.target).onChange((value) => {
					action.target = value.trim();
				})
			);
			setting.addText((text) =>
				text.setPlaceholder(valueHint(action.kind)).setValue(action.value ?? "").onChange((value) => {
					action.value = value;
				})
			);
			setting.addExtraButton((button) =>
				button.setIcon("trash").setTooltip("Remove").onClick(() => {
					this.draft.actions.splice(i, 1);
					this.render();
				})
			);
		});

		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Add action").onClick(() => {
				this.draft.actions.push({ kind: "set-property", target: "", value: "" });
				this.render();
			})
		);

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						// A saved rule is never switched on by the act of saving.
						// §9.7 asks for explicit activation, and "I edited it" is
						// not that.
						this.close();
						await this.onSave(this.draft);
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function targetHint(kind: Action["kind"]): string {
	switch (kind) {
		case "set-property":
			return "property";
		case "add-tag":
			return "tag";
		case "move-note":
			return "folder";
		case "append-text":
		case "create-task":
			return "heading (optional)";
		default:
			return "target";
	}
}

function valueHint(kind: Action["kind"]): string {
	switch (kind) {
		case "set-property":
			return "value, e.g. {{date}}";
		case "move-note":
			return "folder (overrides target)";
		case "create-note":
			return "path of the new note";
		case "add-link":
			return "note to link to";
		case "add-tag":
			return "—";
		default:
			return "text";
	}
}

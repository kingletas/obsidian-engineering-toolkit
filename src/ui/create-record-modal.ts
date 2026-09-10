import { App, Modal, Setting } from "obsidian";
import type { RecordKind } from "../core/types";
import { ADR_STATUSES, DETECTION_SOURCES, ENVIRONMENTS, INCIDENT_STATUSES, INFRA_TYPES, SEVERITIES } from "../records/record-types";

export interface CreateRequest {
	kind: RecordKind;
	title: string;
	/** Infrastructure only. */
	type: string;
	status: string;
	severity: string;
	environment: string;
	service: string;
	dependencies: string[];
	linkFromIndex: boolean;
	/** Infrastructure only. Null means ungraded, which is written as an empty
	 * property rather than omitted — an ungraded component should look ungraded. */
	tier: number | null;
	slo: string;
	/** Incident only. */
	detectedBy: string;
}

/** One modal for all four record kinds, because they differ by three fields and
 * four near-identical modals is four places to fix a bug in the title field. */
export class CreateRecordModal extends Modal {
	private request: CreateRequest;

	constructor(
		app: App,
		kind: RecordKind,
		private options: {
			/** The id that will be allocated, shown before anything is written so
			 * the number is never a surprise. */
			previewId: string | null;
			services: string[];
			linkFromIndexDefault: boolean;
			onSubmit: (request: CreateRequest) => void | Promise<void>;
		}
	) {
		super(app);
		this.request = {
			kind,
			title: "",
			type: kind === "infrastructure" ? "service" : kind,
			status: kind === "adr" ? "proposed" : kind === "incident" ? "investigating" : "active",
			severity: "SEV-3",
			environment: "production",
			service: "",
			dependencies: [],
			linkFromIndex: options.linkFromIndexDefault,
			tier: null,
			slo: "",
			detectedBy: "",
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("engineering-toolkit");
		contentEl.createEl("h3", { text: heading(this.request.kind) });

		if (this.options.previewId) {
			contentEl.createEl("p", {
				cls: "et-muted",
				text: `This will be ${this.options.previewId}. Numbers are derived from the records already in the vault, never from a stored counter — a counter is wrong the first time anybody creates a record by hand.`,
			});
		}

		let submit: (() => void) | null = null;

		new Setting(contentEl).setName("Title").addText((text) => {
			text.setPlaceholder(placeholder(this.request.kind)).onChange((value) => {
				this.request.title = value;
			});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") submit?.();
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		if (this.request.kind === "infrastructure") {
			new Setting(contentEl).setName("Type").addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(INFRA_TYPES.map((type) => [type, type])))
					.setValue(this.request.type)
					.onChange((value) => {
						this.request.type = value;
					})
			);
			new Setting(contentEl).setName("Environment").addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(ENVIRONMENTS.map((env) => [env, env])))
					.setValue(this.request.environment)
					.onChange((value) => {
						this.request.environment = value;
					})
			);
			new Setting(contentEl)
				.setName("Tier")
				.setDesc("1 is the most critical. It decides whether a missing objective is a gap or a defect, and it should be at least as strong as everything this depends on.")
				.addDropdown((drop) =>
					drop
						.addOptions({ "": "ungraded", "1": "Tier 1", "2": "Tier 2", "3": "Tier 3" })
						.setValue("")
						.onChange((value) => {
							this.request.tier = value ? Number.parseInt(value, 10) : null;
						})
				);
			new Setting(contentEl)
				.setName("Objective")
				.setDesc("A proportion over a window — `availability 99.9% over 30d`. A percentile does not compose with an error budget, so `p99 500ms` is reported rather than accepted.")
				.addText((text) =>
					text.setPlaceholder("availability 99.9% over 30d").onChange((value) => {
						this.request.slo = value;
					})
				);
			new Setting(contentEl)
				.setName("Depends on")
				.setDesc("Comma-separated note names. Anything with no note is still recorded and shows in the tree as `(no note)`.")
				.addText((text) =>
					text.onChange((value) => {
						this.request.dependencies = value.split(",").map((part) => part.trim()).filter(Boolean);
					})
				);
		}

		if (this.request.kind === "adr") {
			new Setting(contentEl).setName("Status").addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(ADR_STATUSES.map((status) => [status, status])))
					.setValue(this.request.status)
					.onChange((value) => {
						this.request.status = value;
					})
			);
			new Setting(contentEl)
				.setName("Link from the ADR index")
				.setDesc("Appends one bullet under `## Records`. Nothing else in that note is touched.")
				.addToggle((toggle) =>
					toggle.setValue(this.request.linkFromIndex).onChange((value) => {
						this.request.linkFromIndex = value;
					})
				);
		}

		if (this.request.kind === "incident") {
			new Setting(contentEl).setName("Severity").addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(SEVERITIES.map((severity) => [severity, severity])))
					.setValue(this.request.severity)
					.onChange((value) => {
						this.request.severity = value;
					})
			);
			new Setting(contentEl).setName("Status").addDropdown((drop) =>
				drop
					.addOptions(Object.fromEntries(INCIDENT_STATUSES.map((status) => [status, status])))
					.setValue(this.request.status)
					.onChange((value) => {
						this.request.status = value;
					})
			);
			new Setting(contentEl)
				.setName("Detected by")
				.setDesc("The one property that separates a monitoring failure from a slow fix. It is the only place the detection gap gets counted.")
				.addDropdown((drop) =>
					drop
						.addOptions({ "": "not recorded", ...Object.fromEntries(DETECTION_SOURCES.map((source) => [source, source])) })
						.setValue("")
						.onChange((value) => {
							this.request.detectedBy = value;
						})
				);
			new Setting(contentEl)
				.setName("Affected service")
				.setDesc(this.options.services.length ? `Known: ${this.options.services.slice(0, 8).join(", ")}${this.options.services.length > 8 ? "…" : ""}` : "No infrastructure notes indexed yet.")
				.addText((text) =>
					text.onChange((value) => {
						this.request.service = value.trim();
					})
				);
		}

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Create")
				.setCta()
				.onClick(() => submit?.());
			submit = () => {
				if (!this.request.title.trim()) return;
				this.close();
				void this.options.onSubmit(this.request);
			};
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function heading(kind: RecordKind): string {
	switch (kind) {
		case "adr":
			return "New architecture decision record";
		case "incident":
			return "New incident";
		case "decision":
			return "New decision log entry";
		default:
			return "New infrastructure note";
	}
}

function placeholder(kind: RecordKind): string {
	switch (kind) {
		case "adr":
			return "Patch third-party core rather than subclass it";
		case "incident":
			return "Checkout unavailable for guest customers";
		case "decision":
			return "Use MariaDB for the new deployment";
		default:
			return "Magento";
	}
}

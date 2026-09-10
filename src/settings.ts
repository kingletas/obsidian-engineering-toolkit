import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type EngineeringToolkitPlugin from "./main";
import { RULES } from "./lint/linter";
import type { Severity } from "./core/types";
import { describeScope } from "./core/scope";
import type { ModuleFlags } from "./dashboard/dashboard-engine";
import { EVENT_KINDS, type AutomationRule } from "./automation/types";
import { AutomationModal } from "./ui/automation-modal";

export interface ToolkitSettings {
	modules: ModuleFlags;
	/** Allowlist. Empty means the whole vault, which is almost never what
	 * anybody wants -- see `core/scope.ts`. */
	includeFolders: string[];
	excludeFolders: string[];
	adrFolder: string;
	adrIndexNote: string;
	linkFromAdrIndex: boolean;
	incidentFolder: string;
	decisionFolder: string;
	infrastructureFolder: string;
	/** Written into `Owner:` on every created note. A wikilink, quoted by the
	 * frontmatter serialiser, matching what the vault's own templates carry. */
	owner: string;
	defaultTags: string[];
	orphanExemptFolders: string[];
	unusedTagThreshold: number;
	/** Where release notes live. Releases are the one record kind identified by
	 * location rather than by a `type` property. */
	releaseFolder: string;
	/** Where a reliability snapshot is written. */
	findingsFolder: string;
	/** Rolling window for the DORA figures. */
	doraWindowDays: number;
	/** How old a tested restore may be before `ET019` calls it stale. */
	restoreTestDays: number;
	/** Rule id -> enabled. Absent means enabled (§8.4). */
	rules: Record<string, boolean>;
	severity: Record<string, Severity>;
	automations: AutomationRule[];
	/** §9.7: a rule may fire this many times on one note per session before the
	 * loop guard stops it. */
	maxFiresPerNote: number;
	/** Milliseconds after an automated write during which that note's own
	 * modification events are ignored. */
	quietMs: number;
	scanOnStartup: boolean;
	showStatusBar: boolean;
}

export const DEFAULT_SETTINGS: ToolkitSettings = {
	modules: { adr: true, infrastructure: true, incidents: true, decisions: true, linter: true, automation: false, reliability: true },
	// Empty means the whole vault, so scope it after install. No folder ships as a
	// default, because one vault's folder name would silently match nothing elsewhere.
	includeFolders: [],
	excludeFolders: [],
	// Generic defaults under one parent so the create commands work on a fresh
	// install; point them at the folders you already keep these records in.
	adrFolder: "Engineering/Decision Records",
	adrIndexNote: "Engineering/Decision Records/Architecture Decision Records.md",
	linkFromAdrIndex: true,
	incidentFolder: "Engineering/Incidents",
	decisionFolder: "Engineering/Decisions",
	infrastructureFolder: "Engineering/Infrastructure",
	// Empty rather than a name. Whatever goes here is stamped onto every record the
	// create commands write, so a shipped default would sign one person's vault with
	// another person's name.
	owner: "",
	defaultTags: [],
	orphanExemptFolders: [],
	unusedTagThreshold: 2,
	releaseFolder: "Engineering/Releases",
	findingsFolder: "Engineering/Findings",
	// 90 days, because a shorter window often holds one release or none and turns
	// the change failure rate into a single data point.
	doraWindowDays: 90,
	restoreTestDays: 180,
	rules: {},
	severity: {},
	// Automation ships off. §9.7 requires explicit activation, and a feature
	// that writes to notes arriving switched on is the one thing that would make
	// this plugin unsafe to install and look at.
	automations: [],
	maxFiresPerNote: 3,
	quietMs: 4000,
	scanOnStartup: true,
	showStatusBar: true,
};

/** Split a comma-or-newline list the way a settings field is actually typed. */
export function parseList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((part) => part.trim())
		.filter(Boolean);
}

const MODULE_LABELS: Array<{ key: keyof ModuleFlags; name: string; desc: string }> = [
	{ key: "adr", name: "ADR Manager", desc: "Architecture decision records: numbering, statuses and an index." },
	{ key: "infrastructure", name: "Infrastructure", desc: "Services, databases, clusters and their dependencies. Documentation only — it never provisions, monitors or holds credentials." },
	{ key: "incidents", name: "Incident Manager", desc: "Incidents, severities, timelines and postmortems." },
	{ key: "decisions", name: "Decision Log", desc: "Smaller day-to-day decisions, promotable into an ADR." },
	{ key: "linter", name: "Vault Linter", desc: "Documentation checks over the indexed folders." },
	{ key: "reliability", name: "Reliability (SRE)", desc: "Tiers, SLOs and error budgets on infrastructure notes, the incident detection split, DORA from release notes, and the generated reliability snapshot. It reads nothing live — it records the promise, and the systems holding the telemetry measure whether it is kept." },
	{ key: "automation", name: "Workflow Automation", desc: "Event rules that write to notes. Off by default, and every rule you add is also off until you switch it on." },
];

export class ToolkitSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: EngineeringToolkitPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.modules(containerEl);
		this.scope(containerEl);
		this.folders(containerEl);
		this.reliability(containerEl);
		this.rules(containerEl);
		this.automation(containerEl);
		this.about(containerEl);
	}

	private modules(root: HTMLElement): void {
		new Setting(root).setName("Modules").setHeading();
		root.createEl("p", {
			cls: "setting-item-description",
			text: "Each module works on its own. Turning one off removes its commands and its dashboard section entirely — the section is not shown reading zero, because a count of zero and a module that is not running look identical and are different facts.",
		});

		for (const entry of MODULE_LABELS) {
			new Setting(root)
				.setName(entry.name)
				.setDesc(entry.desc)
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.modules[entry.key]).onChange(async (value) => {
						this.plugin.settings.modules[entry.key] = value;
						await this.plugin.saveSettings();
						this.plugin.refresh();
					})
				);
		}
	}

	private scope(root: HTMLElement): void {
		new Setting(root).setName("Scope").setHeading();

		new Setting(root)
			.setName("Indexed folders")
			.setDesc(`Comma-separated. Empty means the whole vault. Currently: ${describeScope(this.plugin.indexer.scope())}.`)
			.addTextArea((text) =>
				text
					.setPlaceholder("Engineering, Runbooks")
					.setValue(this.plugin.settings.includeFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.includeFolders = parseList(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(root)
			.setName("Excluded folders")
			.setDesc("Applied after the allowlist, so a folder can be carved out of an included tree.")
			.addTextArea((text) =>
				text.setValue(this.plugin.settings.excludeFolders.join(", ")).onChange(async (value) => {
					this.plugin.settings.excludeFolders = parseList(value);
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("Rescan")
			.setDesc("Changing the scope needs a rescan — the index only covers what was in scope when it was built.")
			.addButton((button) => button.setButtonText("Scan now").setCta().onClick(() => void this.plugin.scan()));

		new Setting(root)
			.setName("Scan on startup")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.scanOnStartup).onChange(async (value) => {
					this.plugin.settings.scanOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("Status bar item")
			.setDesc("Findings for the note you are looking at.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
					new Notice("Engineering Toolkit: reload Obsidian for the status bar change to take effect.");
				})
			);
	}

	private folders(root: HTMLElement): void {
		new Setting(root).setName("Where records are created").setHeading();

		const fields: Array<[keyof ToolkitSettings, string, string]> = [
			["adrFolder", "ADR folder", "Where new ADRs are written."],
			["incidentFolder", "Incident folder", "Where new incidents are written."],
			["decisionFolder", "Decision log folder", "Where new decision entries are written."],
			["infrastructureFolder", "Infrastructure folder", "Where new service, database and cluster notes are written."],
		];

		for (const [key, name, desc] of fields) {
			new Setting(root)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
						(this.plugin.settings as unknown as Record<string, unknown>)[key] = value.trim();
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(root)
			.setName("Link new ADRs from the index note")
			.setDesc("Appends one bullet to the `## Records` list. It only ever adds a line — nothing in that note is reordered, rewritten or removed.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.linkFromAdrIndex).onChange(async (value) => {
					this.plugin.settings.linkFromAdrIndex = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("ADR index note")
			.addText((text) =>
				text.setValue(this.plugin.settings.adrIndexNote).onChange(async (value) => {
					this.plugin.settings.adrIndexNote = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("Owner")
			.setDesc("Written into `Owner:` on every created note.")
			.addText((text) =>
				text.setValue(this.plugin.settings.owner).onChange(async (value) => {
					this.plugin.settings.owner = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("Default tags")
			.setDesc("Added to every created record, on top of the type's own tags.")
			.addText((text) =>
				text.setValue(this.plugin.settings.defaultTags.join(", ")).onChange(async (value) => {
					this.plugin.settings.defaultTags = parseList(value);
					await this.plugin.saveSettings();
				})
			);
	}

	private reliability(root: HTMLElement): void {
		new Setting(root).setName("Reliability").setHeading();
		root.createEl("p", {
			cls: "setting-item-description",
			text: "Every figure the toolkit reports is a count of notes, never a measurement of production. Nothing here queries Prometheus, Grafana, AWS or any running system — it records the contract, and the systems holding the telemetry measure whether it is kept.",
		});

		new Setting(root)
			.setName("Release folder")
			.setDesc("Release notes carry no `type` property, so they are identified by living here and having a `Release Time`. Index and dashboard notes in the same tree are not counted.")
			.addText((text) =>
				text.setValue(this.plugin.settings.releaseFolder).onChange(async (value) => {
					this.plugin.settings.releaseFolder = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("DORA window (days)")
			.setDesc("90 by default, not 30: this estate ships every three to four weeks, and a 30-day window would often hold one release or none — making a change failure rate of 0% or 100% out of a single data point.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.doraWindowDays)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.doraWindowDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.doraWindowDays;
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("Restore test freshness (days)")
			.setDesc("How old a `last_restore_test` may be before it is reported as stale. A backup that has never been restored is not a backup.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.restoreTestDays)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.restoreTestDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.restoreTestDays;
					await this.plugin.saveSettings();
					this.plugin.refresh();
				})
			);

		new Setting(root)
			.setName("Snapshot folder")
			.setDesc("Where `Write reliability snapshot` puts its dated note. Nothing is ever overwritten — each run is its own file.")
			.addText((text) =>
				text.setValue(this.plugin.settings.findingsFolder).onChange(async (value) => {
					this.plugin.settings.findingsFolder = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(root)
			.setName("Write a snapshot now")
			.addButton((button) => button.setButtonText("Write snapshot").setCta().onClick(() => void this.plugin.writeReliabilitySnapshot()));
	}

	private rules(root: HTMLElement): void {
		new Setting(root).setName("Linter rules").setHeading();
		root.createEl("p", {
			cls: "setting-item-description",
			text: "Every rule can be switched off and every severity can be overridden. The default severities follow one line: an error means the vault contradicts itself, a warning means one note is wrong, and info means the vault is drifting.",
		});

		for (const rule of RULES) {
			const current = this.plugin.settings.severity[rule.id] ?? rule.defaultSeverity;
			new Setting(root)
				.setName(rule.title)
				.setDesc(`${rule.code} — ${rule.description}`)
				.addDropdown((drop) =>
					drop
						.addOptions({ error: "Error", warning: "Warning", info: "Info" })
						.setValue(current)
						.onChange(async (value) => {
							this.plugin.settings.severity[rule.id] = value as Severity;
							await this.plugin.saveSettings();
							this.plugin.refresh();
						})
				)
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.rules[rule.id] !== false).onChange(async (value) => {
						this.plugin.settings.rules[rule.id] = value;
						await this.plugin.saveSettings();
						this.plugin.refresh();
					})
				);
		}

		new Setting(root)
			.setName("Orphan-exempt folders")
			.setDesc("Notes here are never reported as orphans. An index note nobody links into is a table of contents, not an orphan.")
			.addText((text) =>
				text.setValue(this.plugin.settings.orphanExemptFolders.join(", ")).onChange(async (value) => {
					this.plugin.settings.orphanExemptFolders = parseList(value);
					await this.plugin.saveSettings();
					this.plugin.refresh();
				})
			);
	}

	private automation(root: HTMLElement): void {
		new Setting(root).setName("Automation").setHeading();

		if (!this.plugin.settings.modules.automation) {
			root.createEl("p", { cls: "setting-item-description", text: "The automation module is off. Nothing below runs." });
		}

		root.createEl("p", {
			cls: "setting-item-description",
			text: "Every rule is created switched off. Preview shows exactly what a rule would do to the note you have open, using the same code that would perform it — a preview computed separately is a preview that can be wrong about the thing you are agreeing to.",
		});

		for (const rule of this.plugin.settings.automations) {
			const setting = new Setting(root)
				.setName(rule.name)
				.setDesc(`${rule.event}${rule.conditions.length ? ` · ${rule.conditions.length} condition${rule.conditions.length === 1 ? "" : "s"}` : ""} · ${rule.actions.length} action${rule.actions.length === 1 ? "" : "s"}`);

			setting.addButton((button) =>
				button
					.setButtonText("Preview")
					.setTooltip("Show what this would do to the active note, without writing anything")
					.onClick(() => void this.plugin.previewAutomation(rule))
			);
			setting.addButton((button) =>
				button.setButtonText("Edit").onClick(() => {
					new AutomationModal(this.app, rule, async (updated) => {
						const at = this.plugin.settings.automations.findIndex((r) => r.id === rule.id);
						if (at >= 0) this.plugin.settings.automations[at] = updated;
						await this.plugin.saveSettings();
						this.display();
					}).open();
				})
			);
			setting.addButton((button) =>
				button.setButtonText("Remove").setWarning().onClick(async () => {
					this.plugin.settings.automations = this.plugin.settings.automations.filter((r) => r.id !== rule.id);
					await this.plugin.saveSettings();
					this.display();
				})
			);
			setting.addToggle((toggle) =>
				toggle.setValue(rule.enabled).onChange(async (value) => {
					rule.enabled = value;
					await this.plugin.saveSettings();
				})
			);
		}

		new Setting(root).addButton((button) =>
			button
				.setButtonText("Add automation")
				.setCta()
				.onClick(() => {
					const rule: AutomationRule = {
						id: `rule-${Date.now().toString(36)}`,
						name: "New automation",
						enabled: false,
						event: EVENT_KINDS[0],
						conditions: [],
						actions: [],
					};
					new AutomationModal(this.app, rule, async (created) => {
						this.plugin.settings.automations.push(created);
						await this.plugin.saveSettings();
						this.display();
					}).open();
				})
		);

		new Setting(root)
			.setName("Loop guard: runs per note per session")
			.setDesc("How many times one rule may fire on one note before it is stopped and the reason written to the log.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.maxFiresPerNote)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.maxFiresPerNote = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.maxFiresPerNote;
					await this.plugin.saveSettings();
				})
			);

		const log = this.plugin.executionLog();
		new Setting(root).setName("Execution log").setDesc(log.length ? `${log.length} entries this session. Nothing is written to the vault.` : "Nothing has run this session.");
		if (log.length) {
			const list = root.createEl("ul", { cls: "et-log" });
			for (const entry of log.slice(-20).reverse()) {
				const item = list.createEl("li");
				item.createSpan({ cls: "et-log-rule", text: entry.ruleName });
				item.createSpan({ text: ` — ${entry.blocked ? `blocked: ${entry.blocked}` : entry.actions.join("; ")}` });
			}
		}
	}

	private about(root: HTMLElement): void {
		new Setting(root).setName("Secrets").setHeading();
		root.createEl("p", {
			cls: "setting-item-description",
			text: "There's no secrets detector here, on purpose. Scanning notes for credentials finds a leak after it has happened. Instead, keep secret values out of Markdown altogether: a note should say where a secret is stored and what it's for, never the value itself. Nothing in this plugin reads a note looking for a credential, and nothing in it sends note content anywhere.",
		});
	}
}

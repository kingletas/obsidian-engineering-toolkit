import { Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { Indexer, type IndexerOptions, type NoteChange } from "./core/indexer";
import { DEFAULT_PARSE_OPTIONS } from "./core/parser";
import { appendToListUnder, isoMinute, uniquePath } from "./core/notes";
import { nextAdrId, nextIncidentId, recordFilename } from "./core/ids";
import type { Issue, RecordKind } from "./core/types";
import { fixable, lint, RULES, type LintResult } from "./lint/linter";

/** The rules that belong to the reliability module, so switching the module off
 * removes its findings rather than leaving them behind as a section nobody can
 * turn off. Named by id here rather than flagged on the rule so the rule list
 * stays a plain list. */
const RELIABILITY_RULES = new Set([
	"tier-one-needs-slo",
	"slo-shape",
	"percentile-slo",
	"sla-tighter-than-slo",
	"untested-restore",
	"tier-one-needs-runbook",
	"tier-inversion",
	"weak-action-items",
	"detection-not-recorded",
]);
import { DEFAULT_SETTINGS, ToolkitSettingTab, type ToolkitSettings } from "./settings";
import { DashboardView, VIEW_TYPE_DASHBOARD, type Tab } from "./ui/dashboard-view";
import { CreateRecordModal, type CreateRequest } from "./ui/create-record-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { adrNote, decisionNote, incidentNote, infraNote } from "./templates";
import { promotionProps } from "./decisions/decision-engine";
import { LoopGuard, plan, type AutomationEvent } from "./automation/engine";
import { Runner } from "./automation/runner";
import type { AutomationRule, ExecutionEntry } from "./automation/types";
import { describeScope } from "./core/scope";
import { reliabilityReport } from "./reliability/report";
import { isoDate } from "./core/notes";

export default class EngineeringToolkitPlugin extends Plugin {
	settings: ToolkitSettings = { ...DEFAULT_SETTINGS };
	indexer!: Indexer;

	private lastLint: LintResult | null = null;
	private statusEl: HTMLElement | null = null;
	private unsubscribeIndex: (() => void) | null = null;
	private unsubscribeNotes: (() => void) | null = null;
	private guard!: LoopGuard;
	private runner!: Runner;
	private log: ExecutionEntry[] = [];

	async onload(): Promise<void> {
		await this.loadSettings();

		this.indexer = new Indexer(this.app, this.indexerOptions());
		this.guard = new LoopGuard(this.settings.maxFiresPerNote, this.settings.quietMs);
		this.runner = new Runner(this.app, (path) => this.guard.touched(path, Date.now()));

		this.registerView(VIEW_TYPE_DASHBOARD, (leaf: WorkspaceLeaf) => new DashboardView(leaf, this));
		this.registerCommands();
		this.addSettingTab(new ToolkitSettingTab(this.app, this));
		this.addRibbonIcon("hard-drive", "Engineering Toolkit", () => void this.openDashboard("overview"));

		if (this.settings.showStatusBar) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("et-status");
			this.statusEl.onclick = () => void this.openDashboard("findings");
		}

		this.registerEvent(this.app.metadataCache.on("changed", (file: TFile) => this.indexer.queue(file.path)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.indexer.remove(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.indexer.remove(oldPath);
				if (file instanceof TFile) void this.indexer.update(file, "moved", oldPath);
			})
		);

		// Not registerEvent, which calls `ref.e.offref(ref)` on unload and throws on a
		// plain unsubscribe function; onunload unsubscribes by hand.
		this.unsubscribeIndex = this.indexer.changed.on(() => this.afterIndex());
		this.unsubscribeNotes = this.indexer.noteChanged.on((change) => void this.onNoteChanged(change));

		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.scanOnStartup) return;
			// `resolved` fires once the link map is complete. Scanning before that
			// makes every link in the vault look broken for a few seconds, which
			// is a very convincing bug report about a plugin that is working.
			const ref = this.app.metadataCache.on("resolved", () => {
				this.app.metadataCache.offref(ref);
				void this.scan();
			});
			this.registerEvent(ref);
		});
	}

	onunload(): void {
		this.unsubscribeIndex?.();
		this.unsubscribeNotes?.();
		this.unsubscribeIndex = null;
		this.unsubscribeNotes = null;
		this.indexer.dispose();
	}

	// ---------------------------------------------------------------- settings

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<ToolkitSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(stored ?? {}),
			modules: { ...DEFAULT_SETTINGS.modules, ...(stored?.modules ?? {}) },
			rules: { ...(stored?.rules ?? {}) },
			severity: { ...(stored?.severity ?? {}) },
			// Force every stored automation off on load, so older or copied settings never
			// write to notes without explicit activation (§9.7).
			automations: (stored?.automations ?? []).map((rule) => ({ ...rule, enabled: false })),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.indexer.setOptions(this.indexerOptions());
	}

	private indexerOptions(): IndexerOptions {
		return {
			parse: { ...DEFAULT_PARSE_OPTIONS, releaseFolder: this.settings.releaseFolder },
			includeFolders: this.settings.includeFolders,
			excludeFolders: this.settings.excludeFolders,
		};
	}

	// ------------------------------------------------------------------ index

	async scan(): Promise<void> {
		const started = Date.now();
		await this.indexer.build();
		const result = this.relint();
		new Notice(
			`Engineering Toolkit: ${result.scannedNotes.toLocaleString()} notes in ${describeScope(this.indexer.scope())}, ${Date.now() - started}ms — ` +
				`${result.counts.error} errors, ${result.counts.warning} warnings, ${result.counts.info} info.`
		);
	}

	relint(): LintResult {
		const state = this.indexer.state();
		this.lastLint = this.settings.modules.linter
			? lint(state.index, state.carried, {
					enabled: this.settings.rules,
					severity: this.settings.severity,
					orphanExemptFolders: this.settings.orphanExemptFolders,
					unusedTagThreshold: this.settings.unusedTagThreshold,
					restoreTestDays: this.settings.restoreTestDays,
					rules: this.settings.modules.reliability ? undefined : RULES.filter((rule) => !RELIABILITY_RULES.has(rule.id)),
				})
			: { issues: [], counts: { error: 0, warning: 0, info: 0 }, byRule: {}, scannedNotes: state.index.notes.size, durationMs: 0 };
		return this.lastLint;
	}

	issues(): Issue[] {
		return (this.lastLint ?? this.relint()).issues;
	}

	private afterIndex(): void {
		this.relint();
		this.updateStatus();
	}

	refresh(): void {
		this.relint();
		this.updateStatus();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)) {
			const view = leaf.view;
			if (view instanceof DashboardView) view.render();
		}
	}

	private updateStatus(): void {
		if (!this.statusEl) return;
		const path = this.app.workspace.getActiveFile()?.path;
		const all = this.issues();
		const here = path ? all.filter((i) => i.path === path) : [];
		const errors = here.filter((i) => i.severity === "error").length;
		this.statusEl.setText(here.length === 0 ? "ET ✓" : `ET ${errors ? `${errors}✗ ` : ""}${here.length - errors ? `${here.length - errors}⚠` : ""}`.trim());
		this.statusEl.setAttr("aria-label", here.length === 0 ? `Engineering Toolkit: no findings here (${all.length} in scope)` : `Engineering Toolkit: ${here.length} findings in this note`);
	}

	// --------------------------------------------------------------- commands

	private registerCommands(): void {
		this.addCommand({ id: "scan", name: "Scan indexed folders", callback: () => void this.scan() });
		this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.openDashboard("overview") });
		this.addCommand({ id: "open-findings", name: "Show all findings", callback: () => void this.openDashboard("findings") });

		this.addCommand({
			id: "check-note",
			name: "Check current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.checkNote(file);
				return true;
			},
		});

		this.addCommand({ id: "create-adr", name: "New architecture decision record", callback: () => this.openCreate("adr") });
		this.addCommand({ id: "create-incident", name: "New incident", callback: () => this.openCreate("incident") });
		this.addCommand({ id: "create-decision", name: "New decision log entry", callback: () => this.openCreate("decision") });
		this.addCommand({ id: "create-infrastructure", name: "New infrastructure note", callback: () => this.openCreate("infrastructure") });

		this.addCommand({
			id: "resolve-incident",
			name: "Resolve this incident",
			checkCallback: (checking: boolean) => {
				const record = this.activeRecord("incident");
				if (!record) return false;
				if (!checking) void this.resolveIncident(record.path);
				return true;
			},
		});

		this.addCommand({
			id: "promote-decision",
			name: "Promote this decision to an ADR",
			checkCallback: (checking: boolean) => {
				const record = this.activeRecord("decision");
				if (!record) return false;
				if (!checking) void this.promoteDecision(record.path);
				return true;
			},
		});

		this.addCommand({ id: "fix-all", name: "Fix what can be fixed", callback: () => void this.fixAll() });

		this.addCommand({
			id: "reliability-snapshot",
			name: "Write reliability snapshot",
			checkCallback: (checking: boolean) => {
				if (!this.settings.modules.reliability) return false;
				if (!checking) void this.writeReliabilitySnapshot();
				return true;
			},
		});
	}

	private activeRecord(kind: RecordKind): { path: string } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return null;
		const record = this.indexer.state().index.notes.get(file.path);
		if (!record || record.kind !== kind) return null;
		if (!this.settings.modules[kind === "incident" ? "incidents" : "decisions"]) return null;
		return { path: file.path };
	}

	async checkNote(file: TFile): Promise<void> {
		await this.indexer.update(file);
		const state = this.indexer.state();
		const result = lint(state.index, state.carried, {
			enabled: this.settings.rules,
			severity: this.settings.severity,
			orphanExemptFolders: this.settings.orphanExemptFolders,
			unusedTagThreshold: this.settings.unusedTagThreshold,
			restoreTestDays: this.settings.restoreTestDays,
			rules: this.settings.modules.reliability ? undefined : RULES.filter((rule) => !RELIABILITY_RULES.has(rule.id)),
			only: file.path,
		});

		if (result.issues.length === 0) {
			const record = state.index.notes.get(file.path);
			new Notice(record?.kind ? `Engineering Toolkit: ${file.basename} is a clean ${record.type}.` : "Engineering Toolkit: no findings. This note is not a record type the toolkit knows, so only the general checks applied.");
			return;
		}

		const lines = result.issues.slice(0, 6).map((issue) => `${issue.severity.toUpperCase()} ${issue.message}`);
		if (result.issues.length > 6) lines.push(`…and ${result.issues.length - 6} more.`);
		new Notice(`Engineering Toolkit — ${file.basename}\n${lines.join("\n")}`, 10000);
		void this.openDashboard("findings");
	}

	async openDashboard(tab: Tab): Promise<void> {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)[0] ?? this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
		this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof DashboardView) view.setTab(tab);
	}

	async open(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
	}

	// ------------------------------------------------------------- creating

	private openCreate(kind: RecordKind): void {
		const index = this.indexer.state().index;
		const services = [...index.notes.values()].filter((note) => note.kind === "infrastructure").map((note) => note.basename);
		new CreateRecordModal(this.app, kind, {
			previewId: kind === "adr" ? nextAdrId(index) : kind === "incident" ? nextIncidentId(index, new Date().getFullYear()) : null,
			services,
			linkFromIndexDefault: this.settings.linkFromAdrIndex,
			onSubmit: (request) => this.createRecord(request),
		}).open();
	}

	private async createRecord(request: CreateRequest): Promise<void> {
		const now = new Date();
		const index = this.indexer.state().index;
		const tags = this.settings.defaultTags;

		let folder: string;
		let name: string;
		let body: string;

		switch (request.kind) {
			case "adr": {
				const id = nextAdrId(index);
				folder = this.settings.adrFolder;
				name = recordFilename(id, request.title);
				body = adrNote({ id, title: request.title.trim(), status: request.status, date: now, owner: this.settings.owner, tags: unique([...tags, "adr", "decisions"]) });
				break;
			}
			case "incident": {
				const id = nextIncidentId(index, now.getFullYear());
				folder = this.settings.incidentFolder;
				name = recordFilename(id, request.title);
				body = incidentNote({
					id,
					title: request.title.trim(),
					severity: request.severity,
					status: request.status,
					started: now,
					service: request.service || undefined,
					owner: this.settings.owner,
					tags: unique([...tags, "incident"]),
					detectedBy: request.detectedBy,
				});
				break;
			}
			case "decision": {
				folder = this.settings.decisionFolder;
				name = `Decision — ${request.title.trim()}`;
				body = decisionNote({ title: request.title.trim(), date: now, owner: this.settings.owner, tags: unique([...tags, "decision"]) });
				break;
			}
			default: {
				folder = this.settings.infrastructureFolder;
				name = request.title.trim();
				body = infraNote({
					type: request.type,
					title: request.title.trim(),
					environment: request.environment,
					owner: this.settings.owner,
					dependencies: request.dependencies,
					tags: unique([...tags, "infrastructure", request.type]),
					tier: request.tier,
					slo: request.slo,
				});
			}
		}

		const file = await this.writeNote(folder, name, body);
		if (!file) return;

		if (request.kind === "adr" && request.linkFromIndex) await this.linkFromAdrIndex(file.basename);

		await this.app.workspace.getLeaf("tab").openFile(file);
		this.indexer.queue(file.path);
	}

	/** Create a note, never overwrite one. `uniquePath` is what makes that true:
	 * a collision produces `Name 2.md` rather than replacing whatever was there. */
	private async writeNote(folder: string, name: string, body: string): Promise<TFile | null> {
		const target = normalizePath(folder.replace(/\/+$/, ""));
		if (target && !(await this.app.vault.adapter.exists(target))) {
			await this.app.vault.createFolder(target).catch(() => undefined);
		}
		try {
			const path = uniquePath(target, name, (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null);
			const file = await this.app.vault.create(path, body);
			return file;
		} catch (error) {
			new Notice(`Engineering Toolkit: could not create the note — ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	/** Append one bullet to the ADR index note's `## Records` list, leaving the note
	 * untouched when that heading is missing. */
	private async linkFromAdrIndex(basename: string): Promise<void> {
		const path = normalizePath(this.settings.adrIndexNote);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const current = await this.app.vault.read(file);
		const updated = appendToListUnder(current, "Records", `- [[${basename}]]`);
		if (updated === null) {
			new Notice(`Engineering Toolkit: ${file.basename} has no "## Records" heading, so it was left alone.`);
			return;
		}
		if (updated !== current) await this.app.vault.modify(file, updated);
	}

	// ------------------------------------------------------- record workflows

	/** Close out an incident: stamp `resolved`, set the status, and say what is
	 * still missing. It never writes the postmortem -- an empty Root Cause
	 * section filled in by a plugin is worse than an absent one, because it
	 * reads as answered. */
	private async resolveIncident(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const stamp = isoMinute(new Date());
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.status = "resolved";
			if (!fm.resolved) fm.resolved = stamp;
		});
		this.indexer.queue(path);

		const record = this.indexer.state().index.notes.get(path);
		const missing = ["root cause", "resolution", "follow-up actions"].filter((section) => !(record?.headings ?? []).some((h) => h.startsWith(section)));
		new Notice(missing.length ? `Resolved at ${stamp}. The postmortem still needs: ${missing.join(", ")}.` : `Resolved at ${stamp}.`);
	}

	/** Promote a decision into an ADR (§7.4), leaving the decision in place marked
	 * superseded and linked forward. */
	private async promoteDecision(path: string): Promise<void> {
		const source = this.indexer.state().index.notes.get(path);
		if (!source) return;
		const title = source.title.replace(/^Decision\s*[—–-]\s*/i, "").trim() || source.basename;
		const id = nextAdrId(this.indexer.state().index);

		new ConfirmModal(this.app, {
			title: "Promote to an ADR",
			intro: `This creates ${id} and marks the decision superseded. The decision note stays where it is — nothing is moved or deleted.`,
			lines: [
				`create ${this.settings.adrFolder}/${recordFilename(id, title)}.md`,
				`set \`status: superseded\` and \`promoted_to: ${id}\` on ${path}`,
				...(this.settings.linkFromAdrIndex ? [`append one bullet to ${this.settings.adrIndexNote}`] : []),
			],
			confirmText: "Promote",
			onConfirm: async () => {
				const body = adrNote({
					id,
					title,
					status: "proposed",
					date: new Date(),
					owner: this.settings.owner,
					tags: unique([...this.settings.defaultTags, "adr", "decisions"]),
					context: `Promoted from the decision log entry [[${source.basename}]], recorded ${source.props.date ?? "earlier"}. Restate the forces in tension here — a promoted decision that keeps only its conclusion has lost the reason it was promoted.`,
				});
				const file = await this.writeNote(this.settings.adrFolder, recordFilename(id, title), body);
				if (!file) return;

				const decision = this.app.vault.getAbstractFileByPath(path);
				if (decision instanceof TFile) {
					await this.app.fileManager.processFrontMatter(decision, (fm: Record<string, unknown>) => {
						Object.assign(fm, promotionProps(id));
					});
				}
				if (this.settings.linkFromAdrIndex) await this.linkFromAdrIndex(file.basename);
				await this.app.workspace.getLeaf("tab").openFile(file);
				this.indexer.queue(file.path);
				this.indexer.queue(path);
			},
		}).open();
	}

	// ---------------------------------------------------------- reliability

	/** Render the snapshot and write it as a new dated note, never overwriting an earlier one. */
	async writeReliabilitySnapshot(): Promise<void> {
		const state = this.indexer.state();
		if (state.index.notes.size === 0) {
			new Notice("Engineering Toolkit: nothing is indexed yet — scan first.");
			return;
		}
		const now = new Date();
		const body = reliabilityReport(state.index, this.issues(), {
			now: now.getTime(),
			isoDate: isoDate(now),
			windowDays: this.settings.doraWindowDays,
			scope: describeScope(this.indexer.scope()),
			restoreTestDays: this.settings.restoreTestDays,
		});

		const file = await this.writeNote(this.settings.findingsFolder, `reliability-snapshot-${isoDate(now)}`, body);
		if (!file) return;
		await this.app.workspace.getLeaf("tab").openFile(file);
		this.indexer.queue(file.path);
		new Notice(`Engineering Toolkit: wrote ${file.path}. Every figure in it is a count of notes, not a measurement of production.`);
	}

	// -------------------------------------------------------------- autofix

	async fixOne(issue: Issue): Promise<void> {
		if (!issue.fix) return;
		new ConfirmModal(this.app, {
			title: "Apply fix",
			lines: [`${issue.fix.label} in ${issue.path}`],
			confirmText: "Apply",
			warning: issue.fix.destructive ? "This replaces a value you wrote." : undefined,
			onConfirm: () => this.applyFixes([issue]),
		}).open();
	}

	/** §8.5. The batch contains only the non-destructive fixes; a destructive one
	 * is never part of a group, because a dialog listing forty changes is a
	 * dialog nobody reads and "I confirmed it" then means "I clicked past it". */
	async fixAll(): Promise<void> {
		const { safe, destructive } = fixable(this.issues());
		if (safe.length === 0) {
			new Notice(destructive.length ? `Engineering Toolkit: nothing safe to fix. ${destructive.length} finding(s) need a decision and are offered one at a time.` : "Engineering Toolkit: nothing to fix.");
			return;
		}
		new ConfirmModal(this.app, {
			title: `Apply ${safe.length} fix${safe.length === 1 ? "" : "es"}`,
			intro: "Each one writes a single frontmatter property through Obsidian's own API. Note bodies are not touched.",
			lines: safe.map((issue) => `${issue.fix?.label} in ${issue.path}`),
			confirmText: "Apply",
			warning: destructive.length ? `${destructive.length} further finding(s) need a decision and are not included here.` : undefined,
			onConfirm: () => this.applyFixes(safe),
		}).open();
	}

	private async applyFixes(issues: Issue[]): Promise<void> {
		let applied = 0;
		for (const issue of issues) {
			const file = this.app.vault.getAbstractFileByPath(issue.path);
			if (!(file instanceof TFile) || !issue.fix) continue;
			const fix = issue.fix;
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				// `undefined` removes the key; every other value is written as-is.
				if (fix.value === undefined) delete fm[fix.property];
				else fm[fix.property] = fix.value;
			});
			this.indexer.queue(issue.path);
			applied += 1;
		}
		new Notice(`Engineering Toolkit: applied ${applied} fix${applied === 1 ? "" : "es"}.`);
	}

	// ------------------------------------------------------------ automation

	executionLog(): ExecutionEntry[] {
		return this.log;
	}

	/** Dry-run one rule against the active note, through the same planner the
	 * real run uses. */
	async previewAutomation(rule: AutomationRule): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const record = file ? this.indexer.state().index.notes.get(file.path) : undefined;
		if (!record) {
			new Notice("Engineering Toolkit: open an indexed note to preview an automation against it.");
			return;
		}
		// Previewed as if enabled, whatever the stored flag says. Otherwise the
		// only way to see what a rule does is to switch it on first, which is
		// exactly backwards.
		const event: AutomationEvent = { kind: rule.event, note: record, property: rule.watchProperty, tag: record.tags[0] };
		const planned = plan([{ ...rule, enabled: true }], event, new Date());
		const result = await this.runner.run(planned, true);

		new ConfirmModal(this.app, {
			title: `Preview — ${rule.name}`,
			intro: result.performed.length ? `If \`${rule.event.replace(/-/g, " ")}\` fired for ${record.path}, this rule would:` : `Nothing matched for ${record.path}. This rule would do nothing to this note.`,
			lines: result.performed,
			confirmText: "Close",
			onConfirm: () => undefined,
		}).open();
	}

	private async onNoteChanged(change: NoteChange): Promise<void> {
		if (!this.settings.modules.automation) return;
		if (!change.record) return;
		const enabled = this.settings.automations.filter((rule) => rule.enabled);
		if (enabled.length === 0) return;

		const now = Date.now();
		for (const event of eventsFor(change)) {
			for (const rule of enabled) {
				const planned = plan([rule], event, new Date());
				if (planned.length === 0) continue;

				const blocked = this.guard.blocked(rule, change.record.path, now);
				if (blocked) {
					this.log.push({ at: now, ruleId: rule.id, ruleName: rule.name, path: change.record.path, actions: [], blocked });
					continue;
				}
				this.guard.record(rule, change.record.path);
				const result = await this.runner.run(planned, false);
				this.log.push({
					at: now,
					ruleId: rule.id,
					ruleName: rule.name,
					path: change.record.path,
					actions: [...result.performed, ...result.skipped.map((line) => `${line} (no change needed)`), ...result.failed.map((line) => `FAILED ${line}`)],
				});
				if (result.failed.length) new Notice(`Engineering Toolkit: ${rule.name} failed — ${result.failed[0]}`);
			}
		}
		// The log is memory-only and capped. Writing it to a note would make the
		// log itself a note-creating automation, which would appear in its own
		// log, which is the sort of thing that is funny exactly once.
		if (this.log.length > 500) this.log = this.log.slice(-500);
	}
}

/** One index change can be several automation events -- a save that both moves a
 * note and changes a property is both. Expanding here rather than in the engine
 * keeps the engine a pure function of one event. */
function eventsFor(change: NoteChange): AutomationEvent[] {
	if (!change.record) return [];
	const note = change.record;
	const out: AutomationEvent[] = [];
	if (change.kind === "created") out.push({ kind: "note-created", note });
	if (change.kind === "moved") out.push({ kind: "note-moved", note, fromPath: change.fromPath });
	if (change.kind === "modified") out.push({ kind: "note-modified", note });
	for (const property of change.changedProperties) out.push({ kind: "property-changed", note, property, previous: change.previous?.props[property] });
	for (const tag of change.addedTags) out.push({ kind: "tag-added", note, tag });
	// Obsidian has no checkbox event, so `task-completed` fires once per save when
	// the completed-task count goes up.
	if (change.previous && note.tasksDone > change.previous.tasksDone) out.push({ kind: "task-completed", note });
	return out;
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

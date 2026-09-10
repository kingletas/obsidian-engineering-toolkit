import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type EngineeringToolkitPlugin from "../main";
import { adrIndex } from "../adr/adr-engine";
import { incidents, incidentStats } from "../incidents/incident-engine";
import { decisions } from "../decisions/decision-engine";
import { blastRadius, infraGraph, infraStats, renderTree, tierInversions } from "../infra/infra-engine";
import { budgetMinutes, formatBudget } from "../reliability/slo";
import { dora, formatMinutes, releases, verdict } from "../reliability/dora";
import { bar, dashboard, duration } from "../dashboard/dashboard-engine";
import { groupByPath } from "../lint/linter";
import { describeScope } from "../core/scope";
import type { Issue } from "../core/types";

export const VIEW_TYPE_DASHBOARD = "engineering-toolkit-dashboard";

export type Tab = "overview" | "adr" | "infrastructure" | "reliability" | "incidents" | "decisions" | "findings";

/** The §13 dashboard, with one tab per module and a combined overview; a module
 * that is off gets no section rather than a section of zeroes. */
export class DashboardView extends ItemView {
	private tab: Tab = "overview";
	private unsubscribe: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: EngineeringToolkitPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DASHBOARD;
	}

	getDisplayText(): string {
		return "Engineering Toolkit";
	}

	getIcon(): string {
		return "hard-drive";
	}

	async onOpen(): Promise<void> {
		this.unsubscribe = this.plugin.indexer.changed.on(() => this.render());
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	setTab(tab: Tab): void {
		this.tab = tab;
		this.render();
	}

	render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("engineering-toolkit");

		const { modules } = this.plugin.settings;
		const state = this.plugin.indexer.state();
		const issues = this.plugin.issues();

		const header = root.createDiv({ cls: "et-header" });
		const title = header.createDiv({ cls: "et-title" });
		setIcon(title.createSpan({ cls: "et-title-icon" }), "hard-drive");
		title.createSpan({ text: "Engineering Toolkit" });
		header.createDiv({
			cls: "et-header-meta",
			// The scope is named next to the count, always. A number with no
			// denominator on it reads as a whole-vault figure.
			text: `${state.index.notes.size.toLocaleString()} notes in ${describeScope(this.plugin.indexer.scope())}`,
		});
		const actions = header.createDiv({ cls: "et-actions" });
		const scan = actions.createEl("button", { text: "Scan" });
		scan.onclick = () => void this.plugin.scan();

		const tabs: Array<[Tab, string, boolean]> = [
			["overview", "Overview", true],
			["adr", "ADRs", modules.adr],
			["infrastructure", "Infrastructure", modules.infrastructure],
			["reliability", "Reliability", modules.reliability],
			["incidents", "Incidents", modules.incidents],
			["decisions", "Decisions", modules.decisions],
			["findings", "Findings", modules.linter],
		];
		const bar_ = root.createDiv({ cls: "et-tabs" });
		for (const [id, label, shown] of tabs) {
			if (!shown) continue;
			const button = bar_.createEl("button", { cls: `et-tab${this.tab === id ? " is-active" : ""}`, text: label });
			button.onclick = () => this.setTab(id);
		}
		// A tab whose module was switched off while it was open would render an
		// empty pane forever otherwise.
		if (!tabs.some(([id, , shown]) => id === this.tab && shown)) this.tab = "overview";

		const body = root.createDiv({ cls: "et-body" });
		switch (this.tab) {
			case "adr":
				this.renderAdrs(body);
				break;
			case "infrastructure":
				this.renderInfrastructure(body);
				break;
			case "reliability":
				this.renderReliability(body);
				break;
			case "incidents":
				this.renderIncidents(body);
				break;
			case "decisions":
				this.renderDecisions(body);
				break;
			case "findings":
				this.renderFindings(body, issues);
				break;
			default:
				this.renderOverview(body, issues);
		}
	}

	// ------------------------------------------------------------- overview

	private renderOverview(root: HTMLElement, issues: Issue[]): void {
		const data = dashboard(this.plugin.indexer.state().index, issues, this.plugin.settings.modules);

		if (data.adr) {
			this.section(root, "Decisions of record", [
				["Total", String(data.adrTotal)],
				...Object.entries(data.adr).map(([status, count]): [string, string] => [status, String(count)]),
			]);
		}
		if (data.infrastructure) {
			this.section(root, "Infrastructure", [
				["Total", String(data.infrastructure.total)],
				...Object.entries(data.infrastructure.byType).map(([type, count]): [string, string] => [type, String(count)]),
				["No environment", String(data.infrastructure.unplaced)],
			]);
		}
		if (data.incidents) {
			this.section(root, "Incidents", [
				["Total", String(data.incidentTotal)],
				["Open or investigating", String(data.incidents.open)],
				["Median time to resolve", duration(data.incidents.medianMinutes)],
				["Resolved without a postmortem", String(data.incidents.missingPostmortem.length)],
			]);
		}
		if (data.decisions) {
			this.section(root, "Decision log", [
				["Total", String(data.decisionTotal)],
				...Object.entries(data.decisions).map(([status, count]): [string, string] => [status, String(count)]),
			]);
		}
		if (data.findings) {
			this.section(root, "Documentation", [
				["Errors", String(data.findings.error)],
				["Warnings", String(data.findings.warning)],
				["Info", String(data.findings.info)],
			]);
		}

		const note = root.createEl("p", { cls: "et-muted" });
		note.setText(
			"Sections appear only for modules that are switched on. Nothing here is a measurement of production — every number is a count of notes, and a vault that documents nothing scores the same as one with nothing to document."
		);
	}

	private section(root: HTMLElement, heading: string, rows: Array<[string, string]>): void {
		root.createEl("h3", { cls: "et-section", text: heading });
		const table = root.createEl("table", { cls: "et-table" });
		for (const [label, value] of rows) {
			const row = table.createEl("tr");
			row.createEl("td", { text: label, cls: "et-dim" });
			row.createEl("td", { text: value, cls: "et-num" });
		}
	}

	// ------------------------------------------------------------------ ADR

	private renderAdrs(root: HTMLElement): void {
		const rows = adrIndex(this.plugin.indexer.state().index);
		if (rows.length === 0) return this.empty(root, "No ADRs in the indexed folders yet.");

		const table = root.createEl("table", { cls: "et-table et-wide" });
		const head = table.createEl("tr");
		for (const label of ["ID", "Decision", "Status", ""]) head.createEl("th", { text: label });

		for (const entry of rows) {
			const row = table.createEl("tr");
			row.createEl("td", { text: entry.id, cls: "et-id" });
			const link = row.createEl("td").createEl("a", { text: entry.title, cls: "et-link" });
			link.onclick = () => void this.plugin.open(entry.note.path);
			row.createEl("td", { text: entry.status, cls: `et-status et-status-${entry.status}` });
			const trail = row.createEl("td", { cls: "et-muted" });
			if (entry.supersededBy) trail.setText(`superseded by ${basename(entry.supersededBy)}`);
			else if (entry.supersedes.length) trail.setText(`supersedes ${entry.supersedes.map(basename).join(", ")}`);
		}
	}

	// --------------------------------------------------------- infrastructure

	private renderInfrastructure(root: HTMLElement): void {
		const graph = infraGraph(this.plugin.indexer.state().index);
		if (graph.nodes.size === 0) return this.empty(root, "No infrastructure notes in the indexed folders yet.");

		const stats = infraStats(graph);
		root.createEl("h3", { cls: "et-section", text: "By environment" });
		const table = root.createEl("table", { cls: "et-table et-wide" });
		for (const [environment, byType] of Object.entries(stats.byEnvironment)) {
			const total = Object.values(byType).reduce((sum, n) => sum + n, 0);
			const row = table.createEl("tr");
			row.createEl("td", { text: environment, cls: "et-dim" });
			row.createEl("td", { text: bar(stats.total ? total / stats.total : 0), cls: "et-bar" });
			row.createEl("td", { text: String(total), cls: "et-num" });
			row.createEl("td", { cls: "et-muted", text: Object.entries(byType).map(([type, n]) => `${n} ${type}`).join(", ") });
		}

		root.createEl("h3", { cls: "et-section", text: "Dependencies" });
		for (const rootNode of graph.roots) {
			const block = root.createEl("pre", { cls: "et-tree" });
			block.setText(renderTree(graph, rootNode).join("\n"));
		}
		if (graph.roots.length === 0) {
			// Every node has a dependent, which means the graph is entirely
			// cycles. Saying so beats rendering nothing.
			this.empty(root, "Every infrastructure note is depended on by another, so there is no root to draw a tree from. That usually means a dependency cycle.");
		}
	}

	// ----------------------------------------------------------- reliability

	/** The contract, the blast radius and three of the four DORA keys, all counted
	 * from notes, which the pane states at the bottom. */
	private renderReliability(root: HTMLElement): void {
		const index = this.plugin.indexer.state().index;
		const graph = infraGraph(index);
		const nodes = [...graph.nodes.values()];
		if (nodes.length === 0) return this.empty(root, "No infrastructure notes in the indexed folders yet, so there is no contract to show.");

		const tierOne = nodes.filter((n) => n.reliability.tier === 1);
		const withSlo = nodes.filter((n) => n.reliability.slos.length > 0);

		root.createEl("h3", { cls: "et-section", text: "Contract" });
		const table = root.createEl("table", { cls: "et-table et-wide" });
		const head = table.createEl("tr");
		for (const label of ["Component", "Tier", "Objective", "Budget", "RTO", ""]) head.createEl("th", { text: label });

		for (const node of [...nodes].sort((a, b) => (a.reliability.tier ?? 9) - (b.reliability.tier ?? 9) || a.name.localeCompare(b.name))) {
			const r = node.reliability;
			const row = table.createEl("tr");
			const link = row.createEl("td").createEl("a", { text: node.name, cls: "et-link" });
			link.onclick = () => void this.plugin.open(node.note.path);
			row.createEl("td", { text: r.tier === null ? "—" : `T${r.tier}`, cls: "et-num" });
			row.createEl("td", { text: r.slos.length ? r.slos.map((s) => s.raw).join(" · ") : "—" });
			row.createEl("td", { text: r.slos.length ? r.slos.map((s) => formatBudget(budgetMinutes(s))).join(" · ") : "—", cls: "et-num" });
			row.createEl("td", { text: r.rto === null ? "—" : formatMinutes(r.rto), cls: "et-num" });
			// The gaps, named rather than left as blanks in the row above.
			const gaps: string[] = [];
			if (r.tier === 1 && r.slos.length === 0) gaps.push("no SLO");
			if (r.tier === 1 && !r.runbook) gaps.push("no runbook");
			if (r.rto !== null && !r.lastRestoreTest) gaps.push("restore untested");
			row.createEl("td", { cls: "et-muted", text: gaps.join(", ") });
		}

		this.section(root, "Coverage", [
			["Graded", `${nodes.filter((n) => n.reliability.tier !== null).length}/${nodes.length}`],
			["Tier 1 with an objective", tierOne.length === 0 ? "—" : `${withSlo.filter((n) => n.reliability.tier === 1).length}/${tierOne.length}`],
			["With a runbook", `${nodes.filter((n) => n.reliability.runbook).length}/${nodes.length}`],
			["RTO stated", `${nodes.filter((n) => n.reliability.rto !== null).length}/${nodes.length}`],
		]);

		const inversions = tierInversions(graph);
		if (inversions.length) {
			root.createEl("h3", { cls: "et-section", text: "Tier inversions" });
			root.createEl("p", { cls: "et-muted", text: "A component resting on something less reliable than itself. Invisible on either note alone — each page is internally consistent." });
			const inv = root.createEl("table", { cls: "et-table et-wide" });
			for (const entry of inversions) {
				const row = inv.createEl("tr");
				row.createEl("td", { text: `${entry.node.name} (T${entry.node.reliability.tier})` });
				row.createEl("td", { text: "rests on", cls: "et-muted" });
				row.createEl("td", { text: `${entry.dependency.name} (T${entry.dependency.reliability.tier})` });
			}
		}

		const ranked = nodes
			.map((node) => ({ node, affected: blastRadius(graph, node.note.path) }))
			.filter((entry) => entry.affected.length > 0)
			.sort((a, b) => b.affected.length - a.affected.length);
		if (ranked.length) {
			root.createEl("h3", { cls: "et-section", text: "Blast radius" });
			const blast = root.createEl("table", { cls: "et-table et-wide" });
			const bhead = blast.createEl("tr");
			for (const label of ["If unavailable", "Affected", "Tier 1"]) bhead.createEl("th", { text: label });
			for (const entry of ranked.slice(0, 10)) {
				const row = blast.createEl("tr");
				const link = row.createEl("td").createEl("a", { text: entry.node.name, cls: "et-link" });
				link.onclick = () => void this.plugin.open(entry.node.note.path);
				row.createEl("td", { text: String(entry.affected.length), cls: "et-num" });
				row.createEl("td", { text: String(entry.affected.filter((n) => n.reliability.tier === 1).length), cls: "et-num" });
			}
		}

		const now = Date.now();
		const report = dora(releases(index, now), incidents(index), now, this.plugin.settings.doraWindowDays);
		root.createEl("h3", { cls: "et-section", text: `Delivery — last ${report.windowDays} days` });
		const doraTable = root.createEl("table", { cls: "et-table et-wide" });
		for (const metric of report.metrics) {
			const row = doraTable.createEl("tr");
			row.createEl("td", { text: metric.label, cls: "et-dim" });
			row.createEl("td", { text: metric.value ?? "no data", cls: "et-num" });
			row.createEl("td", { text: verdict(metric.band) });
			row.createEl("td", { cls: "et-muted", text: metric.basis });
		}

		const actions = root.createDiv({ cls: "et-actions et-actions-left" });
		const snapshot = actions.createEl("button", { text: "Write reliability snapshot" });
		snapshot.onclick = () => void this.plugin.writeReliabilitySnapshot();

		root.createEl("p", {
			cls: "et-muted",
			text: "Every figure here is a count of notes, not a measurement of production. Nothing was read from Prometheus, Grafana or AWS — this records the promise; the systems holding the telemetry measure whether it is kept. A metric reading “no data” means nothing was recorded, not that the value is zero.",
		});
	}

	// ------------------------------------------------------------- incidents

	private renderIncidents(root: HTMLElement): void {
		const rows = incidents(this.plugin.indexer.state().index);
		if (rows.length === 0) return this.empty(root, "No incidents in the indexed folders yet.");
		const stats = incidentStats(rows);

		this.section(root, "Severity", Object.entries(stats.bySeverity).map(([severity, count]): [string, string] => [severity, String(count)]));

		root.createEl("h3", { cls: "et-section", text: "Incidents" });
		const table = root.createEl("table", { cls: "et-table et-wide" });
		const head = table.createEl("tr");
		for (const label of ["ID", "Incident", "Sev", "Status", "Duration", ""]) head.createEl("th", { text: label });

		for (const entry of [...rows].reverse()) {
			const row = table.createEl("tr");
			row.createEl("td", { text: entry.id, cls: "et-id" });
			const link = row.createEl("td").createEl("a", { text: entry.title, cls: "et-link" });
			link.onclick = () => void this.plugin.open(entry.note.path);
			row.createEl("td", { text: entry.severity, cls: "et-num" });
			row.createEl("td", { text: entry.status, cls: `et-status et-status-${entry.status}` });
			row.createEl("td", { text: duration(entry.durationMinutes), cls: "et-num" });
			row.createEl("td", { cls: "et-muted", text: entry.postmortemComplete ? "" : entry.status === "resolved" || entry.status === "closed" ? "no postmortem" : "" });
		}
	}

	// ------------------------------------------------------------- decisions

	private renderDecisions(root: HTMLElement): void {
		const rows = decisions(this.plugin.indexer.state().index);
		if (rows.length === 0) return this.empty(root, "No decision log entries in the indexed folders yet.");

		const table = root.createEl("table", { cls: "et-table et-wide" });
		const head = table.createEl("tr");
		for (const label of ["Date", "Decision", "Status", ""]) head.createEl("th", { text: label });

		for (const entry of rows) {
			const row = table.createEl("tr");
			row.createEl("td", { text: entry.date ?? "—", cls: "et-num" });
			const link = row.createEl("td").createEl("a", { text: entry.title, cls: "et-link" });
			link.onclick = () => void this.plugin.open(entry.note.path);
			row.createEl("td", { text: entry.status, cls: `et-status et-status-${entry.status}` });
			row.createEl("td", { cls: "et-muted", text: entry.promotedTo ? `promoted to ${basename(entry.promotedTo)}` : "" });
		}
	}

	// -------------------------------------------------------------- findings

	private renderFindings(root: HTMLElement, issues: Issue[]): void {
		if (issues.length === 0) return this.empty(root, "No findings. Every indexed record is consistent with its type.");

		const actions = root.createDiv({ cls: "et-actions et-actions-left" });
		const fix = actions.createEl("button", { text: "Fix what can be fixed" });
		fix.onclick = () => void this.plugin.fixAll();

		for (const group of groupByPath(issues)) {
			const block = root.createDiv({ cls: "et-group" });
			const heading = block.createEl("div", { cls: "et-group-head" });
			const link = heading.createEl("a", { text: group.path || "(vault)", cls: "et-link" });
			if (group.path) link.onclick = () => void this.plugin.open(group.path);
			heading.createSpan({ cls: "et-muted", text: ` ${group.issues.length}` });

			for (const issue of group.issues) {
				const row = block.createDiv({ cls: `et-issue et-${issue.severity}` });
				row.createSpan({ cls: "et-code", text: issue.code });
				row.createSpan({ cls: "et-message", text: issue.message });
				if (issue.hint) row.createDiv({ cls: "et-hint", text: issue.hint });
				if (issue.fix) {
					const button = row.createEl("button", { cls: "et-fix", text: issue.fix.label });
					button.onclick = () => void this.plugin.fixOne(issue);
				}
			}
		}
	}

	private empty(root: HTMLElement, text: string): void {
		root.createEl("p", { cls: "et-muted", text });
	}
}

function basename(path: string): string {
	return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

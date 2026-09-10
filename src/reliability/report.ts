// The reliability snapshot as Markdown, pure so every number is reproducible in
// a test. Every figure is a count of notes, not a measurement of production,
// and the report says so on its face.

import type { Issue, ToolkitIndex } from "../core/types";
import { blastRadius, infraGraph, tierInversions, type InfraGraph, type InfraNode } from "../infra/infra-engine";
import { incidents, incidentStats } from "../incidents/incident-engine";
import { adrIndex } from "../adr/adr-engine";
import { budgetMinutes, formatBudget, type SloTarget } from "./slo";
import { dora, formatMinutes, releases, verdict } from "./dora";

export interface ReportOptions {
	/** Epoch milliseconds. Passed in rather than read, so the report is
	 * deterministic under test. */
	now: number;
	/** Rendered into the frontmatter and the title. */
	isoDate: string;
	windowDays: number;
	scope: string;
	/** How stale a restore test may be before it is called stale. */
	restoreTestDays: number;
}

const NL = "\n";

export function reliabilityReport(index: ToolkitIndex, issues: Issue[], options: ReportOptions): string {
	const graph = infraGraph(index);
	const nodes = [...graph.nodes.values()];
	const incidentRows = incidents(index);
	const stats = incidentStats(incidentRows);
	const releaseRows = releases(index, options.now);
	const doraReport = dora(releaseRows, incidentRows, options.now, options.windowDays);

	const tiered = nodes.filter((node) => node.reliability.tier !== null);
	const tierOne = nodes.filter((node) => node.reliability.tier === 1);
	const withSlo = nodes.filter((node) => node.reliability.slos.length > 0);
	const inversions = tierInversions(graph);

	const out: string[] = [];
	const push = (...lines: string[]): void => {
		out.push(...lines);
	};

	// --- frontmatter -------------------------------------------------------
	push(
		"---",
		`title: Reliability snapshot — ${options.isoDate}`,
		`date: ${options.isoDate}`,
		"type: findings",
		"domain: Infrastructure",
		"status: active",
		`generated_by: engineering-toolkit`,
		`window_days: ${options.windowDays}`,
		"tags:",
		"  - findings",
		"  - sre",
		"  - reliability",
		"  - slo",
		"  - dora",
		"State: active",
		"---",
		"",
		`# Reliability snapshot — ${options.isoDate}`,
		""
	);

	// --- at a glance -------------------------------------------------------
	const sloCoverage = tierOne.length === 0 ? null : withSlo.filter((n) => n.reliability.tier === 1).length / tierOne.length;
	push(
		"> [!abstract] At a glance",
		`> **${nodes.length} documented ${nodes.length === 1 ? "component" : "components"}, ${tiered.length} with a tier, ${withSlo.length} with an objective.** ` +
			(tierOne.length === 0
				? "Nothing is marked tier 1, so there is no critical set to check a contract against."
				: tierOne.length === 1
					? `The one tier-1 component ${withSlo.some((n) => n.reliability.tier === 1) ? "carries" : "carries no"} SLO.`
					: `${percent(sloCoverage)} of the ${tierOne.length} tier-1 components carry an SLO.`) +
			` ${incidentRows.length} incident${incidentRows.length === 1 ? "" : "s"} recorded, ${stats.open} open.` +
			(inversions.length ? ` **${inversions.length} tier inversion${inversions.length === 1 ? "" : "s"}** — a component resting on something less reliable than itself.` : ""),
		"",
		"> [!danger] What this measures, and what it does not",
		"> **Every number here is a count of notes.** It is a picture of the documentation, not of production. A component with no note does not appear; an incident nobody wrote down did not happen as far as this report is concerned; and *time to restore* here means *time to restore as recorded*, which is a different quantity from the one a monitor would measure.",
		"> ",
		"> Nothing was read from Prometheus, Grafana, AWS or any running system. Compliance against the objectives below is measured by the systems that hold the telemetry — this document records the promise, not its keeping.",
		"",
		"## Contents",
		"",
		"- [[#The reliability contract]]",
		"- [[#Blast radius]]",
		"- [[#Incidents, and the detection split]]",
		"- [[#Delivery — three of the four keys]]",
		"- [[#Documentation findings]]",
		"- [[#Method and caveats]]",
		""
	);

	// --- contract ----------------------------------------------------------
	push("## The reliability contract", "");
	if (nodes.length === 0) {
		push("No infrastructure notes are in scope, so there is no contract to report on.", "");
	} else {
		push(
			tierOne.length === 0
				? "Nothing is marked tier 1. Until something is, the checks below have no critical set to hold to a standard — a tier is what turns an absent SLO from a gap into a defect."
				: `The table is ordered by tier. An error budget is derived from the objective and its window and is never stored, so it cannot disagree with the objective it came from — at 99.9% over 30 days it is ${formatBudget(43.2)}.`,
			"",
			"| Component | Tier | SLO | Error budget | RTO | RPO | Runbook |",
			"|---|---|---|---|---|---|---|"
		);
		for (const node of [...nodes].sort(byTier)) {
			const r = node.reliability;
			const slo = r.slos.length === 0 ? "—" : r.slos.map((s) => escapePipes(s.raw)).join("<br>");
			const budget = r.slos.length === 0 ? "—" : r.slos.map((s) => formatBudget(budgetMinutes(s))).join("<br>");
			push(
				`| [[${node.note.basename}]] | ${r.tier === null ? "—" : `T${r.tier}`} | ${slo} | ${budget} | ${r.rto === null ? "—" : formatMinutes(r.rto)} | ${r.rpo === null ? "—" : r.rpo === 0 ? "0 (synchronous)" : formatMinutes(r.rpo)} | ${r.runbook ? "✅" : "—"} |`
			);
		}
		push(coverageBlock(nodes, tierOne, withSlo, options.restoreTestDays, options.now));
	}

	// --- blast radius ------------------------------------------------------
	push("## Blast radius", "");
	const ranked = nodes
		.map((node) => ({ node, affected: blastRadius(graph, node.note.path) }))
		.filter((entry) => entry.affected.length > 0)
		.sort((a, b) => b.affected.length - a.affected.length);

	if (ranked.length === 0) {
		push("No component is depended on by another, so nothing here has a blast radius. That is either a very small estate or a dependency graph nobody has written down yet.", "");
	} else {
		push(
			"This is the figure a tier is actually about, and it is the one number that cannot be read off any single note — a database looks unimportant on its own page and turns out to sit under six services. Ordered by how much goes away with it.",
			"",
			"| If this is unavailable | Components affected | Of which tier 1 |",
			"|---|---:|---:|"
		);
		for (const entry of ranked.slice(0, 15)) {
			push(`| [[${entry.node.note.basename}]] | ${entry.affected.length} | ${entry.affected.filter((n) => n.reliability.tier === 1).length} |`);
		}
		if (ranked.length > 15) push(`| …and ${ranked.length - 15} more | | |`);
		push("", mermaidGraph(graph), "");
	}

	if (inversions.length) {
		push(
			"> [!warning] Tier inversions",
			"> A component resting on a dependency weaker than itself is a promise that cannot be kept, and **nothing on either note shows it** — each page is internally consistent and the contradiction only exists across the edge.",
			"",
			"| Component | Rests on | |",
			"|---|---|---|"
		);
		for (const entry of inversions) {
			push(`| [[${entry.node.note.basename}]] (T${entry.node.reliability.tier}) | [[${entry.dependency.note.basename}]] (T${entry.dependency.reliability.tier}) | 🔴 |`);
		}
		push("");
	}

	// --- incidents ---------------------------------------------------------
	push("## Incidents, and the detection split", "");
	if (incidentRows.length === 0) {
		push(
			"> [!info] No incidents recorded",
			"> **This is not a reliability result.** No incident notes exist in scope, which means either nothing happened or nothing was written down, and this report cannot tell those apart.",
			""
		);
	} else {
		push(
			"A single duration hides the thing worth knowing: an outage found in two minutes and fixed in ninety is a different problem from one found in ninety and fixed in two, and only the second is a monitoring failure. The two columns below are kept apart for that reason.",
			"",
			"| | Median | Recorded on |",
			"|---|---|---:|",
			`| Time to detect | ${stats.medianDetectMinutes === null ? "—" : formatMinutes(stats.medianDetectMinutes)} | ${incidentRows.filter((r) => r.timeToDetectMinutes !== null).length} of ${incidentRows.length} |`,
			`| Time to restore | ${stats.medianRestoreMinutes === null ? "—" : formatMinutes(stats.medianRestoreMinutes)} | ${incidentRows.filter((r) => r.timeToRestoreMinutes !== null).length} of ${incidentRows.length} |`,
			`| Total, start to resolved | ${stats.medianMinutes === null ? "—" : formatMinutes(stats.medianMinutes)} | ${incidentRows.filter((r) => r.durationMinutes !== null).length} of ${incidentRows.length} |`,
			""
		);

		if (stats.detectionGap === null) {
			push(
				"> [!warning] No incident records how it was found",
				"> The **detection gap** — the share of incidents a person or a customer noticed before monitoring did — cannot be computed. It is the single most useful number an incident record produces, because *the remediation that matters most is usually detection*, and it costs one property: `detected_by: monitor | alert | human | customer`.",
				""
			);
		} else {
			const gap = stats.detectionGap.humanFirst / stats.detectionGap.recorded;
			push(
				`> [!${gap > 0.3 ? "warning" : "tip"}] Detection gap — ${percent(gap)}`,
				`> ${stats.detectionGap.humanFirst} of ${stats.detectionGap.recorded} incidents that record a source were found by a person or a customer before monitoring. ${gap > 0.3 ? "**That is the monitoring backlog, stated as a number.**" : "Most incidents were caught by monitoring first."}`,
				""
			);
		}

		if (stats.missingPostmortem.length || stats.weakActions) {
			push(
				"> [!warning] Postmortem quality",
				`> ${stats.missingPostmortem.length} resolved incident${stats.missingPostmortem.length === 1 ? "" : "s"} lack a postmortem section, and ${stats.weakActions} open follow-up item${stats.weakActions === 1 ? "" : "s"} carry no owner or no date. An action item without both is a diary entry.`,
				""
			);
		}
	}

	// --- DORA --------------------------------------------------------------
	push(
		"## Delivery — three of the four keys",
		"",
		`Computed over the last ${options.windowDays} days from release notes joined to incidents that name a deploy. A release counts as a deployment only when it is marked complete **and** its release time has passed — the release train here is scheduled years ahead, so counting every release note would build a frequency mostly out of releases that have not happened.`,
		"",
		"| Metric | Value | | Basis |",
		"|---|---|---|---|"
	);
	for (const metric of doraReport.metrics) {
		push(`| ${metric.label} | ${metric.value ?? "no data"} | ${verdict(metric.band)} | ${escapePipes(metric.basis)} |`);
	}
	push(
		"",
		"> [!info] Bands are conventions, not measurements",
		"> The elite/high/medium/low thresholds come from the *State of DevOps* bands recorded in [[Engineering Metrics — Glossary and Targets]], **which have been revised between editions**. They are the shape of a scale. And these are diagnostic metrics rather than targets: made a target, deployment frequency is gamed by splitting commits and change failure rate by redefining failure.",
		"",
		"> [!danger] No data is not a zero",
		"> A metric above reading *no data* means nothing was recorded, **not that the value is zero**. An unwired record must never read as elite performance — a change failure rate of 0% and a change failure rate nobody computed look identical on a dashboard and are opposite findings.",
		""
	);

	// --- findings ----------------------------------------------------------
	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	push(
		"## Documentation findings",
		"",
		issues.length === 0
			? "The linter reports nothing against the records in scope."
			: `${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"} across the records in scope. An error means the vault contradicts itself; a warning means one note is wrong.`,
		""
	);
	const byRule = new Map<string, number>();
	for (const issue of issues) byRule.set(issue.rule, (byRule.get(issue.rule) ?? 0) + 1);
	if (byRule.size) {
		push("| Check | Findings | |", "|---|---:|---|");
		const worst = Math.max(...byRule.values());
		for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
			push(`| ${rule} | ${count} | \`${bar(count / worst, 10)}\` |`);
		}
		push("");
	}

	// --- method ------------------------------------------------------------
	push(
		"## Method and caveats",
		"",
		`- Generated by the Engineering Toolkit plugin over **${options.scope}**, from ${index.notes.size.toLocaleString()} indexed notes. Nothing outside that scope was read.`,
		"- **Error budgets are derived** from each objective and its window at render time. None is stored, so none can disagree with the objective it came from.",
		"- **Medians, not means.** One nine-hour incident should not move the headline for twenty twenty-minute ones.",
		"- **A missing value is rendered as a dash and counted nowhere.** No figure here is an average taken over records that did not carry the field.",
		"- Lead time for changes is refused rather than estimated. See its row above.",
		`- ${adrIndex(index).length} architecture decision record${adrIndex(index).length === 1 ? "" : "s"} and ${releaseRows.length} release note${releaseRows.length === 1 ? "" : "s"} were in scope while this ran.`,
		"",
		"## Related",
		"",
		"- [[Reliability Engineering]] — the vocabulary and the burn-rate model this report is shaped by",
		"- [[Engineering Metrics — Glossary and Targets]] — where the DORA bands come from, and their caveat",
		"- [[Backups and Recovery Objectives]] — RTO and RPO, and why an untested restore is not a backup",
		""
	);

	return out.join(NL);
}

function byTier(a: InfraNode, b: InfraNode): number {
	return (a.reliability.tier ?? 9) - (b.reliability.tier ?? 9) || a.name.localeCompare(b.name);
}

function coverageBlock(nodes: InfraNode[], tierOne: InfraNode[], withSlo: InfraNode[], restoreTestDays: number, now: number): string {
	const rows: Array<[string, number, number, string]> = [
		["Has a tier", nodes.filter((n) => n.reliability.tier !== null).length, nodes.length, "Without one, nothing else here can be graded."],
		["Tier 1 with an SLO", withSlo.filter((n) => n.reliability.tier === 1).length, tierOne.length, "An error budget is what turns reliability into arithmetic."],
		["Has a runbook", nodes.filter((n) => n.reliability.runbook).length, nodes.length, "What somebody woken at 3am opens first."],
		["Has an escalation path", nodes.filter((n) => n.reliability.escalation).length, nodes.length, "Who is woken."],
		["RTO stated", nodes.filter((n) => n.reliability.rto !== null).length, nodes.length, "Sets the restore mechanism, and its cost."],
		[
			"Restore tested recently",
			nodes.filter((n) => freshRestore(n.reliability.lastRestoreTest, now, restoreTestDays)).length,
			nodes.filter((n) => n.reliability.rto !== null).length,
			`A backup that has never been restored is not a backup. Counted over components that state an RTO, within ${restoreTestDays} days.`,
		],
	];

	const lines = ["", "| Coverage | | | Why it is on this list |", "|---|---|---:|---|"];
	for (const [label, have, total, why] of rows) {
		const ratio = total === 0 ? null : have / total;
		lines.push(`| ${label} | \`${bar(ratio ?? 0, 12)}\` | ${total === 0 ? "—" : `${have}/${total}`} | ${why} |`);
	}
	lines.push("");
	return lines.join(NL);
}

function freshRestore(date: string | null, now: number, withinDays: number): boolean {
	if (!date) return false;
	const at = Date.parse(date);
	return Number.isFinite(at) && now - at <= withinDays * 86400000;
}

/** A dependency diagram, styled with stroke colours only so it reads in light and dark themes. */
function mermaidGraph(graph: InfraGraph): string {
	const nodes = [...graph.nodes.values()];
	if (nodes.length === 0) return "";
	const id = new Map<string, string>();
	nodes.forEach((node, i) => id.set(node.note.path, `N${i}`));

	const lines = ["```mermaid", "flowchart LR"];
	for (const node of nodes) {
		lines.push(`    ${id.get(node.note.path)}["${node.name}${node.reliability.tier ? ` · T${node.reliability.tier}` : ""}"]`);
	}
	for (const node of nodes) {
		for (const path of node.dependencies) {
			const target = id.get(path);
			if (target) lines.push(`    ${id.get(node.note.path)} --> ${target}`);
		}
	}
	for (const node of nodes) {
		if (node.reliability.tier === 1) lines.push(`    style ${id.get(node.note.path)} stroke:#ef4444,stroke-width:2px`);
		else if (node.reliability.tier === 2) lines.push(`    style ${id.get(node.note.path)} stroke:#f59e0b,stroke-width:2px`);
	}
	lines.push("```");
	return lines.join(NL);
}

/** Block characters in backticks. Obsidian tables are not monospaced, so an
 * unbackticked bar is a row of glyphs at inconsistent widths. */
export function bar(ratio: number, width: number): string {
	if (!Number.isFinite(ratio)) return "─".repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function percent(ratio: number | null): string {
	return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

/** A pipe inside a table cell splits the table, backticks or no backticks. */
function escapePipes(text: string): string {
	return text.replace(/\|/g, "\\|");
}

export type { SloTarget };

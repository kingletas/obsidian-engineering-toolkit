// The shared dashboard (§13), pure so every figure is reproducible in a test. A
// module that is off contributes no section rather than a section of zeroes.

import type { Issue, Severity, ToolkitIndex } from "../core/types";
import { adrCounts, adrIndex } from "../adr/adr-engine";
import { incidents, incidentStats } from "../incidents/incident-engine";
import { decisionCounts, decisions } from "../decisions/decision-engine";
import { infraGraph, infraStats } from "../infra/infra-engine";

export interface ModuleFlags {
	adr: boolean;
	infrastructure: boolean;
	incidents: boolean;
	decisions: boolean;
	linter: boolean;
	automation: boolean;
	reliability: boolean;
}

export interface DashboardData {
	scannedNotes: number;
	adr: ReturnType<typeof adrCounts> | null;
	adrTotal: number;
	infrastructure: ReturnType<typeof infraStats> | null;
	incidents: ReturnType<typeof incidentStats> | null;
	incidentTotal: number;
	decisions: ReturnType<typeof decisionCounts> | null;
	decisionTotal: number;
	findings: Record<Severity, number> | null;
}

export function dashboard(index: ToolkitIndex, issues: Issue[], flags: ModuleFlags): DashboardData {
	const adrRows = flags.adr ? adrIndex(index) : null;
	const incidentRows = flags.incidents ? incidents(index) : null;
	const decisionRows = flags.decisions ? decisions(index) : null;

	const findings = flags.linter ? { error: 0, warning: 0, info: 0 } : null;
	if (findings) for (const issue of issues) findings[issue.severity] += 1;

	return {
		scannedNotes: index.notes.size,
		adr: adrRows ? adrCounts(adrRows) : null,
		adrTotal: adrRows?.length ?? 0,
		infrastructure: flags.infrastructure ? infraStats(infraGraph(index)) : null,
		incidents: incidentRows ? incidentStats(incidentRows) : null,
		incidentTotal: incidentRows?.length ?? 0,
		decisions: decisionRows ? decisionCounts(decisionRows) : null,
		decisionTotal: decisionRows?.length ?? 0,
		findings,
	};
}

/** A block-character bar, for a proportion in the range 0..1. Monospaced glyphs
 * so a column of them lines up in a proportional-font pane. */
export function bar(value: number, width = 12): string {
	if (!Number.isFinite(value)) return "─".repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round(value * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Minutes as `2h 14m`. Returns a dash for null rather than `0m`: an unknown
 * duration and a zero-minute one are different facts. */
export function duration(minutes: number | null): string {
	if (minutes === null) return "—";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

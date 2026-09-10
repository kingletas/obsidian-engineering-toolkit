// The four DORA keys, computed purely from the vault's records. Lead time is
// reported as not derivable because the vault has no commit timestamps, and an
// empty journal reports no data rather than zeroes.

import { ofKind, type NoteRecord, type ToolkitIndex } from "../core/types";
import { median } from "../incidents/incident-engine";
import type { IncidentRow } from "../incidents/incident-engine";

export type Band = "elite" | "high" | "medium" | "low" | "no-data";

export interface ReleaseRow {
	note: NoteRecord;
	version: string | null;
	branch: string | null;
	status: string | null;
	/** Epoch milliseconds, or null when `Release Time` is missing or unreadable. */
	at: number | null;
	/** True only for a release that is marked complete AND whose time has
	 * passed. The release train here is scheduled years ahead -- there are notes
	 * dated 2029 in the tree -- so counting every release note as a deployment
	 * would report a deployment frequency built mostly from releases that have
	 * not happened. */
	shipped: boolean;
}

export function releases(index: ToolkitIndex, now: number): ReleaseRow[] {
	return ofKind(index, "release").map((note) => {
		const raw = note.props["Release Time"] ?? note.props.release_time ?? note.props.date;
		const parsed = raw === undefined || raw === null ? NaN : Date.parse(String(raw));
		const at = Number.isFinite(parsed) ? parsed : null;
		const status = (note.props.Status ?? note.props.status) === undefined ? null : String(note.props.Status ?? note.props.status).trim().toLowerCase();
		return {
			note,
			version: note.props.Version === undefined ? null : String(note.props.Version).trim() || null,
			branch: note.props.Branch === undefined ? null : String(note.props.Branch).trim() || null,
			status,
			at,
			shipped: status === "complete" && at !== null && at <= now,
		};
	});
}

export interface DoraMetric {
	label: string;
	/** Rendered value, or null when there is no data. */
	value: string | null;
	band: Band;
	/** What the number was computed from, so a reader can check it. */
	basis: string;
}

export interface DoraReport {
	windowDays: number;
	deployments: number;
	metrics: DoraMetric[];
}

/** Bands after the State of DevOps report, which revises them between editions,
 * so they show the shape of the scale rather than a standard. */
function frequencyBand(perWeek: number): Band {
	if (perWeek >= 7) return "elite";
	if (perWeek >= 1) return "high";
	if (perWeek >= 0.23) return "medium"; // roughly weekly to monthly
	return "low";
}

function failureBand(rate: number): Band {
	if (rate <= 0.05) return "elite";
	if (rate <= 0.1) return "high";
	if (rate <= 0.15) return "medium";
	return "low";
}

function recoveryBand(minutes: number): Band {
	if (minutes < 60) return "elite";
	if (minutes < 1440) return "high";
	if (minutes < 10080) return "medium";
	return "low";
}

/** Below this many observations a rate is shown with its sample size but not graded. */
const MIN_SAMPLE = 5;

export function dora(rows: ReleaseRow[], incidents: IncidentRow[], now: number, windowDays: number): DoraReport {
	const since = now - windowDays * 86400000;
	const shipped = rows.filter((row) => row.shipped && row.at !== null && row.at >= since);
	const inWindow = incidents.filter((row) => {
		const at = row.started ? Date.parse(row.started) : NaN;
		return Number.isFinite(at) && at >= since && at <= now;
	});
	const fromDeploy = inWindow.filter((row) => row.causedByDeploy);
	const recovery = median(fromDeploy.map((row) => row.timeToRestoreMinutes ?? row.durationMinutes).filter((n): n is number => n !== null));

	const perWeek = shipped.length / (windowDays / 7);

	const metrics: DoraMetric[] = [
		shipped.length === 0
			? { label: "Deployment frequency", value: null, band: "no-data", basis: `no release note in the last ${windowDays} days is marked complete with a past release time` }
			: {
					label: "Deployment frequency",
					value: perWeek >= 1 ? `${round(perWeek)}/week` : `one every ${Math.round(windowDays / shipped.length)} days`,
					band: frequencyBand(perWeek),
					basis: `${shipped.length} shipped release${shipped.length === 1 ? "" : "s"} in ${windowDays} days`,
				},
		{
			label: "Lead time for changes",
			value: null,
			band: "no-data",
			// Stated as a limitation rather than left blank. A blank row reads as
			// an oversight; this one is a decision.
			basis: "not derivable from the vault — needs commit timestamps, and a release note's own date measures the release train rather than the change",
		},
		shipped.length === 0
			? { label: "Change failure rate", value: null, band: "no-data", basis: "no deployments in the window, so the denominator is zero" }
			: {
					label: "Change failure rate",
					value: `${round((fromDeploy.length / shipped.length) * 100)}%`,
					band: shipped.length < MIN_SAMPLE ? "no-data" : failureBand(fromDeploy.length / shipped.length),
					basis:
						`${fromDeploy.length} incident${fromDeploy.length === 1 ? "" : "s"} attributed to a deploy over ${shipped.length} deployment${shipped.length === 1 ? "" : "s"}` +
						(shipped.length < MIN_SAMPLE ? ` — too few to grade, so the rate is shown and left unbanded` : ""),
				},
		recovery === null
			? { label: "Failed deployment recovery", value: null, band: "no-data", basis: "no deploy-caused incident in the window records both a detection and a resolution time" }
			: {
					label: "Failed deployment recovery",
					value: formatMinutes(recovery),
					band: fromDeploy.length < 3 ? "no-data" : recoveryBand(recovery),
					basis:
						`median over ${fromDeploy.length} deploy-caused incident${fromDeploy.length === 1 ? "" : "s"}` +
						(fromDeploy.length < 3 ? " — too few to grade" : ""),
				},
	];

	return { windowDays, deployments: shipped.length, metrics };
}

export function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${Math.round(minutes)}m`;
	const hours = Math.floor(minutes / 60);
	const rest = Math.round(minutes % 60);
	if (minutes < 1440) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
	const days = Math.floor(minutes / 1440);
	const restHours = Math.round((minutes % 1440) / 60);
	return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/** 🟢 🟡 🔴 ⚪, matching the verdict convention the vault's reports already use.
 * No-data is grey rather than red: a number nobody recorded is not a bad number. */
export function verdict(band: Band): string {
	switch (band) {
		case "elite":
		case "high":
			return "🟢";
		case "medium":
			return "🟡";
		case "low":
			return "🔴";
		default:
			return "⚪";
	}
}

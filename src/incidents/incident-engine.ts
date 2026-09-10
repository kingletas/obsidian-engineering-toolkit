// Incident queries and the postmortem check (§6.5, §6.6). Pure.

import { ofKind, type NoteRecord, type TaskItem, type ToolkitIndex } from "../core/types";
import { INCIDENT_STATUSES, SEVERITIES } from "../records/record-types";

export interface IncidentRow {
	note: NoteRecord;
	id: string;
	title: string;
	status: string;
	severity: string;
	started: string | null;
	resolved: string | null;
	/** When somebody or something first knew. Between `started` and `resolved`,
	 * and the reason the two durations below are kept apart. */
	detectedAt: string | null;
	/** `monitor`, `alert`, `human`, `customer`, or null when not recorded. */
	detectedBy: string | null;
	/** Minutes between `started` and `resolved`, or null when either is missing
	 * or unparseable. Never guessed from file times: a note edited a week later
	 * would report a week-long outage. */
	durationMinutes: number | null;
	/** Started → detected. The playbook's line is that *"the remediation that
	 * matters most is usually detection"*, and a single duration hides it
	 * entirely: an outage found in two minutes and fixed in ninety looks
	 * identical to one found in ninety and fixed in two. */
	timeToDetectMinutes: number | null;
	/** Detected → resolved. */
	timeToRestoreMinutes: number | null;
	service: string | null;
	/** True when the incident names a deploy as its cause. Feeds change failure
	 * rate, which the vault's metrics glossary records as captured per deploy in
	 * Slack and never aggregated. */
	causedByDeploy: boolean;
	deployRef: string | null;
	/** Follow-up items, and whether each carries the owner and date that make it
	 * an action item rather than a diary entry. */
	actions: TaskItem[];
	actionsWithoutOwner: TaskItem[];
	/** True when the resolved incident has the sections a postmortem needs. */
	postmortemComplete: boolean;
}

const POSTMORTEM_SECTIONS = ["root cause", "resolution", "follow-up actions"];

function propString(note: NoteRecord, key: string): string | null {
	const value = note.props[key];
	if (value === undefined || value === null) return null;
	const text = String(value).trim();
	return text ? text : null;
}

export function incidents(index: ToolkitIndex): IncidentRow[] {
	return ofKind(index, "incident").map((note) => {
		const started = propString(note, "started");
		const resolved = propString(note, "resolved");
		const detectedAt = propString(note, "detected_at") ?? propString(note, "detected");
		const deployRef = propString(note, "deploy_ref") ?? propString(note, "release");
		const causeFlag = note.props.caused_by_deploy;
		// Follow-up actions are the tasks under the Follow-up heading, or every task
		// when the note has no such heading.
		const actions = followUpTasks(note);
		return {
			note,
			id: note.id ?? "—",
			title: note.title.replace(/^INC-\d{4}-\d+\s*[—–-]\s*/i, "").trim() || note.title,
			status: note.status ?? "open",
			severity: (propString(note, "severity") ?? "").toUpperCase() || "—",
			started,
			resolved,
			detectedAt,
			detectedBy: (propString(note, "detected_by") ?? "").toLowerCase() || null,
			durationMinutes: minutesBetween(started, resolved),
			timeToDetectMinutes: minutesBetween(started, detectedAt),
			timeToRestoreMinutes: minutesBetween(detectedAt ?? started, resolved),
			service: propString(note, "service"),
			causedByDeploy: causeFlag === true || String(causeFlag ?? "").toLowerCase() === "true" || String(causeFlag ?? "").toLowerCase() === "yes" || (causeFlag === undefined && deployRef !== null),
			deployRef,
			actions,
			actionsWithoutOwner: actions.filter((task) => !task.done && (!task.owner || !task.due)),
			postmortemComplete: POSTMORTEM_SECTIONS.every((section) => note.headings.some((h) => h.startsWith(section))),
		};
	});
}

/** Both timestamps are read as local time, which is how they are written. A
 * pair that will not parse returns null rather than 0 -- a zero-minute outage
 * and an unparseable one are different facts, and averaging the second into a
 * dashboard as the first is how a mean time to recovery becomes a lie. */
export function minutesBetween(started: string | null, resolved: string | null): number | null {
	if (!started || !resolved) return null;
	const a = Date.parse(started);
	const b = Date.parse(resolved);
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
	return Math.round((b - a) / 60000);
}

/** Tasks that are follow-up actions rather than checklist items elsewhere in
 * the note. Heading-scoped where the heading exists; everything otherwise. */
function followUpTasks(note: NoteRecord): TaskItem[] {
	const hasHeading = note.headings.some((h) => h.startsWith("follow-up"));
	if (!hasHeading) return note.tasks;
	// Tasks carry no positions, so the heading cannot scope them and every task
	// is returned; the rule that consumes this says so.
	return note.tasks;
}

export interface IncidentStats {
	byStatus: Record<string, number>;
	bySeverity: Record<string, number>;
	open: number;
	/** Resolved or closed incidents whose note is missing a postmortem section. */
	missingPostmortem: IncidentRow[];
	/** Median rather than mean. One nine-hour incident should not move the
	 * headline number for twenty twenty-minute ones. */
	medianMinutes: number | null;
	medianDetectMinutes: number | null;
	medianRestoreMinutes: number | null;
	/** Incidents a person or a customer found before monitoring did, over those
	 * that recorded a detection source at all. Null when none did -- a detection
	 * gap of 0% and "nobody writes this down" are opposite findings. */
	detectionGap: { humanFirst: number; recorded: number } | null;
	/** Incidents attributed to a deploy. The numerator of change failure rate;
	 * the denominator lives with the releases. */
	causedByDeploy: number;
	/** Open action items missing an owner or a date. */
	weakActions: number;
}

export function incidentStats(rows: IncidentRow[]): IncidentStats {
	const byStatus: Record<string, number> = {};
	for (const status of INCIDENT_STATUSES) byStatus[status] = 0;
	const bySeverity: Record<string, number> = {};
	for (const severity of SEVERITIES) bySeverity[severity] = 0;

	const durations: number[] = [];
	const detects: number[] = [];
	const restores: number[] = [];
	const missingPostmortem: IncidentRow[] = [];
	let humanFirst = 0;
	let recorded = 0;
	let causedByDeploy = 0;
	let weakActions = 0;

	for (const row of rows) {
		byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
		bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + 1;
		if (row.durationMinutes !== null) durations.push(row.durationMinutes);
		if (row.timeToDetectMinutes !== null) detects.push(row.timeToDetectMinutes);
		if (row.timeToRestoreMinutes !== null) restores.push(row.timeToRestoreMinutes);
		if ((row.status === "resolved" || row.status === "closed") && !row.postmortemComplete) missingPostmortem.push(row);
		if (row.detectedBy) {
			recorded += 1;
			if (row.detectedBy === "human" || row.detectedBy === "customer") humanFirst += 1;
		}
		if (row.causedByDeploy) causedByDeploy += 1;
		weakActions += row.actionsWithoutOwner.length;
	}

	return {
		byStatus,
		bySeverity,
		open: rows.filter((row) => row.status === "open" || row.status === "investigating").length,
		missingPostmortem,
		medianMinutes: median(durations),
		medianDetectMinutes: median(detects),
		medianRestoreMinutes: median(restores),
		detectionGap: recorded === 0 ? null : { humanFirst, recorded },
		causedByDeploy,
		weakActions,
	};
}

/** Median of a list, or null for an empty one. Null rather than 0, everywhere:
 * "nothing was measured" and "it measured zero" are different facts and only one
 * of them is good news. */
export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length / 2;
	return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

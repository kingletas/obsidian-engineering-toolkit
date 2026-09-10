// The decision log (§7), pure. Promotion to an ADR copies rather than moves, so
// the decision stays in the log marked `superseded` and its links keep working.

import { ofKind, type NoteRecord, type ToolkitIndex } from "../core/types";

export interface DecisionRow {
	note: NoteRecord;
	title: string;
	status: string;
	date: string | null;
	/** Path of the ADR this decision was promoted into, when there is one. */
	promotedTo: string | null;
}

export function decisions(index: ToolkitIndex): DecisionRow[] {
	return ofKind(index, "decision").map((note) => ({
		note,
		title: note.title.replace(/^Decision\s*[—–-]\s*/i, "").trim() || note.title,
		status: note.status ?? "active",
		date: note.props.date === undefined || note.props.date === null ? null : String(note.props.date).trim() || null,
		promotedTo: promotedTarget(note, index),
	}));
}

function promotedTarget(note: NoteRecord, index: ToolkitIndex): string | null {
	const raw = note.props.promoted_to ?? note.props.adr;
	if (raw === undefined || raw === null || raw === "") return null;
	const ref = String(raw).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
	for (const candidate of index.notes.values()) {
		if (candidate.kind !== "adr") continue;
		if (candidate.id?.toUpperCase() === ref.toUpperCase() || candidate.basename === ref) return candidate.path;
	}
	return null;
}

export function decisionCounts(rows: DecisionRow[]): Record<string, number> {
	const counts: Record<string, number> = { active: 0, superseded: 0, reversed: 0 };
	for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
	return counts;
}

/** Text for the two properties that record a promotion, so the caller writes
 * the same pair every time. Deliberately not a function that performs the
 * promotion: writing to notes lives in `main.ts`, and keeping it there is what
 * makes every engine in this folder testable without an app. */
export function promotionProps(adrId: string): Record<string, unknown> {
	return { status: "superseded", promoted_to: adrId };
}

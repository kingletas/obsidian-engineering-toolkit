// The ADR index (§4.4) and the supersession chain (§4.5). Pure.

import { ofKind, type NoteRecord, type ToolkitIndex } from "../core/types";
import { ADR_STATUSES } from "../records/record-types";

export interface AdrRow {
	note: NoteRecord;
	id: string;
	title: string;
	status: string;
	/** Path of the ADR that supersedes this one, when one declares it. */
	supersededBy: string | null;
	/** Paths of ADRs this one supersedes. */
	supersedes: string[];
}

/** Read the supersession link off a note. Two spellings are accepted because
 * both are in use in the wild and neither is wrong: a `superseded_by` property,
 * and a `supersedes` property on the *other* note. The second is the one that
 * actually gets written, because you know what you are replacing at the moment
 * you replace it and not before. */
function linkedIds(note: NoteRecord, key: string): string[] {
	const raw = note.props[key] ?? note.props[key.replace(/_/g, "-")];
	const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];
	return list
		.map((entry) => String(entry).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim())
		.filter(Boolean);
}

export function adrIndex(index: ToolkitIndex): AdrRow[] {
	const notes = ofKind(index, "adr");
	const byId = new Map<string, NoteRecord>();
	for (const note of notes) if (note.id) byId.set(note.id.toUpperCase(), note);

	const supersedes = new Map<string, string[]>();
	const supersededBy = new Map<string, string>();
	for (const note of notes) {
		for (const ref of linkedIds(note, "supersedes")) {
			const target = resolveRef(ref, byId, index);
			if (!target) continue;
			supersedes.set(note.path, [...(supersedes.get(note.path) ?? []), target.path]);
			supersededBy.set(target.path, note.path);
		}
		for (const ref of linkedIds(note, "superseded_by")) {
			const target = resolveRef(ref, byId, index);
			if (!target) continue;
			supersededBy.set(note.path, target.path);
			supersedes.set(target.path, [...(supersedes.get(target.path) ?? []), note.path]);
		}
	}

	return notes.map((note) => ({
		note,
		id: note.id ?? "—",
		title: displayTitle(note),
		status: note.status ?? "unknown",
		supersededBy: supersededBy.get(note.path) ?? null,
		supersedes: supersedes.get(note.path) ?? [],
	}));
}

/** A reference may be an id (`ADR-0002`) or a note name. Ids are tried first:
 * a filename is `ADR-0002 — Title`, so matching on name alone would depend on
 * the title being typed identically, which is exactly the sort of thing that
 * works until someone fixes a typo. */
function resolveRef(ref: string, byId: Map<string, NoteRecord>, index: ToolkitIndex): NoteRecord | null {
	const direct = byId.get(ref.toUpperCase());
	if (direct) return direct;
	for (const note of index.notes.values()) {
		if (note.basename === ref || note.title === ref) return note;
	}
	return null;
}

/** The title without the id prefix the filename carries. `ADR-0002 — Patch
 * Third-Party Core` reads as `Patch Third-Party Core` in a table that already
 * has an id column. */
export function displayTitle(note: NoteRecord): string {
	const stripped = note.title.replace(/^(ADR-\d+|INC-\d{4}-\d+)\s*[—–-]\s*/i, "").trim();
	return stripped || note.title;
}

export function adrCounts(rows: AdrRow[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const status of ADR_STATUSES) counts[status] = 0;
	for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
	return counts;
}

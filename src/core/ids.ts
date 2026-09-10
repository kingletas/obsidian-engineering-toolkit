// Record numbering (§4.5, §6.2), derived from the ids already in the vault
// rather than a stored counter. `nextNumber` takes the highest id seen, so a
// deleted record leaves a gap instead of having its number reused.

import { ofKind, type ToolkitIndex } from "./types";

/** ADR ids are zero-padded to four digits. Not a preference -- the vault's four
 * existing ADRs are `ADR-0001`…`ADR-0004`, and a plugin that started issuing
 * `ADR-5` would sort its own records before every one that came before. */
export const ADR_PAD = 4;

export function formatAdrId(n: number): string {
	return `ADR-${String(n).padStart(ADR_PAD, "0")}`;
}

/** Incidents are numbered per year (§6.2), padded to three. The year is part of
 * the id rather than derived from `started`, so an incident opened at 23:58 on
 * new year's eve keeps the id it was given. */
export function formatIncidentId(year: number, n: number): string {
	return `INC-${year}-${String(n).padStart(3, "0")}`;
}

/** Highest number matching `pattern` across the given ids, or 0. */
export function highest(ids: Array<string | null>, pattern: RegExp): number {
	let top = 0;
	for (const id of ids) {
		if (!id) continue;
		const match = pattern.exec(id.trim());
		if (!match) continue;
		const n = Number.parseInt(match[1], 10);
		if (Number.isFinite(n) && n > top) top = n;
	}
	return top;
}

export function nextAdrId(index: ToolkitIndex): string {
	const ids = ofKind(index, "adr").map((note) => note.id);
	return formatAdrId(highest(ids, /^ADR-(\d+)$/i) + 1);
}

export function nextIncidentId(index: ToolkitIndex, year: number): string {
	const ids = ofKind(index, "incident")
		.map((note) => note.id)
		.filter((id): id is string => !!id && id.toUpperCase().startsWith(`INC-${year}-`));
	return formatIncidentId(year, highest(ids, /^INC-\d{4}-(\d+)$/i) + 1);
}

/** Filenames are `<id> — <title>`, with an em dash and spaces either side --
 * the separator the four existing ADR filenames already use. Characters
 * Obsidian refuses in a filename are replaced rather than stripped, so a title
 * ending in `?` does not silently become a different title. */
export function recordFilename(id: string, title: string): string {
	return `${id} — ${sanitiseTitle(title)}`;
}

export function sanitiseTitle(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[-\s]+$/, "");
}

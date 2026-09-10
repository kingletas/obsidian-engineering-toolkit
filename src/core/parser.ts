// Turns one file's already-parsed metadata into a NoteRecord. Pure: it takes a
// plain input object and a link resolver, so the tests drive it directly and
// nothing about Obsidian's cache shape leaks past this file.

import type { LinkRef, NoteRecord, TaskItem } from "./types";
import { kindOf, normaliseType } from "../records/record-types";

/** What the indexer hands over: what Obsidian's metadata cache provides, plus
 * the file stat, and nothing else. */
export interface ParseInput {
	path: string;
	basename: string;
	frontmatter: Record<string, unknown> | null;
	links: Array<{ link: string; displayText?: string }>;
	embeds: Array<{ link: string; displayText?: string }>;
	tags: string[];
	headings: string[];
	/** Body only -- frontmatter already removed. */
	body: string;
	mtime: number;
	size: number;
}

export type LinkResolver = (raw: string, fromPath: string) => string | null;

export interface ParseOptions {
	/** Read in order; the first one present wins. `Type` is listed because YAML
	 * keys are case-sensitive and existing notes often use the capitalised key. */
	typeProperties: string[];
	idProperties: string[];
	titleProperties: string[];
	statusProperties: string[];
	/** Release notes are identified by this folder rather than by a `type`
	 * property, since they carry `Version` and `Release Time` but no type. */
	releaseFolder: string;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
	typeProperties: ["type", "Type", "note_type"],
	idProperties: ["id", "adr", "incident_id"],
	titleProperties: ["title"],
	statusProperties: ["status", "Status"],
	releaseFolder: "Engineering/Releases",
};

function firstString(fm: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = fm[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number") return String(value);
	}
	return null;
}

/** Strip the alias and any heading or block anchor off a wikilink so it can be
 * resolved. The escaped pipe matters: a wikilink inside a Markdown table has to
 * be written `[[Note\|alias]]` or the table splits at the pipe, and leaving the
 * backslash on the path makes every linked table row read as a broken link. */
export function linkText(raw: string): string {
	return raw.split("|")[0].replace(/\\$/, "").split("#")[0].split("^")[0].trim();
}

/** Derive an id from a strict prefix of the name, like `ADR-0002 — …`, when
 * frontmatter carries none, so a note merely mentioning an id never acquires it. */
export function idFromName(basename: string): string | null {
	const adr = basename.match(/^(ADR-\d{1,6})\b/i);
	if (adr) return adr[1].toUpperCase();
	const inc = basename.match(/^(INC-\d{4}-\d{1,6})\b/i);
	if (inc) return inc[1].toUpperCase();
	return null;
}

export function parseNote(input: ParseInput, resolve: LinkResolver, options: ParseOptions): NoteRecord {
	const fm = input.frontmatter ?? {};

	const rawType = firstString(fm, options.typeProperties);
	const type = rawType ? normaliseType(rawType) : null;
	const rawStatus = firstString(fm, options.statusProperties);
	const titleValue = firstString(fm, options.titleProperties);
	const declaredId = firstString(fm, options.idProperties);

	const links: LinkRef[] = [
		...input.links.map((l) => ({ raw: l.link, display: l.displayText ?? null, target: resolve(linkText(l.link), input.path), embed: false })),
		...input.embeds.map((l) => ({ raw: l.link, display: l.displayText ?? null, target: resolve(linkText(l.link), input.path), embed: true })),
	];

	const slash = input.path.lastIndexOf("/");
	const folder = options.releaseFolder.replace(/\/+$/, "");
	// `Release Time` is required as well as the folder: the Release Dashboard
	// and the per-cycle index notes live in the same tree and are not releases.
	const isRelease = folder !== "" && (input.path === folder || input.path.startsWith(folder + "/")) && firstString(fm, ["Release Time", "Version"]) !== null;
	const kind = isRelease ? ("release" as const) : kindOf(type);
	const body = input.body ?? "";
	const tasks = parseTasks(body);

	return {
		path: input.path,
		basename: input.basename,
		folder: slash < 0 ? "" : input.path.slice(0, slash),
		type,
		rawType,
		kind,
		// The alias list is read for an id as well, because the vault's ADRs
		// carry `aliases: [ADR-0002]` and nothing else that looks like an id.
		id: declaredId ?? aliasId(fm) ?? (kind ? idFromName(input.basename) : null),
		title: titleValue ?? input.basename,
		status: rawStatus ? rawStatus.trim().toLowerCase() : null,
		rawStatus,
		props: fm,
		hasFrontmatter: input.frontmatter !== null,
		links,
		tags: input.tags.map((t) => t.replace(/^#/, "")),
		mtime: input.mtime,
		size: input.size,
		headings: input.headings.map((h) => h.trim().toLowerCase()),
		bodyChars: body.trim().length,
		tasksDone: tasks.filter((task) => task.done).length,
		tasks,
	};
}

function aliasId(fm: Record<string, unknown>): string | null {
	const raw = fm.aliases ?? fm.alias;
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	for (const entry of list) {
		if (typeof entry !== "string") continue;
		const found = idFromName(entry.trim());
		if (found) return found;
	}
	return null;
}

/** Checkbox lines with an owner (`[[Person]]` or `@name`) and a due date (bare ISO
 * or after 📅); an item with no owner gets null, never the note's `Owner`. */
export function parseTasks(body: string): TaskItem[] {
	const out: TaskItem[] = [];
	for (const match of body.matchAll(/^[ \t]*[-*+]\s+\[([ xX])\]\s?(.*)$/gm)) {
		const text = match[2].trim();
		const link = /\[\[([^\]|#]+)/.exec(text);
		const at = /(?:^|\s)@([\w.-]+)/.exec(text);
		// The date is taken from a 📅 marker first. A bare date in the text of an
		// action item is as often the date of the thing being described as it is
		// a due date, so the explicit marker wins where both appear.
		const due = /📅\s*(\d{4}-\d{2}-\d{2})/.exec(text) ?? /(?:^|\s)(\d{4}-\d{2}-\d{2})\b/.exec(text);
		out.push({
			raw: match[0].trim(),
			text,
			done: match[1].toLowerCase() === "x",
			owner: link ? link[1].trim() : at ? `@${at[1]}` : null,
			due: due ? due[1] : null,
		});
	}
	return out;
}

/** Completed checkboxes. Kept as its own export because the automation event is
 * "one more thing got done", and a total that moved when a task was *added*
 * would fire it on the wrong edit. */
export function countDoneTasks(body: string): number {
	return parseTasks(body).filter((task) => task.done).length;
}

/** Strip a leading YAML frontmatter block. Used only for the character count --
 * the properties themselves always come from Obsidian's parse, never from this.
 * Two YAML readers that can disagree is a bug generator. */
export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return text;
	const after = text.indexOf("\n", end + 1);
	return after < 0 ? "" : text.slice(after + 1);
}

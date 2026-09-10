// The shapes everything downstream reads, all derived from Markdown and safe to
// throw away; nothing here is a source of truth.

export type Severity = "error" | "warning" | "info";

/** One linter finding. Every rule emits this shape, so the findings pane has
 * exactly one renderer to maintain. */
export interface Issue {
	/** Vault-relative path of the note the finding is about. */
	path: string;
	/** Stable code, `ET###`. What a user mutes, and what the tests assert on. */
	code: string;
	/** Rule id, kebab-case. Matches the key in the settings' rule map. */
	rule: string;
	severity: Severity;
	message: string;
	/** Frontmatter property the finding is about, when there is one. */
	property?: string;
	/** What to do about it. Kept out of `message` so a long list stays scannable. */
	hint?: string;
	/** Set by rules whose fix is mechanical and reversible. `null` means the
	 * finding has no autofix -- which is most of them, deliberately (§8.5). */
	fix?: AutoFix | null;
}

/** A proposed frontmatter edit. Property-level rather than text-level on
 * purpose: the fix is applied through Obsidian's own frontmatter API, so the
 * body of the note, its formatting and its comments are untouched. A textual
 * patch would be able to corrupt a file; this cannot. */
export interface AutoFix {
	/** One line, imperative, shown in the confirmation dialog verbatim. */
	label: string;
	/** Frontmatter key to write. */
	property: string;
	/** Value to write. `undefined` removes the key. */
	value: unknown;
	/** True when applying this could lose something the user wrote. Those are
	 * confirmed one at a time and are never included in "fix all". */
	destructive: boolean;
}

/** A wikilink or embed, with the resolution result attached. `target` is null
 * when nothing in the vault answers to `raw` -- which is what a broken link is.
 * There is no separate `broken` flag to fall out of sync with it. */
export interface LinkRef {
	raw: string;
	display: string | null;
	target: string | null;
	embed: boolean;
}

/** The indexed form of one Markdown note. */
export interface NoteRecord {
	path: string;
	basename: string;
	folder: string;
	/** Normalised `type`, lowercased and hyphenated. Null for a note that
	 * declares none -- most of any real vault. Untyped notes are still indexed,
	 * because broken links and orphans matter there too. */
	type: string | null;
	/** The type exactly as written. The vault's own ADRs say `Type: ADR` while
	 * the index note documenting them says `type: adr`; the linter reports that
	 * drift, so the raw spelling has to survive parsing to be reportable. */
	rawType: string | null;
	/** The record kind this note belongs to (`adr`, `incident`, `service`, …),
	 * or null when it is not a toolkit record at all. Distinct from `type`
	 * because several types map to one kind: a server, a database and a cluster
	 * are all infrastructure. */
	kind: RecordKind | null;
	/** Explicit id (`ADR-0002`, `INC-2026-001`), or null. Never synthesised from
	 * the filename: a duplicate-id check that invents the ids it compares would
	 * never find anything. */
	id: string | null;
	title: string;
	/** Normalised `status`, lowercased. */
	status: string | null;
	rawStatus: string | null;
	/** Frontmatter, verbatim. */
	props: Record<string, unknown>;
	/** True when the file has a frontmatter block at all. */
	hasFrontmatter: boolean;
	links: LinkRef[];
	tags: string[];
	mtime: number;
	size: number;
	/** Headings present in the body, in order, lowercased. Drives the
	 * missing-section checks without a second Markdown parser. */
	headings: string[];
	bodyChars: number;
	/** Number of completed checkboxes in the body. Carried on the record so a
	 * task completion is an observable event: Obsidian fires nothing when a box
	 * is ticked, and the count going up across a save is the only signal
	 * available without owning the editor. */
	tasksDone: number;
	/** Checkbox items in the body, parsed. Carried on the record because the
	 * postmortem rule has to see an action item's owner and date, and re-reading
	 * every note's text to find them would mean a second body parse per lint. */
	tasks: TaskItem[];
}

/** One `- [ ]` line. `owner` and `due` are what make an action item an action
 * item rather than a note to self -- the playbook's words are "action items with
 * owners and dates, or the postmortem is a diary entry". */
export interface TaskItem {
	raw: string;
	text: string;
	done: boolean;
	/** A `[[Person]]` link or an `@name`, whichever was written. */
	owner: string | null;
	/** `YYYY-MM-DD`, from a bare date or a 📅 due marker. */
	due: string | null;
}

export type RecordKind = "adr" | "infrastructure" | "incident" | "decision" | "release";

/** The whole derived index. Rebuildable from the vault in full, always. */
export interface ToolkitIndex {
	/** Keyed by vault-relative path. */
	notes: Map<string, NoteRecord>;
	/** path -> paths that link to it. Built once per pass rather than recomputed
	 * per query; the orphan rule and the dashboard both want it. */
	backlinks: Map<string, Set<string>>;
	builtAt: number;
}

export function emptyIndex(): ToolkitIndex {
	return { notes: new Map(), backlinks: new Map(), builtAt: 0 };
}

/** Everything with the given kind, in a stable order. Sorting by id and falling
 * back to path means the ADR index and the incident list are reproducible
 * between runs, which is what makes them testable at all. */
export function ofKind(index: ToolkitIndex, kind: RecordKind): NoteRecord[] {
	return [...index.notes.values()]
		.filter((note) => note.kind === kind)
		.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "") || a.path.localeCompare(b.path));
}

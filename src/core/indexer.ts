// The only file that knows how Obsidian stores metadata; everything downstream
// reads NoteRecords. A full pass yields to the event loop every CHUNK files so
// it never blocks the window.

import { type App, type CachedMetadata, TFile, parseYaml } from "obsidian";
import { emptyIndex, type Issue, type NoteRecord, type ToolkitIndex } from "./types";
import { DEFAULT_PARSE_OPTIONS, linkText, parseNote, stripFrontmatter, type ParseInput, type ParseOptions } from "./parser";
import { Emitter } from "./events";
import { inScope, type Scope } from "./scope";

const CHUNK = 250;

export interface IndexerOptions {
	parse: ParseOptions;
	includeFolders: string[];
	excludeFolders: string[];
}

export const DEFAULT_INDEXER_OPTIONS: IndexerOptions = {
	parse: DEFAULT_PARSE_OPTIONS,
	includeFolders: [],
	excludeFolders: [],
};

export interface IndexState {
	index: ToolkitIndex;
	/** Findings the index itself produced rather than a rule: invalid YAML.
	 * Obsidian hands back no frontmatter for a note whose YAML will not parse,
	 * which is indistinguishable from a note that has none -- so the raw text is
	 * checked here, in the one layer that can see it. */
	carried: Issue[];
}

/** What changed about one note, for the automation module. Computed here because
 * the indexer is the only thing holding the previous record; reconstructing it
 * anywhere else would mean keeping a second copy of the index. */
export interface NoteChange {
	kind: "created" | "modified" | "moved" | "deleted";
	record: NoteRecord | null;
	previous: NoteRecord | null;
	fromPath?: string;
	/** Frontmatter keys whose value differs from the previous record. */
	changedProperties: string[];
	/** Tags present now and not before. */
	addedTags: string[];
}

export class Indexer {
	readonly changed = new Emitter<IndexState>();
	/** Fires once per note that actually changed, after the index is consistent.
	 * Separate from `changed` because an automation must never see a half-built
	 * index, and a view redraw must not wait for one. */
	readonly noteChanged = new Emitter<NoteChange>();

	private index: ToolkitIndex = emptyIndex();
	private carried = new Map<string, Issue[]>();
	private options: IndexerOptions;
	private building = false;
	private pending = new Set<string>();
	private drainTimer: number | null = null;

	constructor(
		private app: App,
		options: IndexerOptions
	) {
		this.options = options;
	}

	state(): IndexState {
		return { index: this.index, carried: [...this.carried.values()].flat() };
	}

	setOptions(options: IndexerOptions): void {
		this.options = options;
	}

	scope(): Scope {
		return { include: this.options.includeFolders, exclude: this.options.excludeFolders };
	}

	private included(file: TFile): boolean {
		if (file.extension !== "md") return false;
		if (file.path.startsWith(".")) return false;
		return inScope(file.path, this.scope());
	}

	private resolver = (raw: string, fromPath: string): string | null => {
		const dest = this.app.metadataCache.getFirstLinkpathDest(raw, fromPath);
		return dest ? dest.path : null;
	};

	/** Build one record. The file body is read only for the character count; the
	 * properties always come from Obsidian's parse, so there is never a second
	 * YAML reader to disagree with the first. */
	private async record(file: TFile): Promise<{ record: NoteRecord; issues: Issue[] }> {
		const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
		const text = await this.app.vault.cachedRead(file);
		const issues: Issue[] = [];

		const frontmatter = (cache?.frontmatter ?? null) as Record<string, unknown> | null;
		if (!frontmatter && text.startsWith("---")) {
			// Obsidian produced nothing from this block, so parse it only to name the error
			// and discard the result: a note with no properties in the app must not validate clean.
			const end = text.indexOf("\n---", 3);
			if (end > 0) {
				try {
					parseYaml(text.slice(4, end));
				} catch (error) {
					issues.push({
						path: file.path,
						code: "ET014",
						rule: "invalid-yaml",
						severity: "error",
						message: `frontmatter will not parse: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
						hint: "Obsidian shows no properties for this note either. Nothing in it is indexed until the YAML is valid.",
					});
				}
			}
		}

		const input: ParseInput = {
			path: file.path,
			basename: file.basename,
			frontmatter,
			links: (cache?.links ?? []).map((l) => ({ link: l.link, displayText: l.displayText })),
			embeds: (cache?.embeds ?? []).map((l) => ({ link: l.link, displayText: l.displayText })),
			tags: [...(cache?.tags ?? []).map((t) => t.tag), ...toTagList(frontmatter?.tags ?? frontmatter?.tag)],
			headings: (cache?.headings ?? []).map((h) => h.heading),
			body: stripFrontmatter(text),
			mtime: file.stat.mtime,
			size: file.stat.size,
		};

		return { record: parseNote(input, this.resolver, this.options.parse), issues };
	}

	async build(): Promise<IndexState> {
		if (this.building) return this.state();
		this.building = true;
		try {
			const files = this.app.vault.getMarkdownFiles().filter((f) => this.included(f));
			const records = new Map<string, NoteRecord>();
			this.carried = new Map();

			for (let i = 0; i < files.length; i += 1) {
				const { record, issues } = await this.record(files[i]);
				records.set(record.path, record);
				if (issues.length) this.carried.set(record.path, issues);
				if (i % CHUNK === CHUNK - 1) await yieldToUi();
			}

			this.index = assemble(records);
			this.changed.emit(this.state());
			return this.state();
		} finally {
			this.building = false;
		}
	}

	/** Re-index one file and rebuild the derived map. */
	async update(file: TFile, kind: NoteChange["kind"] = "modified", fromPath?: string): Promise<void> {
		if (!this.included(file)) return;
		const previous = this.index.notes.get(file.path) ?? null;
		const { record, issues } = await this.record(file);
		this.index.notes.set(record.path, record);
		if (issues.length) this.carried.set(record.path, issues);
		else this.carried.delete(record.path);
		this.reassemble();

		const change: NoteChange = {
			kind: previous === null && kind === "modified" ? "created" : kind,
			record,
			previous,
			fromPath,
			changedProperties: diffProperties(previous, record),
			addedTags: record.tags.filter((tag) => !previous?.tags.includes(tag)),
		};
		this.noteChanged.emit(change);
	}

	remove(path: string): void {
		const previous = this.index.notes.get(path) ?? null;
		if (!this.index.notes.delete(path)) return;
		this.carried.delete(path);
		this.reassemble();
		this.noteChanged.emit({ kind: "deleted", record: null, previous, changedProperties: [], addedTags: [] });
	}

	/** Rebuilding the backlink map is O(links) and runs on every single-file
	 * change. Deliberate: keeping it patched in place means four cases (added,
	 * removed, retargeted, renamed) and a bug in any one of them leaves a phantom
	 * backlink that survives until the next full rebuild -- which, since orphan
	 * findings are computed from exactly this map, would show up as a note the
	 * linter insists is linked when nothing links to it. */
	private reassemble(): void {
		this.index = assemble(this.index.notes);
		this.changed.emit(this.state());
	}

	/** Queue a file for re-indexing, debounced. Typing in a note fires `changed`
	 * repeatedly; re-parsing on each one would make the plugin the busiest thing
	 * in the vault. */
	queue(path: string): void {
		this.pending.add(path);
		if (this.drainTimer !== null) return;
		this.drainTimer = window.setTimeout(() => void this.drain(), 400);
	}

	private async drain(): Promise<void> {
		this.drainTimer = null;
		const paths = [...this.pending];
		this.pending.clear();
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.update(file);
			else this.remove(path);
		}
	}

	dispose(): void {
		if (this.drainTimer !== null) window.clearTimeout(this.drainTimer);
	}
}

/** Build the backlink map. Exported so the tests can assemble an index from
 * hand-written records without an app. */
export function assemble(records: Map<string, NoteRecord>): ToolkitIndex {
	const backlinks = new Map<string, Set<string>>();
	for (const record of records.values()) {
		for (const link of record.links) {
			if (!link.target || link.target === record.path) continue;
			const set = backlinks.get(link.target) ?? new Set<string>();
			set.add(record.path);
			backlinks.set(link.target, set);
		}
	}
	return { notes: records, backlinks, builtAt: Date.now() };
}

/** Frontmatter keys whose value differs. Compared as JSON rather than by
 * reference: Obsidian hands back a fresh object on every parse, so identity
 * comparison would report every key as changed on every keystroke, and an
 * automation watching `status` would fire on a typo in the body. */
function diffProperties(previous: NoteRecord | null, current: NoteRecord): string[] {
	if (!previous) return Object.keys(current.props);
	const keys = new Set([...Object.keys(previous.props), ...Object.keys(current.props)]);
	const changed: string[] = [];
	for (const key of keys) {
		if (JSON.stringify(previous.props[key]) !== JSON.stringify(current.props[key])) changed.push(key);
	}
	return changed;
}

function toTagList(value: unknown): string[] {
	if (!value) return [];
	const items = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
	return items.filter((v) => typeof v === "string" && String(v).trim()).map((v) => String(v).trim());
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export { linkText };

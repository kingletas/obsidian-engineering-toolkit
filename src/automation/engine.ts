// Matching and planning. Pure, so the dry run and the real run call the same
// function and differ only in whether the plan is executed.

import type { NoteRecord } from "../core/types";
import type { Action, AutomationEventKind, AutomationRule, Condition } from "./types";

export interface AutomationEvent {
	kind: AutomationEventKind;
	note: NoteRecord;
	/** For `property-changed`: which property, and what it was. */
	property?: string;
	previous?: unknown;
	/** For `tag-added`. */
	tag?: string;
	/** For `note-moved`. */
	fromPath?: string;
}

export interface PlannedAction {
	rule: AutomationRule;
	action: Action;
	/** Vault-relative path of the note the event was about. Carried on the plan
	 * rather than looked up again at apply time, so the action is performed on
	 * the note the preview named even if the active file has since changed. */
	sourcePath: string;
	/** Human-readable, shown in the preview and written to the log. Rendered
	 * here rather than in the UI so the log and the dialog cannot drift. */
	describe: string;
	/** Substituted value, ready to apply. */
	value: string;
}

function fieldValue(note: NoteRecord, field: string): string | null {
	if (field.startsWith("prop:")) {
		const raw = note.props[field.slice(5)];
		return raw === undefined || raw === null ? null : String(raw);
	}
	switch (field) {
		case "folder":
			return note.folder;
		case "type":
			return note.type;
		case "status":
			return note.status;
		case "path":
			return note.path;
		case "title":
			return note.title;
		case "tag":
			return note.tags.join(" ");
		default:
			return null;
	}
}

export function matches(condition: Condition, note: NoteRecord): boolean {
	const actual = fieldValue(note, condition.field);
	const expected = condition.value.trim();
	switch (condition.op) {
		case "exists":
			return actual !== null && actual !== "";
		case "equals":
			return (actual ?? "").toLowerCase() === expected.toLowerCase();
		case "not-equals":
			return (actual ?? "").toLowerCase() !== expected.toLowerCase();
		case "contains":
			// Whole-word for tags, substring for everything else. A `contains`
			// on tags that matched substrings would fire an `archive` rule on
			// every note tagged `archived`.
			if (condition.field === "tag") return note.tags.some((tag) => tag.toLowerCase() === expected.toLowerCase());
			return (actual ?? "").toLowerCase().includes(expected.toLowerCase());
		case "matches":
			try {
				return new RegExp(expected, "i").test(actual ?? "");
			} catch {
				// An invalid pattern must not match everything. A rule with a typo
				// in its regex firing on every note in the vault is the exact
				// failure §9.7 exists to prevent.
				return false;
			}
		default:
			return false;
	}
}

export function ruleApplies(rule: AutomationRule, event: AutomationEvent): boolean {
	if (!rule.enabled) return false;
	if (rule.event !== event.kind) return false;
	if (rule.event === "property-changed" && rule.watchProperty && rule.watchProperty !== event.property) return false;
	if (rule.event === "tag-added" && event.tag === undefined) return false;
	// Every condition must hold. §9.4's examples are all conjunctions and an
	// implicit OR would make a two-condition rule mean the opposite of what it
	// reads like.
	return rule.conditions.every((condition) => matches(condition, event.note));
}

/** Substitute the four tokens. Unknown tokens are left as written rather than
 * blanked, so a typo shows up in the note as `{{titel}}` instead of vanishing. */
export function substitute(template: string, note: NoteRecord, now: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
	return template
		.replace(/\{\{date\}\}/g, date)
		.replace(/\{\{time\}\}/g, time)
		.replace(/\{\{title\}\}/g, note.title)
		.replace(/\{\{path\}\}/g, note.path);
}

function describe(action: Action, value: string, note: NoteRecord): string {
	switch (action.kind) {
		case "set-property":
			return `set \`${action.target}: ${value}\` on ${note.path}`;
		case "add-tag":
			return `add \`#${action.target}\` to ${note.path}`;
		case "move-note":
			return `move ${note.path} to ${value || action.target}/`;
		case "create-note":
			return `create ${value || action.target}`;
		case "append-text":
			return `append to ${note.path}${action.target ? ` under \`${action.target}\`` : ""}: ${truncate(value)}`;
		case "create-task":
			return `add a task to ${note.path}: ${truncate(value)}`;
		case "add-link":
			return `link ${note.path} to [[${value || action.target}]]`;
		default:
			return `${action.kind} on ${note.path}`;
	}
}

function truncate(text: string): string {
	return text.length <= 60 ? text : `${text.slice(0, 57)}…`;
}

/** Everything the given rules would do for this event, in rule order. Returns an
 * empty list when nothing matches, which is the overwhelmingly common case and
 * is why this is cheap enough to call on every vault event. */
export function plan(rules: AutomationRule[], event: AutomationEvent, now: Date): PlannedAction[] {
	const out: PlannedAction[] = [];
	for (const rule of rules) {
		if (!ruleApplies(rule, event)) continue;
		for (const action of rule.actions) {
			const value = substitute(action.value ?? "", event.note, now);
			out.push({ rule, action, sourcePath: event.note.path, value, describe: describe(action, value, event.note) });
		}
	}
	return out;
}

/** The loop guard (§9.7): a note the runner just wrote is ignored for `quietMs`,
 * and a rule fires on one note at most `maxPerNote` times per session. The runner
 * adds the third guard by planning nothing when a value is already set. */
export class LoopGuard {
	private fires = new Map<string, number>();
	private quiet = new Map<string, number>();

	constructor(
		private maxPerNote: number,
		private quietMs: number
	) {}

	/** Called after the runner writes, so the resulting event is ignored. */
	touched(path: string, at: number): void {
		this.quiet.set(path, at);
	}

	/** Null when the rule may run; otherwise the reason it may not, which is
	 * written to the execution log rather than discarded -- a rule that silently
	 * stops firing is indistinguishable from a rule that was never on. */
	blocked(rule: AutomationRule, path: string, at: number): string | null {
		const quietSince = this.quiet.get(path);
		if (quietSince !== undefined && at - quietSince < this.quietMs) return "the note was written by an automation moments ago";
		const key = `${rule.id}::${path}`;
		const count = this.fires.get(key) ?? 0;
		if (count >= this.maxPerNote) return `this rule has already run ${count} times on this note in this session`;
		return null;
	}

	record(rule: AutomationRule, path: string): void {
		const key = `${rule.id}::${path}`;
		this.fires.set(key, (this.fires.get(key) ?? 0) + 1);
	}

	reset(): void {
		this.fires.clear();
		this.quiet.clear();
	}
}

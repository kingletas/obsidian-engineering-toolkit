// The automation vocabulary (§9.3–§9.5). The action set is closed and has no
// delete action, so no rule can delete a note.

export type AutomationEventKind = "note-created" | "note-modified" | "property-changed" | "task-completed" | "note-moved" | "tag-added";

export const EVENT_KINDS: AutomationEventKind[] = ["note-created", "note-modified", "property-changed", "task-completed", "note-moved", "tag-added"];

export type ConditionOp = "equals" | "not-equals" | "contains" | "matches" | "exists";

export const CONDITION_OPS: ConditionOp[] = ["equals", "not-equals", "contains", "matches", "exists"];

export interface Condition {
	/** `folder`, `type`, `status`, `tag`, `path`, or `prop:<key>` for anything
	 * else in frontmatter. */
	field: string;
	op: ConditionOp;
	value: string;
}

export type ActionKind = "set-property" | "add-tag" | "move-note" | "create-note" | "append-text" | "create-task" | "add-link";

export const ACTION_KINDS: ActionKind[] = ["set-property", "add-tag", "move-note", "create-note", "append-text", "create-task", "add-link"];

export interface Action {
	kind: ActionKind;
	/** Property name, tag, target folder, heading, or link target depending on
	 * `kind`. One field rather than seven optional ones: the settings UI has to
	 * render whichever is relevant, and a shape with seven mostly-empty keys
	 * makes the stored JSON unreadable. */
	target: string;
	/** The value, where the action takes one. `{{date}}`, `{{time}}`, `{{title}}`
	 * and `{{path}}` are substituted. */
	value?: string;
}

export interface AutomationRule {
	id: string;
	name: string;
	/** §9.7: automation requires explicit activation. A rule is created off and
	 * has to be switched on by hand, every time -- including a rule restored
	 * from settings written by an older version. */
	enabled: boolean;
	event: AutomationEventKind;
	conditions: Condition[];
	actions: Action[];
	/** For `property-changed`: only fire when this property is the one that
	 * changed. Empty means any property. */
	watchProperty?: string;
}

/** What actually happened, for §9.7's execution log. Kept in memory for the
 * session and shown in settings; nothing is written to the vault, because a log
 * that writes notes is itself a note-creating automation and would show up in
 * its own log. */
export interface ExecutionEntry {
	at: number;
	ruleId: string;
	ruleName: string;
	path: string;
	/** One line per action, already rendered for display. */
	actions: string[];
	/** Set when the run was blocked instead of performed. */
	blocked?: string;
}

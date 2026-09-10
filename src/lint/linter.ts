// Runs the rules and shapes the result (§8.1, §8.3). Pure; invalid YAML is
// reported by the indexer, the only layer that sees the raw text.

import type { Issue, Severity, ToolkitIndex } from "../core/types";
import { RULES, type Rule, type RuleContext } from "./rules";

export { RULES } from "./rules";
export type { Rule } from "./rules";

export interface LintOptions {
	/** Rule id -> enabled. A missing entry means enabled (§8.4). */
	enabled?: Record<string, boolean>;
	/** Rule id -> severity override. */
	severity?: Record<string, Severity>;
	orphanExemptFolders?: string[];
	unusedTagThreshold?: number;
	/** Epoch milliseconds. Defaulted rather than required so a caller that does
	 * not care about the time-sensitive rules need not think about it, but
	 * injectable so their tests do not change meaning tomorrow. */
	now?: number;
	restoreTestDays?: number;
	/** Restrict findings to one note. The rules still run over the whole index --
	 * a duplicate id is only visible vault-wide -- and the result is filtered
	 * afterwards, so "check this note" and "check the vault" can never disagree
	 * about the same note. */
	only?: string;
	rules?: Rule[];
}

export interface LintResult {
	issues: Issue[];
	counts: Record<Severity, number>;
	/** Rule id -> number of findings, including the rules that found nothing.
	 * A rule reporting zero and a rule that did not run look identical in a
	 * findings list and are entirely different facts. */
	byRule: Record<string, number>;
	scannedNotes: number;
	durationMs: number;
}

const emptyCounts = (): Record<Severity, number> => ({ error: 0, warning: 0, info: 0 });

export function lint(index: ToolkitIndex, carried: Issue[] = [], options: LintOptions = {}): LintResult {
	const started = Date.now();
	const ctx: RuleContext = {
		index,
		ignoreProperties: ["tags", "aliases", "cssclasses"],
		orphanExemptFolders: options.orphanExemptFolders ?? [],
		unusedTagThreshold: options.unusedTagThreshold ?? 2,
		now: options.now ?? Date.now(),
		restoreTestDays: options.restoreTestDays ?? 180,
	};

	const rules = options.rules ?? RULES;
	const byRule: Record<string, number> = {};
	let issues: Issue[] = [...carried];

	for (const rule of rules) {
		if (options.enabled && options.enabled[rule.id] === false) {
			byRule[rule.id] = 0;
			continue;
		}
		let found: Issue[];
		try {
			found = rule.run(ctx);
		} catch (error) {
			// One malformed note must not take the other twelve rules with it, and
			// the failure has to be visible rather than showing up as a rule that
			// quietly finds nothing for the rest of the session.
			found = [
				{
					path: "",
					code: "ET000",
					rule: rule.id,
					severity: "error",
					message: `the \`${rule.title}\` check failed: ${error instanceof Error ? error.message : String(error)}`,
				},
			];
		}
		const override = options.severity?.[rule.id];
		if (override) found = found.map((issue) => ({ ...issue, severity: override }));
		byRule[rule.id] = found.length;
		issues.push(...found);
	}

	if (options.only) issues = issues.filter((issue) => issue.path === options.only);

	const counts = emptyCounts();
	for (const issue of issues) counts[issue.severity] += 1;

	const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
	issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.code.localeCompare(b.code));

	return { issues, counts, byRule, scannedNotes: index.notes.size, durationMs: Date.now() - started };
}

/** Group findings by note, in the order the findings pane renders them. */
export function groupByPath(issues: Issue[]): Array<{ path: string; issues: Issue[] }> {
	const groups = new Map<string, Issue[]>();
	for (const issue of issues) groups.set(issue.path, [...(groups.get(issue.path) ?? []), issue]);
	const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
	const worst = (list: Issue[]): number => Math.min(...list.map((i) => rank[i.severity]));
	return [...groups.entries()]
		.map(([path, list]) => ({ path, issues: list }))
		.sort((a, b) => worst(a.issues) - worst(b.issues) || b.issues.length - a.issues.length || a.path.localeCompare(b.path));
}

/** The fixable findings, grouped per note, with the destructive ones separated.
 *
 * §8.5's requirement is that "any potentially destructive fix must require
 * confirmation". This goes one step further: a destructive fix is never part of
 * a batch at all, because a confirmation dialog listing forty changes is a
 * dialog nobody reads, and "I confirmed it" then means "I clicked past it". */
export function fixable(issues: Issue[]): { safe: Issue[]; destructive: Issue[] } {
	const withFix = issues.filter((issue) => issue.fix);
	return {
		safe: withFix.filter((issue) => !issue.fix?.destructive),
		destructive: withFix.filter((issue) => issue.fix?.destructive),
	};
}

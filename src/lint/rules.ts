// The rule set (§8.2): pure functions over the whole index, filtered on `kind`
// where a rule applies only to toolkit records. ERROR means the vault
// contradicts itself, WARNING that one note is wrong, INFO that the vault drifts.

import type { Issue, NoteRecord, Severity, ToolkitIndex } from "../core/types";
import { linkText } from "../core/parser";
import { defFor, normaliseType, RECORD_TYPES } from "../records/record-types";
import { infraGraph, tierInversions } from "../infra/infra-engine";
import { incidents } from "../incidents/incident-engine";
import { budgetMinutes, formatBudget } from "../reliability/slo";

export interface RuleContext {
	index: ToolkitIndex;
	/** Frontmatter keys never reported as unknown or empty. */
	ignoreProperties: string[];
	/** Folders whose notes are exempt from the orphan check. An index note in a
	 * folder nobody links into is not an orphan, it is a table of contents. */
	orphanExemptFolders: string[];
	/** A tag used fewer times than this is reported as drift. */
	unusedTagThreshold: number;
	/** Epoch milliseconds. Passed in rather than read inside a rule, so a rule
	 * that compares against "now" stays a pure function and its test does not
	 * change meaning tomorrow. */
	now: number;
	/** How old a tested restore may be before it is called stale. */
	restoreTestDays: number;
}

export interface Rule {
	id: string;
	code: string;
	title: string;
	description: string;
	defaultSeverity: Severity;
	run(ctx: RuleContext): Issue[];
}

const all = (ctx: RuleContext): NoteRecord[] => [...ctx.index.notes.values()];
const records = (ctx: RuleContext): NoteRecord[] => all(ctx).filter((note) => note.kind !== null);

// --- errors ------------------------------------------------------------------

export const brokenLinks: Rule = {
	id: "broken-links",
	code: "ET001",
	title: "Broken links",
	description: "A wikilink that resolves to no file in the vault.",
	defaultSeverity: "error",
	run(ctx) {
		const out: Issue[] = [];
		for (const note of all(ctx)) {
			for (const link of note.links) {
				if (link.target) continue;
				const raw = linkText(link.raw);
				// An empty target is `[[]]`, Dataview's "this file" syntax, and is valid.
				if (!raw) continue;
				out.push({
					path: note.path,
					code: "ET001",
					rule: "broken-links",
					severity: "error",
					message: link.embed ? `dead embed \`![[${raw}]]\`` : `broken link \`[[${raw}]]\``,
				});
			}
		}
		return out;
	},
};

export const duplicateIds: Rule = {
	id: "duplicate-ids",
	code: "ET002",
	title: "Duplicate record IDs",
	description: "Two records sharing an id. The one thing about a record that is supposed to be unique.",
	defaultSeverity: "error",
	run(ctx) {
		const byId = new Map<string, NoteRecord[]>();
		for (const note of records(ctx)) {
			if (!note.id) continue;
			const key = note.id.trim().toUpperCase();
			byId.set(key, [...(byId.get(key) ?? []), note]);
		}
		const out: Issue[] = [];
		for (const [id, notes] of byId) {
			if (notes.length < 2) continue;
			for (const note of notes) {
				out.push({
					path: note.path,
					code: "ET002",
					rule: "duplicate-ids",
					severity: "error",
					property: "id",
					message: `duplicate record id \`${id}\``,
					hint: `Also used by: ${notes.filter((n) => n !== note).map((n) => n.path).join(", ")}`,
				});
			}
		}
		return out;
	},
};

export const requiredProperties: Rule = {
	id: "required-properties",
	code: "ET003",
	title: "Missing required properties",
	description: "A record missing a property its type needs to be usable.",
	defaultSeverity: "warning",
	run(ctx) {
		const out: Issue[] = [];
		for (const note of records(ctx)) {
			const def = defFor(note.type);
			if (!def) continue;
			for (const property of def.required) {
				const value = note.props[property];
				if (value !== undefined && value !== null && String(value).trim() !== "") continue;
				out.push({
					path: note.path,
					code: "ET003",
					rule: "required-properties",
					severity: "warning",
					property,
					message: `\`${def.label}\` is missing \`${property}\``,
					hint: `Every ${note.type} carries \`${def.required.join("`, `")}\`.`,
				});
			}
		}
		return out;
	},
};

export const invalidStatus: Rule = {
	id: "invalid-status",
	code: "ET004",
	title: "Invalid status",
	description: "A record whose status is not one its type defines.",
	defaultSeverity: "error",
	run(ctx) {
		const out: Issue[] = [];
		for (const note of records(ctx)) {
			const def = defFor(note.type);
			if (!def || def.statuses.length === 0 || !note.status) continue;
			if (def.statuses.includes(note.status)) continue;
			// A near miss gets an autofix; anything else does not, because
			// choosing a status on the user's behalf is a judgement, not a repair.
			const near = def.statuses.find((s) => s.startsWith(note.status ?? "") || (note.status ?? "").startsWith(s));
			out.push({
				path: note.path,
				code: "ET004",
				rule: "invalid-status",
				severity: "error",
				property: "status",
				message: `\`${note.rawStatus}\` is not a ${note.type} status`,
				hint: `Expected one of: ${def.statuses.join(", ")}.`,
				fix: near ? { label: `Set status to \`${near}\``, property: "status", value: near, destructive: false } : null,
			});
		}
		return out;
	},
};

export const invalidSeverity: Rule = {
	id: "invalid-severity",
	code: "ET005",
	title: "Invalid incident severity",
	description: "An incident whose severity is not SEV-1 through SEV-4.",
	defaultSeverity: "error",
	run(ctx) {
		const out: Issue[] = [];
		for (const note of records(ctx)) {
			if (note.kind !== "incident") continue;
			const raw = note.props.severity;
			if (raw === undefined || raw === null || String(raw).trim() === "") continue;
			const text = String(raw).trim();
			if (/^SEV-[1-4]$/.test(text)) continue;
			// `sev2`, `SEV 2` and `2` all mean the same thing and all normalise
			// cleanly, so those get an autofix. Anything else is left alone.
			const digit = /^(?:sev)?[\s-]*([1-4])$/i.exec(text);
			out.push({
				path: note.path,
				code: "ET005",
				rule: "invalid-severity",
				severity: "error",
				property: "severity",
				message: `\`${text}\` is not a severity`,
				hint: "Expected SEV-1, SEV-2, SEV-3 or SEV-4.",
				fix: digit ? { label: `Set severity to \`SEV-${digit[1]}\``, property: "severity", value: `SEV-${digit[1]}`, destructive: false } : null,
			});
		}
		return out;
	},
};

// --- warnings ----------------------------------------------------------------

export const missingTitle: Rule = {
	id: "missing-title",
	code: "ET006",
	title: "Missing heading",
	description: "A record with no level-one heading, so it has no title inside the note.",
	defaultSeverity: "warning",
	run(ctx) {
		return records(ctx)
			.filter((note) => note.headings.length === 0 && note.bodyChars > 0)
			.map((note) => ({
				path: note.path,
				code: "ET006",
				rule: "missing-title",
				severity: "warning" as Severity,
				message: "no heading in the note body",
				hint: "A record with no heading is invisible in outline view and in search results.",
			}));
	},
};

export const missingSections: Rule = {
	id: "missing-sections",
	code: "ET007",
	title: "Missing sections",
	description: "A record missing a section its type's template writes.",
	defaultSeverity: "info",
	run(ctx) {
		const out: Issue[] = [];
		for (const note of records(ctx)) {
			const def = defFor(note.type);
			if (!def || def.sections.length === 0 || note.bodyChars === 0) continue;
			const missing = def.sections.filter((section) => !note.headings.some((h) => h.startsWith(section)));
			if (missing.length === 0) continue;
			out.push({
				path: note.path,
				code: "ET007",
				rule: "missing-sections",
				severity: "info",
				message: `missing ${missing.length === 1 ? "section" : "sections"}: ${missing.join(", ")}`,
				hint: "INFO rather than a warning: a record in progress is allowed to be incomplete.",
			});
		}
		return out;
	},
};

export const orphanNotes: Rule = {
	id: "orphan-notes",
	code: "ET008",
	title: "Orphan records",
	description: "A record nothing links to. Findable by search, invisible by navigation.",
	defaultSeverity: "warning",
	run(ctx) {
		return records(ctx)
			.filter((note) => (ctx.index.backlinks.get(note.path)?.size ?? 0) === 0)
			.filter((note) => !ctx.orphanExemptFolders.some((folder) => note.path.startsWith(folder + "/")))
			.map((note) => ({
				path: note.path,
				code: "ET008",
				rule: "orphan-notes",
				severity: "warning" as Severity,
				message: "nothing in the vault links to this record",
				hint: "Link it from the index note for its type, or from the thing it is about.",
			}));
	},
};

export const inconsistentTypeCase: Rule = {
	id: "inconsistent-type-case",
	code: "ET009",
	title: "Inconsistent type spelling",
	description: "The same record type written two ways across the vault.",
	defaultSeverity: "info",
	run(ctx) {
		// Report only spellings that differ from each type's majority spelling, so a
		// vault consistent in a spelling the plugin did not choose stays clean.
		const spellings = new Map<string, Map<string, NoteRecord[]>>();
		for (const note of records(ctx)) {
			if (!note.rawType || !note.type) continue;
			const perType = spellings.get(note.type) ?? new Map<string, NoteRecord[]>();
			perType.set(note.rawType, [...(perType.get(note.rawType) ?? []), note]);
			spellings.set(note.type, perType);
		}
		const out: Issue[] = [];
		for (const [type, perType] of spellings) {
			if (perType.size < 2) continue;
			const ranked = [...perType.entries()].sort((a, b) => b[1].length - a[1].length);
			const majority = ranked[0][0];
			for (const [spelling, notes] of ranked.slice(1)) {
				for (const note of notes) {
					out.push({
						path: note.path,
						code: "ET009",
						rule: "inconsistent-type-case",
						severity: "info",
						property: "type",
						message: `type written \`${spelling}\`; ${ranked[0][1].length} other ${type} notes write \`${majority}\``,
						hint: "Frontmatter keys and values are case-sensitive to anything reading them but Obsidian's own search.",
					});
				}
			}
		}
		return out;
	},
};

export const unknownType: Rule = {
	id: "unknown-type",
	code: "ET010",
	title: "Unknown record type",
	description: "A note in a records folder whose type is not one the toolkit knows.",
	defaultSeverity: "info",
	run(ctx) {
		const known = new Set(RECORD_TYPES.map((def) => def.type));
		const out: Issue[] = [];
		for (const note of all(ctx)) {
			if (!note.rawType || note.kind !== null) continue;
			const near = [...known].find((type) => normaliseType(note.rawType ?? "").startsWith(type) || type.startsWith(normaliseType(note.rawType ?? "")));
			if (!near) continue;
			out.push({
				path: note.path,
				code: "ET010",
				rule: "unknown-type",
				severity: "info",
				property: "type",
				message: `\`${note.rawType}\` is close to the known type \`${near}\` but is not it`,
				hint: "Nothing in the toolkit indexes this note as a record.",
			});
		}
		return out;
	},
};

export const unusedTags: Rule = {
	id: "unused-tags",
	code: "ET011",
	title: "Near-unique tags",
	description: "A tag used on one record and nowhere else. Usually a typo of a tag that exists.",
	defaultSeverity: "info",
	run(ctx) {
		const counts = new Map<string, NoteRecord[]>();
		for (const note of all(ctx)) {
			for (const tag of new Set(note.tags)) counts.set(tag, [...(counts.get(tag) ?? []), note]);
		}
		const out: Issue[] = [];
		for (const [tag, notes] of counts) {
			if (notes.length >= ctx.unusedTagThreshold) continue;
			// Only reported when a sibling tag exists that it is probably a typo
			// of. A genuinely new tag on its first note is not a defect, and
			// reporting it means every new topic starts with a warning.
			const sibling = [...counts.keys()].find((other) => other !== tag && counts.get(other)!.length > notes.length && (other.startsWith(tag) || tag.startsWith(other)));
			if (!sibling) continue;
			for (const note of notes) {
				out.push({
					path: note.path,
					code: "ET011",
					rule: "unused-tags",
					severity: "info",
					property: "tags",
					message: `tag \`#${tag}\` is used ${notes.length === 1 ? "once" : `${notes.length} times`}; \`#${sibling}\` is used ${counts.get(sibling)!.length} times`,
				});
			}
		}
		return out;
	},
};

export const unresolvedDependencies: Rule = {
	id: "unresolved-dependencies",
	code: "ET012",
	title: "Undocumented dependencies",
	description: "An infrastructure note depending on something that has no note.",
	defaultSeverity: "warning",
	run(ctx) {
		const names = new Set<string>();
		for (const note of records(ctx)) {
			if (note.kind !== "infrastructure") continue;
			names.add(note.basename);
			if (typeof note.props.name === "string") names.add(note.props.name.trim());
		}
		const out: Issue[] = [];
		for (const note of records(ctx)) {
			if (note.kind !== "infrastructure") continue;
			const raw = note.props.dependencies ?? note.props.depends_on;
			const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];
			for (const entry of list) {
				const ref = String(entry).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
				if (!ref || names.has(ref)) continue;
				out.push({
					path: note.path,
					code: "ET012",
					rule: "unresolved-dependencies",
					severity: "warning",
					property: "dependencies",
					message: `depends on \`${ref}\`, which has no infrastructure note`,
					hint: "The dependency tree renders it as `(no note)` rather than dropping it.",
				});
			}
		}
		return out;
	},
};

export const staleOpenIncident: Rule = {
	id: "stale-open-incident",
	code: "ET013",
	title: "Incident open with a resolved time",
	description: "An incident carrying a resolution timestamp while its status still says open.",
	defaultSeverity: "warning",
	run(ctx) {
		const out: Issue[] = [];
		for (const note of records(ctx)) {
			if (note.kind !== "incident") continue;
			const resolved = note.props.resolved;
			const hasResolved = resolved !== undefined && resolved !== null && String(resolved).trim() !== "";
			if (!hasResolved) continue;
			if (note.status !== "open" && note.status !== "investigating") continue;
			out.push({
				path: note.path,
				code: "ET013",
				rule: "stale-open-incident",
				severity: "warning",
				property: "status",
				message: `status is \`${note.status}\` but \`resolved\` is set to ${String(resolved).trim()}`,
				hint: "The open count on the dashboard is wrong for as long as this disagrees with itself.",
				fix: { label: "Set status to `resolved`", property: "status", value: "resolved", destructive: false },
			});
		}
		return out;
	},
};

// --- reliability (SRE) -------------------------------------------------------
// Every rule below applies only to notes that declare a `tier`.

export const tierOneNeedsSlo: Rule = {
	id: "tier-one-needs-slo",
	code: "ET015",
	title: "Tier-1 component with no objective",
	description: "A component graded most critical with nothing to hold it to. An error budget is what turns reliability from an argument into arithmetic.",
	defaultSeverity: "warning",
	run(ctx) {
		const graph = infraGraph(ctx.index);
		return [...graph.nodes.values()]
			.filter((node) => node.reliability.tier === 1 && node.reliability.slos.length === 0)
			.map((node) => ({
				path: node.note.path,
				code: "ET015",
				rule: "tier-one-needs-slo",
				severity: "warning" as Severity,
				property: "slo",
				message: "tier 1, but declares no SLO",
				hint: "e.g. `slo: [availability 99.9% over 30d]`. Without an objective and a window there is no error budget, and without a budget the reliability conversation stays a negotiation.",
			}));
	},
};

export const sloShape: Rule = {
	id: "slo-shape",
	code: "ET016",
	title: "Unusable objective",
	description: "An SLO missing the objective or the window it needs before an error budget can be computed from it.",
	defaultSeverity: "error",
	run(ctx) {
		const out: Issue[] = [];
		for (const node of infraGraph(ctx.index).nodes.values()) {
			for (const slo of node.reliability.slos) {
				if (slo.problem === null || slo.problem === "percentile") continue;
				const message =
					slo.problem === "no-window"
						? `\`${slo.raw}\` states no window`
						: slo.problem === "no-objective"
							? `\`${slo.raw}\` states no objective`
							: `\`${slo.raw}\` states an objective outside 0–100%`;
				out.push({
					path: node.note.path,
					code: "ET016",
					rule: "slo-shape",
					severity: "error",
					property: "slo",
					message,
					hint: "An objective needs a target and a period before it means anything: 99.9% of what, over how long? Write it as `availability 99.9% over 30d`.",
				});
			}
		}
		return out;
	},
};

export const percentileSlo: Rule = {
	id: "percentile-slo",
	code: "ET017",
	title: "Latency stated as a percentile",
	description: "A percentile is a single number about a distribution; there is no proportion in it to spend, so nothing can be budgeted against it.",
	defaultSeverity: "info",
	run(ctx) {
		const out: Issue[] = [];
		for (const node of infraGraph(ctx.index).nodes.values()) {
			for (const slo of node.reliability.slos) {
				if (slo.problem !== "percentile") continue;
				out.push({
					path: node.note.path,
					code: "ET017",
					rule: "percentile-slo",
					severity: "info",
					property: "slo",
					message: `\`${slo.raw}\` is a percentile, not an objective`,
					hint: '"99% of requests under 500ms over 30d" composes with an error budget; "p99 is 500ms" does not.',
				});
			}
		}
		return out;
	},
};

export const slaTighterThanSlo: Rule = {
	id: "sla-tighter-than-slo",
	code: "ET018",
	title: "SLA at or below the SLO",
	description: "A contractual promise that is not looser than the internal target. If they are equal, missing the SLO costs money immediately.",
	defaultSeverity: "error",
	run(ctx) {
		const out: Issue[] = [];
		for (const node of infraGraph(ctx.index).nodes.values()) {
			const sla = node.reliability.sla;
			if (sla === null) continue;
			const strongest = node.reliability.slos.map((s) => s.objective).filter((o): o is number => o !== null).sort((a, b) => b - a)[0];
			if (strongest === undefined || sla < strongest) continue;
			out.push({
				path: node.note.path,
				code: "ET018",
				rule: "sla-tighter-than-slo",
				severity: "error",
				property: "sla",
				message: `SLA ${pct(sla)} is ${sla === strongest ? "equal to" : "tighter than"} the SLO ${pct(strongest)}`,
				hint: "An SLA is always looser than the SLO — the gap between them is the margin in which you find out you have a problem before a customer does.",
			});
		}
		return out;
	},
};

export const untestedRestore: Rule = {
	id: "untested-restore",
	code: "ET019",
	title: "RTO with no tested restore",
	description: "A recovery time stated but never demonstrated. A backup that has never been restored is not a backup.",
	defaultSeverity: "warning",
	run(ctx) {
		const out: Issue[] = [];
		for (const node of infraGraph(ctx.index).nodes.values()) {
			if (node.reliability.rto === null) continue;
			const last = node.reliability.lastRestoreTest;
			const at = last ? Date.parse(last) : NaN;
			const stale = !Number.isFinite(at) || ctx.now - at > ctx.restoreTestDays * 86400000;
			if (!stale) continue;
			out.push({
				path: node.note.path,
				code: "ET019",
				rule: "untested-restore",
				severity: "warning",
				property: "last_restore_test",
				message: last ? `last tested restore was ${last}` : "states an RTO but records no tested restore",
				hint: "The measured duration of a real restore is the RTO. The stated one is an estimate, and it is usually several times too optimistic.",
			});
		}
		return out;
	},
};

export const tierOneNeedsRunbook: Rule = {
	id: "tier-one-needs-runbook",
	code: "ET020",
	title: "Tier-1 component with no runbook",
	description: "The most critical components, with nothing for somebody woken at 3am to open.",
	defaultSeverity: "warning",
	run(ctx) {
		const out: Issue[] = [];
		for (const node of infraGraph(ctx.index).nodes.values()) {
			if (node.reliability.tier !== 1) continue;
			const missing = [!node.reliability.runbook ? "runbook" : null, !node.reliability.escalation ? "escalation" : null].filter(Boolean);
			if (missing.length === 0) continue;
			out.push({
				path: node.note.path,
				code: "ET020",
				rule: "tier-one-needs-runbook",
				severity: "warning",
				property: missing[0] as string,
				message: `tier 1, but has no ${missing.join(" and no ")}`,
			});
		}
		return out;
	},
};

export const tierInversion: Rule = {
	id: "tier-inversion",
	code: "ET021",
	title: "Component resting on something weaker",
	description: "A dependency graded less critical than the thing depending on it — a promise that cannot be kept, and invisible on either note alone.",
	defaultSeverity: "warning",
	run(ctx) {
		return tierInversions(infraGraph(ctx.index)).map((entry) => ({
			path: entry.node.note.path,
			code: "ET021",
			rule: "tier-inversion",
			severity: "warning" as Severity,
			property: "dependencies",
			message: `tier ${entry.node.reliability.tier} but depends on ${entry.dependency.name}, which is tier ${entry.dependency.reliability.tier}`,
			hint: "Either the dependency is more critical than its note says, or this component's tier is aspirational. Both are worth knowing; neither is visible from one page.",
		}));
	},
};

export const weakActionItems: Rule = {
	id: "weak-action-items",
	code: "ET022",
	title: "Follow-up without an owner or a date",
	description: "An action item with nobody assigned or no date. The playbook's words: or the postmortem is a diary entry.",
	defaultSeverity: "warning",
	run(ctx) {
		const out: Issue[] = [];
		for (const row of incidents(ctx.index)) {
			if (row.actionsWithoutOwner.length === 0) continue;
			out.push({
				path: row.note.path,
				code: "ET022",
				rule: "weak-action-items",
				severity: "warning",
				message: `${row.actionsWithoutOwner.length} open follow-up item${row.actionsWithoutOwner.length === 1 ? "" : "s"} with no owner or no date`,
				hint: `First: "${row.actionsWithoutOwner[0].text.slice(0, 80)}". Add a \`[[Person]]\` and a date.`,
			});
		}
		return out;
	},
};

export const detectionNotRecorded: Rule = {
	id: "detection-not-recorded",
	code: "ET023",
	title: "Incident with no detection recorded",
	description: "A resolved incident that does not say how it was found. The detection gap is the most useful number an incident record produces, and it costs one property.",
	defaultSeverity: "info",
	run(ctx) {
		return incidents(ctx.index)
			.filter((row) => (row.status === "resolved" || row.status === "closed") && !row.detectedBy)
			.map((row) => ({
				path: row.note.path,
				code: "ET023",
				rule: "detection-not-recorded",
				severity: "info" as Severity,
				property: "detected_by",
				message: "does not record how the incident was found",
				hint: "`detected_by: monitor | alert | human | customer`. The remediation that matters most is usually detection, and this is the only place it gets counted.",
			}));
	},
};

function pct(ratio: number): string {
	return `${Math.round(ratio * 1000) / 10}%`;
}

/** Kept as an export so a settings page can show what a budget looks like
 * without importing the reliability module directly. */
export { budgetMinutes, formatBudget };

export const RULES: Rule[] = [
	brokenLinks,
	duplicateIds,
	requiredProperties,
	invalidStatus,
	invalidSeverity,
	missingTitle,
	missingSections,
	orphanNotes,
	inconsistentTypeCase,
	unknownType,
	unusedTags,
	unresolvedDependencies,
	staleOpenIncident,
	tierOneNeedsSlo,
	sloShape,
	percentileSlo,
	slaTighterThanSlo,
	untestedRestore,
	tierOneNeedsRunbook,
	tierInversion,
	weakActionItems,
	detectionNotRecorded,
];

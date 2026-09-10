// Maps a note's `type:` to a record kind and says what each kind may look like.
// Values are normalised once in `normaliseType`, and the raw spelling stays on
// the record so spelling drift remains reportable.

import type { RecordKind } from "../core/types";

export interface RecordTypeDef {
	/** Normalised `type` value. */
	type: string;
	kind: RecordKind;
	label: string;
	/** Frontmatter keys a note of this type must carry to be complete. Missing
	 * ones are a WARNING, never an ERROR: an incomplete note is still a note,
	 * and a plugin that calls an unfinished draft an error is one people turn
	 * off. */
	required: string[];
	/** Allowed `status` values. Empty means the type does not use status. */
	statuses: string[];
	/** Headings the template writes. A record missing one of these is drifting
	 * from the shape the rest of them have, which is worth an INFO. */
	sections: string[];
}

/** ADR statuses. Five, from §4.3. The vault's own ADR index documents three
 * (`proposed | accepted | superseded`); the extra two are accepted here rather
 * than rejected, because a narrower list would make the existing practice the
 * thing that fails validation. */
export const ADR_STATUSES = ["proposed", "accepted", "rejected", "superseded", "deprecated"] as const;

/** §6.4. `closed` is last and is the only state that means nothing further will
 * be written; `resolved` means the outage is over but the postmortem may not be. */
export const INCIDENT_STATUSES = ["open", "investigating", "mitigated", "resolved", "closed"] as const;

/** §6.3's example uses `SEV-2`. Stored uppercased with the hyphen, because that
 * is how it is written in every incident channel anyone has ever read. */
export const SEVERITIES = ["SEV-1", "SEV-2", "SEV-3", "SEV-4"] as const;

export const DECISION_STATUSES = ["active", "superseded", "reversed"] as const;

export const ENVIRONMENTS = ["development", "staging", "production"] as const;

/** The reliability contract an infrastructure note may carry; none of it is
 * required, and the linter reports what is missing by `tier`. */
export const RELIABILITY_PROPERTIES = ["tier", "slo", "sla", "rto", "rpo", "last_restore_test", "runbook", "dashboard", "alerts", "escalation", "on_call"] as const;

/** How an incident was found. `customer` and `human` are kept apart on purpose:
 * both mean the monitoring missed it, but only one of them means it reached
 * somebody who is paying. */
export const DETECTION_SOURCES = ["monitor", "alert", "human", "customer", "unknown"] as const;

export const RECORD_TYPES: RecordTypeDef[] = [
	{
		type: "adr",
		kind: "adr",
		label: "Architecture decision record",
		required: ["status", "date"],
		statuses: [...ADR_STATUSES],
		sections: ["context", "decision", "alternatives", "consequences"],
	},
	{
		type: "incident",
		kind: "incident",
		label: "Incident",
		required: ["status", "severity", "started"],
		statuses: [...INCIDENT_STATUSES],
		sections: ["summary", "impact", "detection", "timeline", "root cause", "resolution", "follow-up actions"],
	},
	{
		type: "decision",
		kind: "decision",
		label: "Decision",
		required: ["date"],
		statuses: [...DECISION_STATUSES],
		sections: ["decision", "reason"],
	},
	// --- infrastructure (§5.1). Six types, one kind. -------------------------
	{ type: "service", kind: "infrastructure", label: "Service", required: ["environment"], statuses: [], sections: [] },
	{ type: "database", kind: "infrastructure", label: "Database", required: ["environment"], statuses: [], sections: [] },
	{ type: "cluster", kind: "infrastructure", label: "Cluster", required: ["environment"], statuses: [], sections: [] },
	{ type: "server", kind: "infrastructure", label: "Server", required: ["environment"], statuses: [], sections: [] },
	{ type: "network", kind: "infrastructure", label: "Network", required: [], statuses: [], sections: [] },
	{ type: "application", kind: "infrastructure", label: "Application", required: ["environment"], statuses: [], sections: [] },
];

const BY_TYPE = new Map(RECORD_TYPES.map((def) => [def.type, def]));

/** Lowercase, trim, collapse whitespace and underscores to hyphens. `ADR`,
 * `adr` and `Architecture Decision Record` do not all normalise to the same
 * thing on purpose -- only case and separator drift is absorbed, because
 * guessing at synonyms would make the type property mean whatever the plugin
 * decided it meant. */
export function normaliseType(raw: string): string {
	return raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function defFor(type: string | null): RecordTypeDef | null {
	return type ? (BY_TYPE.get(type) ?? null) : null;
}

export function kindOf(type: string | null): RecordKind | null {
	return defFor(type)?.kind ?? null;
}

export function typesOfKind(kind: RecordKind): RecordTypeDef[] {
	return RECORD_TYPES.filter((def) => def.kind === kind);
}

/** The infrastructure types, for the create modal's dropdown. */
export const INFRA_TYPES = typesOfKind("infrastructure").map((def) => def.type);

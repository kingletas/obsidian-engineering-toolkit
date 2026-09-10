// The note bodies, as pure strings so tests can assert on the exact output.
// Prose is never hard-wrapped, and every table, list, fence and callout has a
// blank line before and after it.

import { frontmatter, isoDate, isoMinute } from "./core/notes";

export interface AdrInput {
	id: string;
	title: string;
	status: string;
	date: Date;
	owner: string;
	tags: string[];
	context?: string;
}

/** Keeps the layout existing ADR notes already use; where a written spec disagrees, the existing notes win. */
export function adrNote(input: AdrInput): string {
	const props = frontmatter({
		Owner: input.owner,
		Type: "ADR",
		date: isoDate(input.date),
		domain: "Decisions",
		status: input.status,
		aliases: [input.id],
		tags: input.tags,
		State: "active",
	});

	return `${props}

# ${input.id} — ${input.title}

> [!info] Status
> **${titleCase(input.status)}.** Name the condition under which this should be revisited — a decision correct at one scale is often wrong at ten times that scale, and nobody notices the crossing.

## Context

${input.context?.trim() || "The forces in tension. What is true that makes this a real choice rather than an obvious one?"}

## Decision

What was chosen, stated as an instruction someone could follow.

## Alternatives

### Option A

**Advantages** — 
**Disadvantages** — 

### Option B

**Advantages** — 
**Disadvantages** — 

> [!important] Record the alternative that was nearly chosen, and why it lost
> That is the single most valuable line in an ADR and the one most often left out. An ADR with no real alternatives is a note, not a decision record.

## Consequences

What this obliges the system and the team to do afterwards — including the parts you do not like. Adopting a decision without its consequences is accepting the disadvantages without the advantages.

- 

## Related

- [[Architecture Decision Records]]
`;
}

export interface IncidentInput {
	id: string;
	title: string;
	severity: string;
	status: string;
	started: Date;
	service?: string;
	owner: string;
	tags: string[];
	/** How it was found. Written as an empty property when unknown rather than
	 * omitted, so the field is visible in the Properties panel at the moment
	 * somebody still remembers the answer. */
	detectedBy?: string;
}

export function incidentNote(input: IncidentInput): string {
	const props = frontmatter({
		Owner: input.owner,
		Type: "incident",
		id: input.id,
		date: isoDate(input.started),
		status: input.status,
		severity: input.severity,
		started: isoMinute(input.started),
		detected_at: isoMinute(input.started),
		detected_by: input.detectedBy ?? "",
		resolved: "",
		caused_by_deploy: "",
		deploy_ref: "",
		service: input.service ? `[[${input.service}]]` : "",
		aliases: [input.id],
		tags: input.tags,
		State: "active",
	});

	return `${props}

# ${input.id} — ${input.title}

> [!danger] ${input.severity} · ${titleCase(input.status)}
> Started ${isoMinute(input.started)}. Fill the impact line first and the rest afterwards — an incident note written after the fact is missing exactly the observations that were only available during it.

## Summary

One paragraph, written for somebody who was not there.

## Impact

Who was affected, how many, and for how long. A number, not "some users".

## Detection

How it was found, and how long after it started. **If a human noticed before a monitor did, say so** — that gap is the finding, and it is the one most often left out of the timeline.

Set \`detected_at\` to the moment somebody first knew, and \`detected_by\` to \`monitor\`, \`alert\`, \`human\` or \`customer\`. Those two properties are the whole reason the reliability snapshot can tell a monitoring failure from a slow fix; without them an outage found in two minutes and repaired in ninety is indistinguishable from the reverse.

## Timeline

| Time | Event |
|---|---|
| ${isoMinute(input.started)} | Started |

## Root Cause

## Resolution

## Follow-up Actions

Every item needs an owner and a date, or the postmortem is a diary entry.

- [ ] Action — ${input.owner || "@owner"} 📅 
`;
}

export interface DecisionInput {
	title: string;
	date: Date;
	owner: string;
	tags: string[];
}

export function decisionNote(input: DecisionInput): string {
	const props = frontmatter({
		Owner: input.owner,
		Type: "decision",
		date: isoDate(input.date),
		status: "active",
		tags: input.tags,
		State: "active",
	});

	return `${props}

# Decision — ${input.title}

## Decision

What was decided, in one sentence.

## Reason

Why. If the reason is "it was the only option that worked", say that — a decision log entry with an invented rationale is worse than none.

## Alternatives

- 

## Related

- 
`;
}

export interface InfraInput {
	type: string;
	title: string;
	environment: string;
	owner: string;
	dependencies: string[];
	tags: string[];
	/** 1 is the most critical. Null writes the property empty rather than
	 * omitting it: an ungraded component should be visibly ungraded. */
	tier: number | null;
	slo: string;
}

export function infraNote(input: InfraInput): string {
	const props = frontmatter({
		Owner: input.owner,
		Type: input.type,
		name: input.title,
		environment: input.environment,
		tier: input.tier ?? "",
		// A list even when it holds one entry: a component acquires a second
		// objective the moment anybody thinks about latency, and a property that
		// changes shape between one and two values breaks every reader of it.
		slo: input.slo.trim() ? [input.slo.trim()] : [],
		sla: "",
		rto: "",
		rpo: "",
		last_restore_test: "",
		runbook: "",
		dashboard: "",
		escalation: input.owner,
		dependencies: input.dependencies.map((dep) => `[[${dep}]]`),
		tags: input.tags,
		State: "active",
	});

	return `${props}

# ${input.title}

> [!info] ${titleCase(input.type)} · ${titleCase(input.environment)}${input.tier ? ` · Tier ${input.tier}` : ""}
> This note documents the ${input.type}. It does not operate it — provisioning, monitoring and credentials live in the systems that own them.

## What it is

## Reliability

The contract lives in the properties above, not here. Write the objective as a proportion over a window — \`availability 99.9% over 30d\` — because that composes with an error budget and a percentile does not.

- **Tier** — 1 is the most critical. It is what decides whether a missing objective is a gap or a defect, and it should be at least as strong as everything this depends on.
- **RTO / RPO** — how long down, how much data lost. Both are buyable and neither is free. Record \`last_restore_test\` when a restore is actually performed and timed: the measured duration is the real RTO, and it is usually several times the estimate.

## Dependencies

${input.dependencies.length ? input.dependencies.map((dep) => `- [[${dep}]]`).join("\n") : "- "}

## Operational notes

What somebody woken at 3am needs to know before touching this.

## Related

- 
`;
}

function titleCase(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

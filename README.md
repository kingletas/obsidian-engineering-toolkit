<h1 align="center">🛠 Engineering Toolkit</h1>

<p align="center">
  Light structure around the engineering documentation your Obsidian vault already holds.
</p>

<p align="center">
  <img alt="Obsidian" src="https://img.shields.io/badge/obsidian-1.5.0%2B-7c3aed">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-strict-2a6db2">
  <img alt="Tests" src="https://img.shields.io/badge/tests-106-brightgreen">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

Architecture decision records, infrastructure notes, incidents and postmortems, a day-to-day decision log, a documentation linter and small event automations. **Markdown and YAML stay the source of truth throughout** — there is no database, and disabling the plugin changes nothing in your vault.

It was built from a private requirements document; the `§` references below point at that document and are kept as provenance for *why* a decision was made. You do not need it to read this.

**Nothing is scoped and nothing is signed on a fresh install.** `Indexed folders` is empty and `Owner` is blank, on purpose — a shipped folder name would be one vault's folder, silently scoping every other install to a path that does not exist. Set both before you use it; see [First run](#first-run).

---

## The secrets detector is not here, and that is the point

§10 of the requirements document specifies a **Secrets Detector** — scan notes for credentials, flag the ones that look like a leak, warn before a commit. It is not implemented, not stubbed, and not planned here.

The reason is that it solves the problem in the wrong direction. A detector treats a credential in a note as something to *find after it has been written*, which means the secret was in the vault, in the editor's undo history, and quite possibly in a commit before anything noticed.

The approach worth taking instead keeps secret values out of Markdown in the first place: notes carry a secret manager's path and metadata, the values live in the secret manager, and there is nothing in a note for a detector to find.

Those two designs do not compose, they compete. Building the detector now would establish the habit the other design exists to remove, and would have to be unbuilt later. So the area is left empty rather than half-filled.

What that means concretely for this plugin:

- **Nothing here reads a note looking for a credential.** No pattern list, no entropy heuristic, no scanning pass.
- **Nothing here transmits note content anywhere.** There is no network code in the bundle at all.
- **The infrastructure module documents infrastructure and manages no credentials** (§5.6), which was already the requirements document's own constraint on it.

If a credential does end up in a note, this plugin will not tell you. That is a real gap and it is stated here rather than papered over. Use a pre-commit secret scanner on the repository your vault lives in — this repository ships one in [`scripts/check_credentials.py`](scripts/check_credentials.py).

---

## Seven plugins, one plugin

§2.3 of that document asks for composability: install the ADR module without the incident module. Obsidian has no mechanism for a plugin to depend on another plugin, so seven separate plugins would mean seven copies of the indexer, the parser and the linter — and seven places for them to drift apart. §17 anticipates this and recommends a shared core.

The resolution is one plugin with six modules, each with its own switch in settings. Turning a module off removes its commands and its dashboard section entirely. **The section disappears rather than reading zero**, because a count of zero and a module that is not running look identical on screen and are completely different facts.

| Module | What it does | §  |
|---|---|---|
| **ADR Manager** | Numbering, statuses, supersession chains, an index view | §4 |
| **Infrastructure** | Services, databases, clusters, environments, a dependency tree | §5 |
| **Incident Manager** | Severities, statuses, timelines, durations, postmortem completeness | §6 |
| **Decision Log** | Small decisions, promotable into an ADR | §7 |
| **Vault Linter** | Thirteen checks with codes, severities, off switches and safe autofixes | §8 |
| **Workflow Automation** | WHEN / IF / DO rules over vault events | §9 |
| **Reliability (SRE)** | Tiers, SLOs, error budgets, blast radius, the incident detection split, DORA | — |

---

## Reliability — it records the contract, it does not measure it

This module is not in the requirements document. It exists because a vault that already carries an SRE vocabulary — reliability notes, a metrics glossary, recovery objectives — and a monitoring system that already emits SLOs with burn-rate alerting is still missing the layer in between: somewhere the *promise* is written down.

**The boundary is absolute, and it is the reason the module is safe.** Nothing here reads a running system. No Prometheus queries, no Grafana, no AWS, no HTTP of any kind — `tests/smoke.cjs` greps the shipped bundle for `fetch(`, `XMLHttpRequest`, `requestUrl(` and `new WebSocket` and fails the build if one appears. This documents the contract; the systems holding the telemetry measure whether it is kept. It is the same split as Obsidian and Vault for secrets.

### What a service note carries

```yaml
tier: 1
slo:
  - availability 99.9% over 30d
  - latency 99% under 500ms over 30d
sla: 99.5%
rto: 4h
rpo: 15m
last_restore_test: 2026-08-01
runbook: "[[Magento Runbook]]"
escalation: "[[Dana Reyes]]"
```

**The error budget is derived, never stored.** 99.9% over 30 days is 43.2 minutes, computed at render time from the objective and its window — so it cannot drift from the objective it came from, and there is never a moment where the two disagree and nobody knows which is the decision.

### Nine checks, each from a line already written down

None of these is this plugin's opinion about how to run a service. Each one is the executable form of a sentence in the playbook, so it can be argued with by arguing with the page it came from.

| Code | Check | Default | The line it comes from |
|---|---|---|---|
| `ET015` | Tier-1 with no objective | 🟡 | "An error budget converts reliability from an argument into arithmetic" |
| `ET016` | Objective with no target or no window | 🔴 | 99.9% of *what period* is undefined |
| `ET017` | Latency stated as a percentile | 🔵 | A proportion composes with a budget; `p99 = 500ms` does not |
| `ET018` | SLA at or tighter than the SLO | 🔴 | "If they are equal, missing the SLO costs money immediately" |
| `ET019` | RTO stated, restore never or long ago tested | 🟡 | "A backup that has never been restored is not a backup" |
| `ET020` | Tier-1 with no runbook or escalation | 🟡 | What somebody woken at 3am opens first |
| `ET021` | **Component resting on something weaker** | 🟡 | A tier-1 service on a tier-3 database is a promise that cannot be kept |
| `ET022` | Follow-up item with no owner or no date | 🟡 | "Or the postmortem is a diary entry" |
| `ET023` | Resolved incident that does not say how it was found | 🔵 | "The remediation that matters most is usually detection" |

**`ET021` is the one worth having.** Every other check can be seen by reading one note. A tier inversion cannot: both pages are internally consistent and the contradiction exists only across the edge between them.

Every reliability rule is scoped to notes that declare a `tier`. A service nobody has graded is a service nobody has promised anything about, so a missing SLO on it is not a defect — otherwise every new infrastructure note would start life with a warning.

### Incidents: detection is split out from repair

`detected_at` and `detected_by` turn one duration into two. An outage found in two minutes and fixed in ninety is a different problem from one found in ninety and fixed in two, and **only the second is a monitoring failure** — a single number cannot tell them apart. From `detected_by` comes the **detection gap**: the share of incidents a person or a customer noticed before monitoring did.

When no incident records a source, the gap is reported as **absent**, not as 0%. Those are opposite findings.

### DORA, with one metric refused

Three keys come out of release notes joined to incidents that name a deploy. **Lead time does not** — it needs commit timestamps a vault has none of, and a release note's own date measures the release train rather than the change. It is printed as *not derivable here* with that reason, rather than estimated.

Two guards, both learned elsewhere and both load-bearing:

- **A release counts as a deployment only when it is marked complete *and* its time has passed.** The train here is scheduled years ahead — there are release notes dated 2029 in the tree — so counting every note would build a frequency mostly out of releases that have not happened.
- **A rate from fewer than five deployments is shown but not graded.** One deploy and one incident give a change failure rate of 100%: arithmetically right, and next to a red verdict it says something false.

### The snapshot

`Write reliability snapshot` renders a dated note into your configured findings folder — at-a-glance callout, coverage bars, a blast-radius table, a mermaid dependency diagram styled with strokes only so it survives both themes, the DORA table with verdicts, and the findings summary.

**A new file every time; never an overwrite.** A generated note the plugin owns and rewrites is a note somebody eventually hand-edits and loses. A dated snapshot has no such problem — it is a record of what was true when it ran.

And the line that appears on the face of every one of them, not in a footnote:

> **Every number here is a count of notes.** It is a picture of the documentation, not of production. A vault that documents nothing scores identically to an estate with nothing to document, and *time to restore* here means *time to restore as recorded*.

---

## It adopts your ADR practice rather than replacing it

This is the most consequential decision in the plugin and it is worth stating first.

The vault it was built for already had four ADRs, written to a house template, with filenames of the form `ADR-0002 — Patch Third-Party Core Rather Than Subclass It` and a hand-maintained index note listing them. §4.2 of the requirements document printed a different, more generic template.

**Where a specification and a practice already in use disagree about a format, the practice wins.** A plugin that renumbers, reformats or re-types the records you already have is a plugin that splits one convention into two. So:

- New ADRs use the playbook template, down to the prompts inside each section and the `> [!important] Record the alternative that was nearly chosen` callout.
- Numbers are zero-padded to four digits. `ADR-5` would sort before every ADR that came before it.
- `Type: ADR` — capitalised, as the existing four write it. YAML keys are case-sensitive, so a plugin reading only `type` would index every existing ADR as an untyped note.
- The filename separator is the em dash with spaces either side, matching what is there.
- The linter's **inconsistent type spelling** rule reports the *minority* spelling, so a vault that consistently writes `Type: ADR` reports nothing. The convention is not wrong for having been chosen by a person rather than by this plugin.

Linking a new ADR from the index note is offered as a checkbox on the create dialog. It **appends one bullet** under `## Records` and does nothing else — nothing is reordered, rewritten or removed, and a missing `## Records` heading means the note is left completely alone rather than having a list appended to the bottom of a document the plugin did not understand.

---

## What it will not do to your vault

- **It never deletes a note.** Not through a command, not through an automation, not through a fix. `tests/smoke.cjs` greps the shipped bundle for a vault deletion call and fails the build if one appears.
- **It never overwrites a note.** Every create goes through a unique-path check; a collision produces `Name 2.md`.
- **It never rewrites a note body.** Fixes and automations write frontmatter through Obsidian's own `processFrontMatter`, which leaves the body byte-for-byte alone. The two actions that do touch the body (`append-text`, `add-link`) only ever append a line.
- **It writes nothing on install.** No folders, no templates, no index. Everything is created by an explicit command you invoke.
- **Automation ships off, and every rule you write ships off.** A rule loaded from settings is forced back to disabled on every load — including settings copied from another vault or written by an older version. There is a test for that.

---

## Scope — point it at what you have structured

**A fresh install indexes the whole vault, so set a scope before you rely on the findings.** Settings → *Indexed folders* is a comma-separated allowlist; *Excluded folders* is applied afterwards and subtracts from it. An empty allowlist means the whole vault.

This is not a performance setting. A documentation linter pointed at a general-purpose vault reports overwhelmingly on notes nobody asked it about — journals, bookmarks, fiction — and the engineering signal drowns in them. Links still resolve vault-wide: a record linking to a note outside the scope is not a broken link, because the scope decides what is *checked*, never what is *reachable*.

**The scope is named next to every count**, in the scan notice and on the dashboard header, because a number with no denominator on it reads as a whole-vault figure.

---

## Commands

| Command | What it does |
|---|---|
| `Scan indexed folders` | Full index pass, then lint. |
| `Open dashboard` | Overview, ADRs, Infrastructure, Incidents, Decisions, Findings. |
| `Show all findings` | The findings tab directly. |
| `Check current note` | Findings for the active note, as a notice and in the dashboard. |
| `New architecture decision record` | Allocates the next number and writes the playbook template. |
| `New incident` | Allocates `INC-<year>-<n>` and seeds the timeline with the start time. |
| `New decision log entry` | A short decision note. |
| `New infrastructure note` | Service, database, cluster, server, network or application. |
| `Resolve this incident` | Stamps `resolved`, sets the status, and names the postmortem sections still missing. |
| `Promote this decision to an ADR` | Creates the ADR and marks the decision superseded. Shown only on a decision note. |
| `Fix what can be fixed` | Confirms the exact list, then applies the non-destructive fixes. |
| `Write reliability snapshot` | Renders the dated report into the findings folder. Hidden when the reliability module is off. |

---

## The linter

Thirteen checks, each with a code, a severity you can override and an off switch. One more — `ET014`, invalid YAML — is reported by the indexer rather than by a rule, because Obsidian hands back no frontmatter for a note whose YAML will not parse and only the layer that can see the raw text can tell that apart from a note that has none.

The severities follow one line, and it is the line that decides whether the error count is worth looking at:

> **Error** means the vault contradicts itself. **Warning** means one note is wrong. **Info** means the vault is drifting.

A linter that calls an unfinished draft an error gets switched off, and then it catches nothing at all. That is why `missing-sections` is info and `required-properties` is a warning.

| Code | Check | Default |
|---|---|---|
| `ET001` | Broken links and dead embeds | error |
| `ET002` | Duplicate record IDs | error |
| `ET003` | Missing required properties | warning |
| `ET004` | Invalid status for the record type | error |
| `ET005` | Invalid incident severity | error |
| `ET006` | Record with no heading | warning |
| `ET007` | Missing sections the template writes | info |
| `ET008` | Orphan records | warning |
| `ET009` | Inconsistent type spelling | info |
| `ET010` | Type close to a known one but not it | info |
| `ET011` | Near-unique tag next to a common sibling | info |
| `ET012` | Dependency with no infrastructure note | warning |
| `ET013` | Incident open but carrying a resolved time | warning |
| `ET014` | Frontmatter will not parse | error |

**Rules only ever speak about notes whose type they own.** That matters more than it looks: in a vault that uses TaskNotes, `status` is that plugin's field on every task, and a status rule running over every note would report every task.

### Autofix

Only four findings offer one, and each writes a single frontmatter property: a near-miss status, a severity written `sev2` / `SEV 2` / `2`, and an incident whose status disagrees with its own `resolved` timestamp. **A status the plugin cannot infer is never guessed** — choosing one on your behalf is a judgement, not a repair.

§8.5 asks for confirmation before a potentially destructive fix. This goes further: a destructive fix is **never part of a batch**, because a dialog listing forty changes is a dialog nobody reads, and "I confirmed it" then means "I clicked past it". The confirmation lists the actual operations, not a count.

---

## Automation

The model is §9.2's, unchanged: **WHEN** an event fires, **IF** every condition holds, **DO** these actions.

Six events (`note-created`, `note-modified`, `property-changed`, `task-completed`, `note-moved`, `tag-added`), five condition operators over `folder`, `type`, `status`, `tag`, `path`, `title` or any `prop:<key>`, and seven actions. `{{date}}`, `{{time}}`, `{{title}}` and `{{path}}` are substituted; an unknown token is left visible rather than blanked, so a typo shows up as `{{titel}}` in the note instead of vanishing.

**There is no delete action and there will not be one.** §9.7's "never silently delete notes" is met by not putting the capability in the language, which is a stronger guarantee than a confirmation dialog.

Five more things hold §9.7 up:

1. **Explicit activation.** Rules are created off and forced off on every load.
2. **Preview.** *Preview* dry-runs a rule against the open note through **the same planner the real run uses**. A preview computed by separate code is a preview that can be wrong, and a wrong preview is worse than none — it is the thing you trusted when you said yes.
3. **A loop guard with three legs.** A note the runner just wrote is ignored for four seconds; a rule may fire at most three times on one note per session; and an action that would set a property to the value it already holds performs no write, so a steady state stays steady and produces no event to re-trigger on. All three are needed — the first alone loses to a two-rule cycle slower than the quiet window.
4. **An execution log**, in settings, including the runs that were *blocked* and why. A rule that silently stops firing is indistinguishable from a rule that was never on.
5. **The log is memory-only.** Writing it to a note would make the log itself a note-creating automation, which would then appear in its own log.

`task-completed` is derived rather than observed — Obsidian fires no event when a checkbox is ticked, so the signal is the completed-task count going up across a save. It fires once per save, not once per task.

---

## Install

Never built an Obsidian plugin before? [`docs/from-nothing.md`](docs/from-nothing.md) walks through every step, from a clean machine to your first record.

```bash
git clone https://github.com/kingletas/obsidian-engineering-toolkit && cd obsidian-engineering-toolkit && npm ci && npm run build
```

```bash
cp main.js manifest.json styles.css "$YOUR_VAULT/.obsidian/plugins/engineering-toolkit/"
```

Then enable it in **Settings → Community plugins**. Do the enabling through Obsidian's own UI rather than by editing `community-plugins.json`: the running app rewrites that file from memory when it exits.

## First run

1. **Set `Indexed folders`** to the folders that actually hold your engineering records. Empty means the whole vault, and a linter pointed at a general-purpose vault reports overwhelmingly on notes nobody asked it about — noise is what makes people turn a linter off.
2. **Set `Owner`.** It is stamped onto every record the create commands write, and it ships blank rather than signing your vault with someone else's name.
3. **Point the record folders at the folders you already use.** They default to `Engineering/...`, which is a valid place to start and almost certainly not where your existing ADRs live. Issuing a new ADR somewhere other than where the old ones are is how one practice becomes two.
4. **Workflow Automation ships off** and is forced off on load whatever `data.json` says. It is the only module that writes to notes without being asked.

## Development

```bash
npm ci
npm run dev      # esbuild watch
npm test         # 106 assertions across ten suites, then the smoke test
npm run build    # typecheck, then a production bundle
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the toolchain and the rules that are not obvious from the code. [`SECURITY.md`](SECURITY.md) covers vulnerability reports.

Everything except `main.ts`, `settings.ts`, the runner and the four UI files is pure — a function of an index and some options — so the tests drive the real code with hand-written notes and no app. `tests/fixtures.cjs` parses those notes through the **real** parser and assembles them through the **real** backlink builder; a fixture that hand-constructed a record would be testing the rules against a shape the parser might never produce.

There is no on-disk index cache, deliberately. Obsidian has already parsed every note's frontmatter by the time the plugin asks for an index, so a full pass over a scoped vault is milliseconds — and a cache that saves nothing is still a second thing that can be wrong, in a plugin whose whole claim is that the Markdown is the only state.

---

## What is not built

- **The secrets detector** (§10) — see the top of this file.
- **The shared dashboard as a note** (§13) — the dashboard is a view, not a generated note. A generated note would be a file the plugin owns and overwrites, which is the one thing this design avoids.
- **`create-note` templates** — an automation's `create-note` writes a stub, not a record template. Wiring the record templates into automation would let a rule generate ADRs, and automatic ADR numbering plus automatic ADR creation is a combination worth thinking about before shipping.

## License

[MIT](LICENSE) © Luis Tineo

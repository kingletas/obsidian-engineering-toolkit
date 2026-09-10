# Architecture

About 5,200 lines of TypeScript, no runtime dependencies, seven modules and one shared core. **Markdown and YAML stay the source of truth throughout** — there is no database and no on-disk index cache.

## The shape

```text
Vault ──▶ core/parser.ts    ── frontmatter + body → a record
              │
              ▼
        core/indexer.ts     ── records, backlinks, scope
              │
    ┌─────────┼────────┬──────────┬─────────┬────────────┬──────────────┐
    ▼         ▼        ▼          ▼         ▼            ▼              ▼
  adr/     infra/  incidents/ decisions/ lint/     reliability/   automation/
  engine   engine  engine     engine     rules       dora/slo       engine
    │         │        │          │         │            │              │
    └─────────┴────────┴──────────┴─────────┴────────────┴──────────────┘
                                  │
                                  ▼
                    dashboard/dashboard-engine.ts ──▶ ui/
```

| Area | Responsibility |
|---|---|
| `core/parser.ts` | Frontmatter and body to a record. One place, so nothing downstream disagrees about a key |
| `core/indexer.ts` | The index, backlinks, scope, incremental updates |
| `core/ids.ts` | Record numbering — zero-padded, gap-aware |
| `core/notes.ts` | Frontmatter writing, including the YAML quoting rules |
| `adr/`, `infra/`, `incidents/`, `decisions/` | The four record engines |
| `lint/rules.ts` | Thirteen checks — the largest file here, and deliberately flat |
| `reliability/` | SLOs, blast radius, DORA, and the snapshot report |
| `automation/` | WHEN / IF / DO rules, and the runner that fires them |
| `templates.ts` | The record templates |
| `ui/` | The dashboard view, three modals |

## Five decisions worth knowing

### One plugin, not seven

The requirements document asked for composability — install the ADR module without the incident module.

**Obsidian has no mechanism for a plugin to depend on another plugin.** Seven separate plugins would mean seven copies of the indexer, the parser and the linter, and seven places for them to drift apart. So composability is a set of module toggles over one shared core, which is what §17 of that document recommended anyway.

### It adopts your practice rather than replacing it

**Where a specification and a practice already in use disagree about a format, the practice wins.** A plugin that renumbers, reformats or re-types the records you already have is a plugin that splits one convention into two.

Concretely, from the vault this was built for:

- New ADRs use the existing house template, down to the prompts inside each section.
- **Numbers are zero-padded to four digits.** `ADR-5` would sort before every ADR that came before it.
- **`Type: ADR` — capitalised, as the existing records write it.** YAML keys are case-sensitive, so a plugin reading only `type` would index every existing ADR as an untyped note.
- The linter's *inconsistent type spelling* rule reports the **minority** spelling, so a vault that consistently writes `Type: ADR` reports nothing. A convention is not wrong for having been chosen by a person rather than by this plugin.

### No default belongs to one vault

`Indexed folders` ships empty. `Owner` ships blank. The record folders default to a generic `Engineering/...` tree.

A folder name shipped as a default is shipped to every install, where it silently scopes the index to a path that does not exist — presenting as *the index found nothing* rather than as a setting nobody set. `Owner` is worse: it is stamped onto every record the create commands write, so a default signs one person's vault with another person's name.

The templates follow the same rule. The postmortem's follow-up example uses the configured owner and falls back to a visible `@owner` slot — never to a name.

### There is no index cache, deliberately

Obsidian has already parsed every note's frontmatter by the time the plugin asks for an index, so a full pass over a scoped vault is milliseconds.

**A cache that saves nothing is still a second thing that can be wrong**, in a plugin whose whole claim is that the Markdown is the only state.

### Reliability records the contract; it does not measure it

The module exists because a vault that already carries an SRE vocabulary, and monitoring that already emits SLOs with burn-rate alerting, is still missing the layer in between: somewhere the *promise* is written down.

Three properties of the implementation are load-bearing:

- **`detected_at` and `detected_by` are the whole reason a snapshot can tell a monitoring failure from a slow fix.** Without them, an outage found in two minutes and repaired in ninety is indistinguishable from the reverse. The incident template offers both as empty properties, at the moment somebody still remembers the answer.
- **Three DORA keys are derived; lead time is not.** It needs commit timestamps a vault has none of, and a release note's own date measures the release train rather than the change. It prints as *not derivable here* with that reason, rather than being estimated. **An unmeasurable thing reports as unmeasured.**
- **The snapshot writes a new dated file every time, never an overwrite.** A generated note the plugin owns and rewrites is a note somebody eventually hand-edits and loses.

And the caveat sits on the face of every snapshot rather than in a footnote:

> **Every number here is a count of notes.** It is a picture of the documentation, not of production. A vault that documents nothing scores identically to an estate with nothing to document, and *time to restore* here means *time to restore as recorded*.

## What is deliberately absent

**The secrets detector.** It is specified in §10 and is not implemented, not stubbed, and not planned here.

A detector treats a credential in a note as something to find *after* it has been written — by which time the secret is in the vault, in the editor's undo history, and quite possibly in a commit. The competing design keeps values out of Markdown in the first place: notes carry a secret manager's path and metadata, the values live in the secret manager, and there is nothing in a note for a detector to find.

**Those two designs do not compose, they compete.** Building the detector now would establish the habit the other design exists to remove, and would have to be unbuilt later. So the area is left empty rather than half-filled — and the gap is stated rather than papered over: **if a credential ends up in a note, this plugin will not tell you.**

Two properties keep that honest, and both are asserted against the shipped bundle rather than the sources:

- **No network call anywhere in the bundle.** Nothing here transmits note content.
- **No vault deletion call at all.** Not a guarded one, not a confirmed one — none.

## Workflow Automation

The only module that writes to notes without being asked, so it **ships off and is forced off on load whatever `data.json` says.** A rule that fires on a vault event is hard to take back, and enabling it is a deliberate act.

`create-note` writes a stub rather than a record template, on purpose. Wiring the record templates into automation would let a rule generate ADRs — and automatic ADR numbering plus automatic ADR creation is a combination worth thinking about before shipping.

## Testing

The suite `require()`s an esbuild bundle rather than the TypeScript sources, because the bundle is the only thing Obsidian ever loads. 106 assertions across ten suites.

Everything except `main.ts`, `settings.ts`, the automation runner and the UI files is pure — a function of an index and some options — so the tests drive the real code with hand-written notes and no app.

**`tests/fixtures.cjs` parses those notes through the real parser and assembles them through the real backlink builder.** A fixture that hand-constructed a record would be testing the rules against a shape the parser might never produce.

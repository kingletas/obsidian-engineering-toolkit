# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **No default belongs to one vault any more.** `Indexed folders` ships empty, `Owner` ships blank, and the record folders default to a generic `Engineering/...` tree.
  - A folder name shipped as a default is shipped to every install, where it silently scopes the index to a path that does not exist — which presents as *the index found nothing* rather than as a setting nobody set.
  - `Owner` is stamped onto every record the create commands write, so a shipped default signs one person's vault with another person's name. The postmortem template's follow-up example now uses the configured owner, falling back to a visible `@owner` slot rather than to a name.
- The repository gains a licence, a contributing guide, a security policy, an architecture document and CI that builds the artifact Obsidian actually loads.
- **CI runs `make check`**, the same gate a commit has to pass, on Ubuntu only. `make check` now also fails when `manifest.json`, `package.json` and `versions.json` disagree about the version.
- The plugin lists Luis Tineo as its author.
- **A release workflow.** Pushing a tag equal to the version in `manifest.json`, with no leading `v`, builds the plugin and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css` attached, which is what Obsidian's installer downloads.
- **`make install` and `make plan` need a vault named.** Pass `VAULT=`, or set `OBSIDIAN_VAULT`. The old default pointed at a folder that only existed on the author's machine. When `obsidian-plugin-install` is not on your `PATH`, `scripts/install-plugin.sh` does the build and the copy instead.

## [0.2.0] — 2026-08-24

### Added

- **The reliability module** — tiers, SLOs, error budgets, blast radius, the incident detection split, and DORA.
  - It exists because a vault that already carries an SRE vocabulary, and monitoring that already emits SLOs with burn-rate alerting, is still missing the layer in between: **somewhere the promise is written down.**
  - **`detected_at` and `detected_by` are the whole reason the snapshot can tell a monitoring failure from a slow fix.** Without them an outage found in two minutes and repaired in ninety is indistinguishable from the reverse. The incident template offers both as empty properties, at the moment somebody still remembers the answer.
  - **Three DORA keys are derived; lead time is not.** It needs commit timestamps a vault has none of, and a release note's own date measures the release train rather than the change. It prints as *not derivable here* with that reason, rather than being estimated.
  - **`Write reliability snapshot` writes a new dated file every time, never an overwrite.** A generated note the plugin owns and rewrites is a note somebody eventually hand-edits and loses.
  - Every snapshot carries the caveat on its face rather than in a footnote: **every number here is a count of notes.** It is a picture of the documentation, not of production.

## [0.1.0] — 2026-08-24

### Added

- **Engineering Toolkit** — six of the requirements document's seven components, in one plugin rather than seven.
  - **ADR Manager**, **Infrastructure**, **Incident Manager**, **Decision Log**, **Vault Linter** and **Workflow Automation**.
  - **One plugin, not seven.** Obsidian has no mechanism for a plugin to depend on another plugin, so seven separate plugins would mean seven copies of the indexer, the parser and the linter — and seven places for them to drift apart. Modules are toggles instead.
  - **It adopts your ADR practice rather than replacing it.** Where a specification and a practice already in use disagree about a format, the practice wins — down to zero-padded four-digit numbers and the exact capitalisation of `Type: ADR`, because YAML keys are case-sensitive and a plugin reading only `type` would index every existing ADR as untyped.
  - **Workflow Automation ships off and is forced off on load** whatever `data.json` says. It is the only module that writes to notes without being asked.

### Security

- **The secrets detector specified in §10 is deliberately not implemented, not stubbed, and not planned.** A detector treats a credential in a note as something to find *after* it has been written — by which time the secret is in the vault, in the editor's undo history, and quite possibly in a commit. Keeping values out of Markdown in the first place is the design that competes with it, and building the detector now would establish the habit the other design exists to remove.
  - Concretely: nothing here reads a note looking for a credential, and **nothing here transmits note content anywhere** — there is no network code in the bundle at all, and a smoke test asserts it against the shipped bundle.
  - **If a credential does end up in a note, this plugin will not tell you.** That is a real gap and it is stated rather than papered over.

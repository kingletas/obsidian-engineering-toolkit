# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting on this repository (*Security* → *Report a vulnerability*), or email **code@kingletas.com**.

Include what you did, what happened, and what you expected. A proof of concept is welcome but not required — a clear description of the flaw is more useful than a working exploit.

This is a personal project maintained by one person, so please expect a first response in days rather than hours. You will get an acknowledgement, an assessment, and credit in the changelog unless you would rather not be named.

## Supported versions

The latest release on `main` is the supported version. There are no long-term support branches; fixes ship forward.

## What it touches

This plugin reads engineering documentation out of your vault and writes records back into it. It is worth knowing what it does and does not reach before you audit it.

| Surface | What it means |
|---|---|
| **Your notes** | Every note in the indexed scope is parsed — frontmatter, headings, links, tasks. Empty scope means the whole vault |
| **Note writes** | The create commands write new records. The linter's autofixes and the automation module edit existing notes |
| **Workflow automation** | WHEN / IF / DO rules that fire on vault events and can write to notes without a further prompt |
| **Generated snapshots** | The reliability snapshot writes a dated note into your findings folder |
| **The network** | Nothing. There is no network code in the bundle at all, and a smoke test asserts it |

Four properties exist deliberately and should not be quietly removed:

- **The bundle contains no network call.** Nothing here transmits note content anywhere — no telemetry, no sync, no model. `tests/smoke.cjs` asserts this against the shipped bundle rather than against the sources, so a dependency that introduced one would fail the build.
- **The bundle contains no vault deletion call at all.** Not a guarded one, not a confirmed one — none. A documentation tool has no business deleting notes, and the absence is a testable property rather than a promise.
- **Workflow Automation ships off, and is forced off on load whatever `data.json` says.** It is the only module that writes to notes without being asked, and a rule that fires on a vault event is hard to take back. Enabling it is a deliberate act each session.
- **There is no secrets detector, deliberately.** A detector treats a credential in a note as something to find *after* it has been written — by which time it is in the vault, in the editor's undo history, and possibly in a commit. Keeping values out of Markdown in the first place is the design that actually works. **If a credential ends up in a note, this plugin will not tell you.** That is a real gap, stated rather than papered over.

## In scope

- A write that reaches a note outside the configured folders, or outside the vault
- An automation rule that fires without the module being explicitly enabled, or that survives the forced-off-on-load behaviour
- A linter autofix that corrupts a note rather than correcting it
- Any network call reaching the bundle, by any path including a dependency
- Frontmatter injection — a property value that escapes YAML quoting and changes the meaning of the document

## Out of scope

- Vulnerabilities in Obsidian itself, or in its plugin model. Report those to Obsidian
- Findings that require an attacker who already has your filesystem or write access to your vault — at that point the plugin is the least of it
- The plugin declining to do something you enabled deliberately
- The absence of the secrets detector. It is documented above and is a design decision, not an oversight

## If you are running it

- **Scope it before you use it.** `Indexed folders` is empty on install, which means the whole vault. That is a noise problem before it is a safety one, but the autofixes act on what is in scope.
- **Leave Workflow Automation off unless you have read the rules.** A rule is a small program that runs when your vault changes.
- **Version-control your vault, or back it up, before running an autofix pass.** The fixes are safe by design and the design is not a guarantee.

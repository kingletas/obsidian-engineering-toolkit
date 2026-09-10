# Contributing to Engineering Toolkit

Thanks for taking an interest. This is MIT-licensed and reuse is the point — fork it, strip it for parts, or send a patch back.

This file covers the mechanics. [`README.md`](README.md) explains what the plugin does, [`docs/architecture.md`](docs/architecture.md) explains how the pieces fit together, and [`SECURITY.md`](SECURITY.md) covers vulnerability reports — **please do not open a public issue for a security problem.**

## Getting set up

```bash
git clone https://github.com/kingletas/obsidian-engineering-toolkit && cd obsidian-engineering-toolkit
npm ci
npm test
```

`npm ci` rather than `npm install`: it installs exactly what the lockfile says and fails when the lockfile and `package.json` disagree.

**Develop against a throwaway vault, never your real one.** One module writes to notes, and a rule that fires on a vault event is hard to take back.

```bash
npm run dev      # watch build
npm run build    # tsc -noEmit, then a production bundle
npm test         # build the test bundles, type-check, bundle, run the suite
```

Then install the `pre-commit` hooks, so the credential scanner runs before anything is committed:

```bash
pre-commit install
```

You get **both** hook types, `pre-commit` and `pre-push`. The suite builds a bundle, so it runs on push rather than on every commit.

## The suite tests the bundle, not the sources

`npm test` bundles with esbuild first and the tests `require()` the bundle. That is deliberate: **a test that imports the TypeScript sources proves nothing about what esbuild emits into `main.js`,** which is the only file Obsidian ever loads.

Everything except `main.ts`, `settings.ts`, the automation runner and the UI files is **pure** — a function of an index and some options — so the suite drives the real code with hand-written notes and no app.

`tests/fixtures.cjs` parses those notes through the **real** parser and assembles them through the **real** backlink builder. A fixture that hand-constructed a record would be testing the rules against a shape the parser might never produce.

Two smoke assertions are load-bearing and should not be deleted for being obvious: **the shipped bundle contains no network call**, and **no vault deletion call at all**. This plugin reads your engineering documentation; both properties are promises in `SECURITY.md` and this is what keeps them true.

## Rules that are not obvious from the code

**Never name a method after a member of the Obsidian class you extend.** A `View` subclass that declares `open()` replaces the internal method Obsidian calls to *attach* the view, so `onOpen()` never runs and the surface renders nothing while every test passes.

`View.open` is not in the public typings, so `tsc` cannot catch it — `scope` was caught only because `scope` *is* declared. This has happened twice across these plugins, which is why the `reserved` test exists: it walks the class prototype against the parent's member list. **Port it the day a plugin grows its first view.**

**A working settings tab proves nothing about a view.** It is registered separately, so it keeps working through every failure mode above the renderer. Both times the collision above happened, the working settings tab is what sent the investigation into `render()` — the one place the bug was not.

**A blank surface must name itself.** Draw render failures into the surface with a *Try again* button, never `return` silently when there is nowhere to put a view, and log the object a handler was handed rather than interpolating it into a sentence. A blank panel otherwise reads as *you have no data*.

**No default belongs to one vault.** A folder name, an owner, a tag, a path — anything shipped as a default is shipped to every install. A folder that exists in one vault silently scopes every other install to a path that does not exist, which presents as *the index found nothing* rather than as a setting nobody set. Ship empty and say so in the settings tab.

**Nothing machine-specific goes in a test fixture.** A path that happens to exist on your laptop is a test that passes on your laptop.

## Pull requests

- **One concern per pull request.** A bug fix and a refactor in one diff is two reviews wearing a trenchcoat.
- **Say what breaks.** If behaviour changes, name it in the description and add a `CHANGELOG.md` entry under `Unreleased`.
- **New behaviour comes with tests.** The bar is that a reviewer can see the new path exercised, not that a number goes up.
- **Bump `manifest.json`, `package.json` and `versions.json` together.** `make check` fails when they disagree, because only the manifest is authoritative for Obsidian and only `package.json` is authoritative for npm.
- **Explain the why in comments, not the what.** The surrounding code does this — match it.

## Releasing

1. Bump the version in `manifest.json`, `package.json` and `versions.json`, and move the `Unreleased` notes in `CHANGELOG.md` under a heading for the new version, such as `## [0.3.0] — 2026-10-01`.
2. Run `make check`. It fails if the three files disagree.
3. Tag the commit with the bare version and push the tag: `git tag 0.3.0 && git push origin 0.3.0`.

Don't put a `v` in front of the tag. Obsidian's installer looks for a release whose tag equals the version in `manifest.json`, and the release workflow refuses a tag that doesn't match. The workflow builds `main.js`, then attaches it to the release with `manifest.json` and `styles.css`, and uses the version's `CHANGELOG.md` section as the release notes.

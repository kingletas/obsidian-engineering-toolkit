# From nothing to a working Engineering Toolkit

This guide takes you from a machine with none of this project on it to the plugin running in a test vault, with your first architecture decision record written. It takes about ten minutes.

Every command below was run while this guide was written, and the output shown is what it printed. The steps that happen inside Obsidian's own window weren't run, and each one says so.

## Contents

- [What this is](#what-this-is)
- [What you need](#what-you-need)
- [Step 1: get the source](#step-1-get-the-source)
- [Step 2: install the build tools](#step-2-install-the-build-tools)
- [Step 3: build and check it](#step-3-build-and-check-it)
- [Step 4: make a test vault](#step-4-make-a-test-vault)
- [Step 5: install it into the test vault](#step-5-install-it-into-the-test-vault)
- [Step 6: turn it on in Obsidian](#step-6-turn-it-on-in-obsidian)
- [Step 7: write your first record](#step-7-write-your-first-record)
- [Where to go next](#where-to-go-next)

## What this is

Engineering Toolkit is an Obsidian plugin for engineering notes. It helps with architecture decision records (ADRs, short notes that record why a technical choice was made), infrastructure notes, incidents, a decision log, a documentation linter and small automations.

Your notes stay plain Markdown. The plugin reads them, checks them, and writes a new record only when you ask it to.

## What you need

- **Git**, to fetch the source.
- **Node.js 20 or newer, with npm.** This guide was run on Node 20.20.2 and npm 10.8.2.
- **Make.** It's already installed on most Linux and macOS machines. This guide wasn't tried on Windows.
- **Obsidian 1.5.0 or newer.**

Check your Node and npm versions first:

```bash
node --version
npm --version
```

```text
v20.20.2
10.8.2
```

If `node` isn't found, install it from [nodejs.org](https://nodejs.org) and open a new terminal.

## Step 1: get the source

```bash
git clone https://github.com/kingletas/obsidian-engineering-toolkit
cd obsidian-engineering-toolkit
```

This clone from GitHub is not verified: the guide was written before the repository was published, so it was run against a local copy of the same code. That copy printed:

```text
Cloning into 'obsidian-engineering-toolkit'...
done.
```

## Step 2: install the build tools

```bash
npm ci
```

```text
added 17 packages, and audited 18 packages in 2s

1 package is looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

`npm ci` installs exactly the versions listed in `package-lock.json`. These are build tools only: the plugin itself has no runtime dependencies.

## Step 3: build and check it

```bash
make check
```

This type-checks the code, builds `main.js`, runs the test suite against that built file, and checks the version numbers agree. It prints one line per test. The end of the output looks like this:

```text
smoke
  ok  the bundle loads and extends Plugin
  ok  12 commands registered, one per MVP capability in §14
  ok  note-scoped commands hide themselves when there is no note; the snapshot command is gated on its module instead
  ok  the dashboard view, the settings tab and the ribbon icon are registered
  ok  the vault events that drive incremental indexing are registered, and startup waits for `resolved`
  ok  settings fall back to defaults, unscoped and unsigned until you set them
  ok  a stored automation is forced off on load, whatever the file says
  ok  the indexer reports the scope it is actually using
  ok  an empty vault indexes to nothing without throwing
  ok  the shipped bundle contains no network call — nothing is read from a running system
  ok  the shipped bundle contains no vault deletion call at all
  ok  unload is clean
smoke: 12 passed

engineering-toolkit 0.2.0: manifest.json, package.json and versions.json agree

  the bundle builds, the suite passes and the versions agree
```

If any line starts with something other than `ok`, stop here. The build or a test failed, and the lines above it say which.

## Step 4: make a test vault

Try the plugin in a throwaway vault before your real one. One of its modules can write to notes, and it's easier to learn what it does where nothing matters.

A vault is just a folder with an `.obsidian` folder inside it. This makes one next to the source folder:

```bash
mkdir -p ../toolkit-test-vault/.obsidian
```

It prints nothing when it works.

## Step 5: install it into the test vault

```bash
make install VAULT=../toolkit-test-vault
```

```text
> obsidian-engineering-toolkit@0.2.0 build
> tsc -noEmit -skipLibCheck && node esbuild.config.mjs production

copied main.js -> ../toolkit-test-vault/.obsidian/plugins/engineering-toolkit/
copied manifest.json -> ../toolkit-test-vault/.obsidian/plugins/engineering-toolkit/
copied styles.css -> ../toolkit-test-vault/.obsidian/plugins/engineering-toolkit/

Now enable it in Obsidian: Settings -> Community plugins -> Engineering Toolkit.
```

Those three files are the whole plugin. Obsidian loads them from `.obsidian/plugins/engineering-toolkit/` inside the vault.

If you leave out `VAULT=`, nothing is installed and you get a reminder instead:

```text
  VAULT is not set. Name the vault to install into, for example:
    make install VAULT="$HOME/obsidian-test-vault"
make: *** [Makefile:50: need-vault] Error 2
```

## Step 6: turn it on in Obsidian

These steps happen in Obsidian's window, and they weren't run while writing this guide. `make check` in step 3 does confirm that the plugin loads and registers its commands, its dashboard and its settings tab.

1. Open Obsidian. Choose **Open folder as vault** and pick the `toolkit-test-vault` folder.
2. Go to **Settings → Community plugins**. If Obsidian asks, turn on community plugins.
3. Find **Engineering Toolkit** in the list of installed plugins and switch it on.

Turn it on through that screen, not by editing `.obsidian/community-plugins.json`. Obsidian rewrites that file from memory when it quits, so a hand edit can vanish.

## Step 7: write your first record

These steps happen in Obsidian's window too, and they weren't run while writing this guide.

1. Go to **Settings → Engineering Toolkit**. Set **Owner** to your name, such as `Alex Example`. It's written into every record you create, and it starts blank.
2. Set **Indexed folders** to `Engineering`. That's the folder the plugin writes new records into by default. Left empty, it checks every note in the vault.
3. Open the command palette (Ctrl+P, or Cmd+P on a Mac) and run **Engineering Toolkit: New architecture decision record**. Give it a title, such as `Use one database per service`.
4. A new note appears in `Engineering/Decision Records`, named like `ADR-0001 — Use one database per service`, with the ADR template already filled in.
5. Run **Engineering Toolkit: Scan indexed folders**. A notice tells you how many notes it read and how many errors, warnings and info findings it has.
6. Run **Engineering Toolkit: Open dashboard** to see your ADRs and the findings in one place.

To check you got it right: the scan notice names the `Engineering` folder as its scope, and the dashboard lists your new ADR.

## Where to go next

- [README](../README.md) explains each module, every linter check, and what the plugin will never do to your vault.
- [CONTRIBUTING.md](../CONTRIBUTING.md) covers development and releases.
- [SECURITY.md](../SECURITY.md) says what the plugin reads and writes, and how to report a problem.

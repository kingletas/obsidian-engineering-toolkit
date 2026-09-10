// Builds each module into a CJS bundle the tests can require(). The plugin ships
// as ESM-flavoured TypeScript and Node will not require() that, so this is one
// esbuild call per entry point, output into tests/build/, which is gitignored.

import { build } from "esbuild";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "build");
mkdirSync(out, { recursive: true });

const ENTRIES = [
	"core/parser.ts",
	"core/scope.ts",
	"core/ids.ts",
	"core/notes.ts",
	"core/indexer.ts",
	"records/record-types.ts",
	"adr/adr-engine.ts",
	"incidents/incident-engine.ts",
	"decisions/decision-engine.ts",
	"infra/infra-engine.ts",
	"lint/linter.ts",
	"lint/rules.ts",
	"automation/engine.ts",
	"dashboard/dashboard-engine.ts",
	"templates.ts",
	"reliability/slo.ts",
	"reliability/dora.ts",
	"reliability/report.ts",
];

// `core/indexer.ts` imports `obsidian` for its types and for `parseYaml`. Only
// its pure export (`assemble`) is under test, so the import is stubbed away at
// bundle time rather than at require() time.
const stubObsidian = {
	name: "stub-obsidian",
	setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
		b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: `
				export class TFile {}
				export class TFolder {}
				export class Notice {}
				export class Modal { constructor(app) { this.app = app; } }
				export class Setting { setName() { return this; } setDesc() { return this; } addText() { return this; } addDropdown() { return this; } addButton() { return this; } addToggle() { return this; } addExtraButton() { return this; } setHeading() { return this; } }
				export const normalizePath = (p) => p;
				export const parseYaml = () => null;
			`,
			loader: "js",
		}));
	},
};

for (const entry of ENTRIES) {
	await build({
		entryPoints: [join(root, "src", entry)],
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "es2018",
		outfile: join(out, `${entry.replace(/[/]/g, "-").replace(/\.ts$/, "")}.cjs`),
		logLevel: "error",
		plugins: [stubObsidian],
	});
}

console.log(`build\n  ok  ${ENTRIES.length} modules bundled\n`);

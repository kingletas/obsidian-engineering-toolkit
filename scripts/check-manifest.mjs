// Checks that manifest.json, package.json and versions.json agree, and that a release tag, when given, matches them.
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");
const tag = process.argv[2];

const problems = [];
for (const key of ["id", "name", "version", "minAppVersion", "description"]) {
	if (!manifest[key]) problems.push(`manifest.json is missing ${key}`);
}
if (manifest.version !== pkg.version) {
	problems.push(`manifest.json says ${manifest.version} but package.json says ${pkg.version}`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
	problems.push(`versions.json needs "${manifest.version}": "${manifest.minAppVersion}"`);
}
if (tag !== undefined && tag !== manifest.version) {
	problems.push(`the tag is ${tag} but manifest.json says ${manifest.version}; Obsidian needs them equal, with no leading v`);
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`check-manifest: ${problem}`);
	process.exit(1);
}

console.log(`${manifest.id} ${manifest.version}: manifest.json, package.json and versions.json agree`);

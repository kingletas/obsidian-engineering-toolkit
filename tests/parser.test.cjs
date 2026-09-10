const { assert, suite, test, done, load } = require("./harness.cjs");
const { idFromName, linkText, stripFrontmatter, countDoneTasks } = load("core-parser");
const { buildRecords, NOTES } = require("./fixtures.cjs");

suite("parser");

const records = buildRecords();
const get = (path) => records.get(path);

test("`Type: ADR` is indexed as an ADR, capital and all", () => {
	// YAML keys are case-sensitive, so reading only `type` would index a
	// `Type: ADR` note as untyped.
	const adr = get("Engineering/Decision Records/ADR-0001 — Use MariaDB.md");
	assert.strictEqual(adr.type, "adr");
	assert.strictEqual(adr.rawType, "ADR");
	assert.strictEqual(adr.kind, "adr");
});

test("an id in the aliases list is found when frontmatter declares none", () => {
	assert.strictEqual(get("Engineering/Decision Records/ADR-0001 — Use MariaDB.md").id, "ADR-0001");
});

test("an id is inferred from the filename only at the start of the name", () => {
	assert.strictEqual(idFromName("ADR-0002 — Patch Core"), "ADR-0002");
	assert.strictEqual(idFromName("INC-2026-001 — Checkout Down"), "INC-2026-001");
	// A note that merely mentions an ADR must not acquire its id and collide.
	assert.strictEqual(idFromName("Notes about ADR-0002"), null);
	assert.strictEqual(idFromName("ADRs in general"), null);
});

test("an escaped pipe inside a table wikilink still resolves", () => {
	// `[[Note\|alias]]` is how a wikilink is written inside a Markdown table.
	// Leaving the backslash on the path makes every linked table row read as a
	// broken link.
	assert.strictEqual(linkText("Note\\|alias"), "Note");
	assert.strictEqual(linkText("Note#Heading"), "Note");
	assert.strictEqual(linkText("Note^block"), "Note");
});

test("frontmatter is stripped for the body count and nothing else", () => {
	assert.strictEqual(stripFrontmatter("---\na: 1\n---\nbody\n"), "body\n");
	assert.strictEqual(stripFrontmatter("no frontmatter"), "no frontmatter");
});

test("completed tasks are counted and open ones are not", () => {
	assert.strictEqual(countDoneTasks("- [x] a\n- [ ] b\n  * [X] c\n"), 2);
	assert.strictEqual(countDoneTasks("- [ ] a\n"), 0);
});

test("a note with no type is still indexed", () => {
	const plain = buildRecords({ "a/b.md": { props: {}, body: "# B\n\n[[Nowhere]]\n" } }).get("a/b.md");
	assert.strictEqual(plain.type, null);
	assert.strictEqual(plain.kind, null);
	assert.strictEqual(plain.links.length, 1);
	assert.strictEqual(plain.links[0].target, null);
});

test("a release note is identified by where it lives, because it carries no type", () => {
	const release = records.get("Engineering/Releases/Cities/3. Petra.md");
	assert.strictEqual(release.type, null, "release notes declare no `type` and none is invented for them");
	assert.strictEqual(release.kind, "release");
	// The Release Dashboard and the per-cycle index notes live in the same tree
	// and are not releases; `Release Time` is what separates them.
	const notARelease = buildRecords({ "Engineering/Releases/Dashboard.md": { props: { aliases: ["Releases"] }, body: "# Release Dashboard\n" } }).get("Engineering/Releases/Dashboard.md");
	assert.strictEqual(notARelease.kind, null);
});

test("action items are parsed with the owner and date that make them actionable", () => {
	const parsed = buildRecords({
		"a/A.md": { props: {}, body: "# A\n\n- [ ] Fix it — [[Dana Reyes]] 📅 2026-09-01\n- [ ] Vague\n- [x] Done — @dana 2026-08-01\n" },
	}).get("a/A.md");
	assert.strictEqual(parsed.tasks.length, 3);
	assert.deepStrictEqual([parsed.tasks[0].owner, parsed.tasks[0].due], ["Dana Reyes", "2026-09-01"]);
	assert.deepStrictEqual([parsed.tasks[1].owner, parsed.tasks[1].due], [null, null]);
	assert.deepStrictEqual([parsed.tasks[2].owner, parsed.tasks[2].due], ["@dana", "2026-08-01"]);
	assert.strictEqual(parsed.tasksDone, 1);
});

test("the fixture vault parses to every note it declares", () => {
	assert.strictEqual(records.size, Object.keys(NOTES).length);
});

done();

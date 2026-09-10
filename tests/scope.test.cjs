const { assert, suite, test, done, load } = require("./harness.cjs");
const { inScope, normaliseFolder, describeScope } = load("core-scope");

suite("scope");

test("an empty allowlist means the whole vault", () => {
	assert.strictEqual(inScope("anything/at/all.md", { include: [], exclude: [] }), true);
});

test("a folder prefix does not match a sibling with a longer name", () => {
	const scope = { include: ["Engineering"], exclude: [] };
	assert.strictEqual(inScope("Engineering/Architecture/a.md", scope), true);
	assert.strictEqual(inScope("Engineering Notes/a.md", scope), false);
});

test("exclude is applied after include, so a tree can be carved out", () => {
	const scope = { include: ["Engineering"], exclude: ["Engineering/Planning"] };
	assert.strictEqual(inScope("Engineering/Support/a.md", scope), true);
	assert.strictEqual(inScope("Engineering/Planning/Sprints/a.md", scope), false);
});

test("a leading or trailing slash in a settings field is absorbed", () => {
	assert.strictEqual(normaliseFolder("/Engineering/"), "Engineering");
	assert.strictEqual(normaliseFolder("  "), "");
	assert.strictEqual(inScope("Engineering/a.md", { include: ["/Engineering/"], exclude: [] }), true);
});

test("the scope description always names a denominator", () => {
	assert.strictEqual(describeScope({ include: [], exclude: [] }), "the whole vault");
	assert.strictEqual(describeScope({ include: ["Engineering"], exclude: [] }), "Engineering");
	assert.strictEqual(describeScope({ include: ["a", "b"], exclude: ["c"] }), "2 folders, less 1 excluded");
});

done();

const { assert, suite, test, done, load } = require("./harness.cjs");
const { nextAdrId, nextIncidentId, formatAdrId, recordFilename, sanitiseTitle, highest } = load("core-ids");
const { index } = require("./fixtures.cjs");

suite("ids");

test("the next ADR id follows the highest one in the vault", () => {
	assert.strictEqual(nextAdrId(index()), "ADR-0003");
});

test("numbers are padded to four digits, matching the ADRs already written", () => {
	assert.strictEqual(formatAdrId(3), "ADR-0003");
	assert.strictEqual(formatAdrId(1234), "ADR-1234");
});

test("a deleted record leaves a hole rather than having its number reused", () => {
	// `highest` is what guarantees this: taking the first gap would reissue a
	// number that a commit message may still refer to.
	assert.strictEqual(highest(["ADR-0001", "ADR-0004"], /^ADR-(\d+)$/i), 4);
});

test("incident numbering restarts each year", () => {
	const idx = index();
	assert.strictEqual(nextIncidentId(idx, 2026), "INC-2026-002");
	assert.strictEqual(nextIncidentId(idx, 2027), "INC-2027-001");
});

test("a filename uses the em dash the existing ADR filenames use", () => {
	assert.strictEqual(recordFilename("ADR-0003", "Use Redis"), "ADR-0003 — Use Redis");
});

test("characters Obsidian refuses in a filename are replaced, not stripped", () => {
	// Stripping would silently turn two different titles into one filename.
	assert.strictEqual(sanitiseTitle("Cache: yes/no?"), "Cache- yes-no");
	assert.strictEqual(sanitiseTitle("  spaced   out  "), "spaced out");
});

done();

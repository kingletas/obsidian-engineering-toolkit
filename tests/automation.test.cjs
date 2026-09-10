const { assert, suite, test, done, load } = require("./harness.cjs");
const { plan, matches, ruleApplies, substitute, LoopGuard } = load("automation-engine");
const { buildRecords } = require("./fixtures.cjs");

suite("automation");

const records = buildRecords();
const adr = records.get("Engineering/Decision Records/ADR-0001 — Use MariaDB.md");
const incident = records.get("Engineering/Incidents/INC-2026-001 — Checkout Down.md");
const now = new Date(2026, 7, 24, 20, 5);

const rule = (over = {}) => ({
	id: "r1",
	name: "Rule",
	enabled: true,
	event: "property-changed",
	conditions: [],
	actions: [{ kind: "set-property", target: "reviewed", value: "{{date}}" }],
	...over,
});

test("a disabled rule never plans anything", () => {
	// The single most important assertion in this file. A rule that fires while
	// switched off is the failure the whole activation model exists to prevent.
	assert.strictEqual(plan([rule({ enabled: false })], { kind: "property-changed", note: adr }, now).length, 0);
});

test("every condition must hold, not any", () => {
	const both = rule({ conditions: [{ field: "type", op: "equals", value: "adr" }, { field: "status", op: "equals", value: "rejected" }] });
	assert.strictEqual(ruleApplies(both, { kind: "property-changed", note: adr }), false);
});

test("a tag `contains` matches a whole tag, not a substring of one", () => {
	// Otherwise an `archive` rule fires on every note tagged `archived`.
	const note = { ...adr, tags: ["archived"] };
	assert.strictEqual(matches({ field: "tag", op: "contains", value: "archive" }, note), false);
	assert.strictEqual(matches({ field: "tag", op: "contains", value: "archived" }, note), true);
});

test("an invalid regex matches nothing rather than everything", () => {
	assert.strictEqual(matches({ field: "path", op: "matches", value: "([" }, adr), false);
});

test("`prop:` reaches any frontmatter key", () => {
	assert.strictEqual(matches({ field: "prop:severity", op: "equals", value: "SEV-2" }, incident), true);
	assert.strictEqual(matches({ field: "prop:nothing", op: "exists", value: "" }, incident), false);
});

test("a watched property narrows a property-changed rule", () => {
	const watched = rule({ watchProperty: "status" });
	assert.strictEqual(ruleApplies(watched, { kind: "property-changed", note: adr, property: "status" }), true);
	assert.strictEqual(ruleApplies(watched, { kind: "property-changed", note: adr, property: "tags" }), false);
});

test("tokens are substituted and a typo is left visible rather than blanked", () => {
	assert.strictEqual(substitute("{{date}} {{time}}", adr, now), "2026-08-24 20:05");
	assert.strictEqual(substitute("{{titel}}", adr, now), "{{titel}}");
});

test("the plan carries the note it was made for, and a description of each action", () => {
	const planned = plan([rule()], { kind: "property-changed", note: adr }, now);
	assert.strictEqual(planned.length, 1);
	assert.strictEqual(planned[0].sourcePath, adr.path);
	assert.strictEqual(planned[0].value, "2026-08-24");
	assert.match(planned[0].describe, /^set `reviewed: 2026-08-24` on Engineering/);
});

test("the loop guard stops a rule after its per-note limit", () => {
	const guard = new LoopGuard(2, 1000);
	const r = rule();
	assert.strictEqual(guard.blocked(r, "a.md", 0), null);
	guard.record(r, "a.md");
	assert.strictEqual(guard.blocked(r, "a.md", 0), null);
	guard.record(r, "a.md");
	assert.match(guard.blocked(r, "a.md", 0), /already run 2 times/);
	// Another note is unaffected -- the limit is per rule per note.
	assert.strictEqual(guard.blocked(r, "b.md", 0), null);
});

test("a note the runner just wrote is quiet for the cooldown", () => {
	const guard = new LoopGuard(99, 1000);
	guard.touched("a.md", 5000);
	assert.match(guard.blocked(rule(), "a.md", 5500), /written by an automation/);
	assert.strictEqual(guard.blocked(rule(), "a.md", 6100), null);
});

test("a deletion cannot be expressed, so it cannot be performed", () => {
	// The vocabulary has no delete action, so an unknown kind is only described
	// and reaches no branch in the runner.
	const planned = plan([rule({ actions: [{ kind: "delete-note", target: "x" }] })], { kind: "property-changed", note: adr }, now);
	assert.strictEqual(planned[0].describe, `delete-note on ${adr.path}`);
});

done();

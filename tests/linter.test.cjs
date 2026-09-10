const { assert, suite, test, done, load } = require("./harness.cjs");
const { lint, RULES, fixable, groupByPath } = load("lint-linter");
const { index, NOTES } = require("./fixtures.cjs");

const forRule = (result, rule) => result.issues.filter((i) => i.rule === rule);
const run = (notes, options) => lint(index(notes), [], options);

suite("linter");

test("the fixture vault is clean apart from the orphans it really has", () => {
	const result = run();
	const rules = [...new Set(result.issues.map((i) => i.rule))].sort();
	assert.deepStrictEqual(rules, ["orphan-notes"], JSON.stringify(result.issues, null, 2));
});

test("every rule reports a count, including the ones that found nothing", () => {
	const result = run();
	for (const rule of RULES) assert.ok(rule.id in result.byRule, `${rule.id} reported no count`);
});

test("a duplicate id is an error on both notes and names the other", () => {
	const notes = { ...NOTES, "x/ADR-0001 — Copy.md": { props: { Type: "ADR", status: "accepted", date: "2026-08-01", aliases: ["ADR-0001"] }, body: "# ADR-0001 — Copy\n" } };
	const found = forRule(run(notes), "duplicate-ids");
	assert.strictEqual(found.length, 2);
	assert.ok(found.every((i) => i.severity === "error"));
	assert.match(found[0].hint, /ADR-0001/);
});

test("an invalid status is an error, and a near miss offers a fix", () => {
	const found = forRule(run({ "a/ADR-0009 — X.md": { props: { Type: "ADR", status: "accept", date: "2026-08-01" }, body: "# ADR-0009 — X\n" } }), "invalid-status");
	assert.strictEqual(found.length, 1);
	assert.strictEqual(found[0].fix.value, "accepted");
	assert.strictEqual(found[0].fix.destructive, false);

	const nonsense = forRule(run({ "a/ADR-0009 — X.md": { props: { Type: "ADR", status: "banana", date: "2026-08-01" }, body: "# X\n" } }), "invalid-status");
	assert.strictEqual(nonsense[0].fix, null, "a status the plugin cannot infer must not be guessed");
});

test("a severity written any of the common ways is fixable to the canonical one", () => {
	for (const written of ["sev2", "SEV 2", "2"]) {
		const found = forRule(run({ "a/INC-2026-009 — X.md": { props: { Type: "incident", id: "INC-2026-009", severity: written, status: "open", started: "2026-08-01T00:00" }, body: "# X\n" } }), "invalid-severity");
		assert.strictEqual(found[0].fix.value, "SEV-2", `${written} did not normalise`);
	}
});

test("`status` on a note the toolkit does not own is never reported", () => {
	// TaskNotes also writes `status`, so a status rule over every note would
	// report every task.
	const result = run({ "a/Task.md": { props: { status: "in-progress" }, body: "# Task\n" } });
	assert.strictEqual(forRule(result, "invalid-status").length, 0);
});

test("an incident that is open but carries a resolved time is caught and fixable", () => {
	const found = forRule(
		run({ "a/INC-2026-009 — X.md": { props: { Type: "incident", id: "INC-2026-009", severity: "SEV-2", status: "open", started: "2026-08-01T00:00", resolved: "2026-08-01T01:00" }, body: "# X\n" } }),
		"stale-open-incident"
	);
	assert.strictEqual(found.length, 1);
	assert.strictEqual(found[0].fix.value, "resolved");
});

test("a broken link is quoted back as the user typed it", () => {
	const found = forRule(run({ "a/A.md": { props: { Type: "adr", status: "proposed", date: "2026-01-01" }, body: "# A\n\n[[Nowhere At All]]\n" } }), "broken-links");
	assert.strictEqual(found.length, 1);
	assert.match(found[0].message, /Nowhere At All/);
});

test("Dataview's `[[]]` self-reference is not reported as a broken link", () => {
	const found = forRule(run({ "a/A.md": { props: { Type: "adr", status: "proposed", date: "2026-01-01" }, body: "# A\n\nFROM [[]]\n" } }), "broken-links");
	assert.strictEqual(found.length, 0);
});

test("the majority type spelling wins, so a consistent vault reports nothing", () => {
	// Every ADR here says `Type: ADR`. That is not wrong, it is the convention.
	assert.strictEqual(forRule(run(), "inconsistent-type-case").length, 0);

	const mixed = { ...NOTES, "a/ADR-0003 — Odd.md": { props: { type: "adr", status: "proposed", date: "2026-01-01", aliases: ["ADR-0003"] }, body: "# ADR-0003 — Odd\n\n[[Magento]]\n" } };
	const found = forRule(run(mixed), "inconsistent-type-case");
	assert.strictEqual(found.length, 1);
	assert.match(found[0].message, /2 other adr notes write `ADR`/);
});

test("missing sections are info, not a warning", () => {
	const found = forRule(run({ "a/ADR-0009 — X.md": { props: { Type: "ADR", status: "proposed", date: "2026-01-01" }, body: "# X\n\nnothing else\n" } }), "missing-sections");
	assert.strictEqual(found[0].severity, "info", "a record in progress is allowed to be incomplete");
});

test("an orphan-exempt folder silences the orphan rule for it", () => {
	const all = forRule(run(), "orphan-notes");
	assert.ok(all.length > 0);
	const exempt = forRule(run(undefined, { orphanExemptFolders: ["Engineering"] }), "orphan-notes");
	assert.strictEqual(exempt.length, 0);
});

test("a rule can be switched off and still reports a count of zero", () => {
	const result = run(undefined, { enabled: { "orphan-notes": false } });
	assert.strictEqual(result.byRule["orphan-notes"], 0);
	assert.strictEqual(forRule(result, "orphan-notes").length, 0);
});

test("a severity override changes the finding, not the rule", () => {
	const result = run(undefined, { severity: { "orphan-notes": "info" } });
	assert.ok(forRule(result, "orphan-notes").every((i) => i.severity === "info"));
});

test("a rule that throws is reported rather than taking the others with it", () => {
	const exploding = [{ id: "boom", code: "ETX", title: "Boom", description: "", defaultSeverity: "error", run() { throw new Error("nope"); } }, ...RULES];
	const result = lint(index(), [], { rules: exploding });
	const failure = result.issues.find((i) => i.rule === "boom");
	assert.match(failure.message, /the `Boom` check failed: nope/);
	assert.ok(result.issues.some((i) => i.rule === "orphan-notes"), "the remaining rules still ran");
});

test("`only` filters the findings without changing what the rules saw", () => {
	// A duplicate id is only visible vault-wide, so the rules must run over
	// everything and the result be filtered afterwards.
	const notes = { ...NOTES, "x/ADR-0001 — Copy.md": { props: { Type: "ADR", status: "accepted", date: "2026-08-01", aliases: ["ADR-0001"] }, body: "# Copy\n" } };
	const scoped = run(notes, { only: "x/ADR-0001 — Copy.md" });
	assert.ok(scoped.issues.some((i) => i.rule === "duplicate-ids"));
	assert.ok(scoped.issues.every((i) => i.path === "x/ADR-0001 — Copy.md"));
});

test("destructive fixes are never part of a batch", () => {
	const issues = [
		{ path: "a", code: "X", rule: "r", severity: "error", message: "", fix: { label: "safe", property: "p", value: "v", destructive: false } },
		{ path: "b", code: "X", rule: "r", severity: "error", message: "", fix: { label: "risky", property: "p", value: "v", destructive: true } },
		{ path: "c", code: "X", rule: "r", severity: "error", message: "" },
	];
	const { safe, destructive } = fixable(issues);
	assert.strictEqual(safe.length, 1);
	assert.strictEqual(destructive.length, 1);
});

test("findings group by note, worst first", () => {
	const groups = groupByPath([
		{ path: "b", severity: "info", code: "1", rule: "r", message: "" },
		{ path: "a", severity: "error", code: "2", rule: "r", message: "" },
	]);
	assert.strictEqual(groups[0].path, "a");
});

done();

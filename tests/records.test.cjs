const { assert, suite, test, done, load } = require("./harness.cjs");
const { adrIndex, adrCounts } = load("adr-adr-engine");
const { incidents, incidentStats, minutesBetween } = load("incidents-incident-engine");
const { decisions } = load("decisions-decision-engine");
const { infraGraph, infraStats, renderTree } = load("infra-infra-engine");
const { index } = require("./fixtures.cjs");

suite("records");

const idx = index();

test("a `supersedes` on one ADR gives the other a `supersededBy`", () => {
	// Only one of the two properties is ever written -- you know what you are
	// replacing at the moment you replace it -- so the inverse has to be derived.
	const rows = adrIndex(idx);
	const first = rows.find((r) => r.id === "ADR-0001");
	const second = rows.find((r) => r.id === "ADR-0002");
	assert.ok(first.supersededBy.endsWith("ADR-0002 — Patch Core.md"));
	assert.deepStrictEqual(second.supersedes, [first.note.path]);
});

test("the ADR index counts every status, including the ones at zero", () => {
	const counts = adrCounts(adrIndex(idx));
	assert.strictEqual(counts.accepted, 2);
	assert.strictEqual(counts.proposed, 0);
	assert.ok("superseded" in counts, "a status with no records must still report a count");
});

test("incident duration is computed from the timestamps, never from file times", () => {
	const row = incidents(idx)[0];
	assert.strictEqual(row.durationMinutes, 90);
});

test("an unparseable or reversed pair is null, not zero", () => {
	// A zero-minute outage and an unknown one are different facts, and averaging
	// the second in as the first is how a time-to-recovery figure becomes a lie.
	assert.strictEqual(minutesBetween("2026-08-10T10:00", null), null);
	assert.strictEqual(minutesBetween("nonsense", "2026-08-10T10:00"), null);
	assert.strictEqual(minutesBetween("2026-08-10T11:00", "2026-08-10T10:00"), null);
});

test("a resolved incident with every postmortem section is not flagged", () => {
	const stats = incidentStats(incidents(idx));
	assert.strictEqual(stats.missingPostmortem.length, 0);
	assert.strictEqual(stats.open, 0);
	assert.strictEqual(stats.medianMinutes, 90);
});

test("a resolved incident missing Root Cause is flagged", () => {
	const thin = index({
		"i/INC-2026-002 — Thin.md": {
			props: { Type: "incident", id: "INC-2026-002", status: "resolved", severity: "SEV-3", started: "2026-08-11T09:00", resolved: "2026-08-11T09:20" },
			body: "# INC-2026-002 — Thin\n\n## Summary\n\nx\n",
		},
	});
	assert.strictEqual(incidentStats(incidents(thin)).missingPostmortem.length, 1);
});

test("the dependency tree renders, and an undocumented dependency is shown rather than dropped", () => {
	const graph = infraGraph(idx);
	const magento = [...graph.nodes.values()].find((n) => n.name === "Magento");
	assert.deepStrictEqual(magento.unresolved, []);
	const lines = renderTree(graph, magento);
	assert.strictEqual(lines[0], "Magento");
	assert.ok(lines.some((l) => l.includes("Aurora")), lines.join("\n"));

	const gap = infraGraph(index({ "i/App.md": { props: { Type: "service", name: "App", environment: "production", dependencies: ["[[Ghost]]"] }, body: "# App\n" } }));
	const app = [...gap.nodes.values()][0];
	assert.deepStrictEqual(app.unresolved, ["Ghost"]);
	assert.ok(renderTree(gap, app).some((l) => l.includes("(no note)")));
});

test("a dependency cycle is drawn as a cycle rather than hanging", () => {
	const cyclic = infraGraph(
		index({
			"i/A.md": { props: { Type: "service", name: "A", environment: "production", dependencies: ["[[B]]"] }, body: "# A\n" },
			"i/B.md": { props: { Type: "service", name: "B", environment: "production", dependencies: ["[[A]]"] }, body: "# B\n" },
		})
	);
	const a = [...cyclic.nodes.values()].find((n) => n.name === "A");
	const lines = renderTree(cyclic, a);
	assert.ok(lines.join("\n").includes("(cycle)"), lines.join("\n"));
});

test("infrastructure counts split by environment and count what has none", () => {
	const stats = infraStats(infraGraph(idx));
	assert.strictEqual(stats.total, 3);
	assert.strictEqual(stats.unplaced, 0);
	assert.strictEqual(stats.byEnvironment.production.service, 2);
	assert.strictEqual(stats.byEnvironment.production.database, 1);
	assert.deepStrictEqual(stats.byEnvironment.staging, {});
});

test("a decision is listed with its date and status", () => {
	const rows = decisions(idx);
	assert.strictEqual(rows.length, 1);
	assert.strictEqual(rows[0].title, "Use pnpm");
	assert.strictEqual(rows[0].date, "2026-08-12");
	assert.strictEqual(rows[0].promotedTo, null);
});

done();

const { assert, suite, test, done, load } = require("./harness.cjs");
const { parseSlo, readSlos, budgetMinutes, formatBudget, readTier, readDuration, readSla } = load("reliability-slo");
const { infraGraph, blastRadius, tierInversions } = load("infra-infra-engine");
const { releases, dora, verdict } = load("reliability-dora");
const { incidents, incidentStats } = load("incidents-incident-engine");
const { reliabilityReport } = load("reliability-report");
const { lint } = load("lint-linter");
const { index, NOTES } = require("./fixtures.cjs");

const NOW = Date.parse("2026-08-24T12:00:00");
const idx = index();
const forRule = (result, rule) => result.issues.filter((i) => i.rule === rule);
const run = (notes, options) => lint(index(notes), [], { now: NOW, restoreTestDays: 180, ...(options ?? {}) });

suite("reliability");

test("an objective needs a target and a window before it is a budget", () => {
	const good = parseSlo("availability 99.9% over 30d");
	assert.strictEqual(good.problem, null);
	assert.strictEqual(good.sli, "availability");
	assert.strictEqual(good.objective, 0.999);
	assert.strictEqual(good.windowDays, 30);

	assert.strictEqual(parseSlo("availability 99.9%").problem, "no-window");
	assert.strictEqual(parseSlo("availability over 30d").problem, "no-objective");
	assert.strictEqual(parseSlo("availability 140% over 30d").problem, "objective-out-of-range");
});

test("a latency threshold is not mistaken for the window", () => {
	// `500ms` appears before `30d` in the string and is a duration too.
	const slo = parseSlo("latency 99% under 500ms over 30d");
	assert.strictEqual(slo.threshold, "500ms");
	assert.strictEqual(slo.windowDays, 30);
	assert.strictEqual(slo.objective, 0.99);
});

test("a percentile is reported rather than accepted", () => {
	// "99% of requests under 500ms" composes with an error budget; "p99 is
	// 500ms" does not — there is no proportion in it to spend.
	assert.strictEqual(parseSlo("p99 500ms").problem, "percentile");
	assert.strictEqual(parseSlo("latency p95 < 300ms").problem, "percentile");
});

test("the error budget is derived, and 99.9% over 30 days is about 43 minutes", () => {
	assert.strictEqual(budgetMinutes(parseSlo("availability 99.9% over 30d")), 43.2);
	assert.strictEqual(formatBudget(43.2), "43.2m");
	assert.strictEqual(formatBudget(262.8), "4h 22.8m");
	// No window means no budget — a number computed from a missing window has
	// no meaning, and a meaningless number is worse than a blank.
	assert.strictEqual(budgetMinutes(parseSlo("availability 99.9%")), null);
	assert.strictEqual(formatBudget(null), "—");
});

test("the slo property is read in every shape a person writes it", () => {
	assert.strictEqual(readSlos("availability 99.9% over 30d").length, 1);
	assert.strictEqual(readSlos(["a 99% over 7d", "b 99% over 7d"]).length, 2);
	assert.strictEqual(readSlos({ availability: "99.9% over 30d" })[0].objective, 0.999);
	assert.deepStrictEqual(readSlos(undefined), []);
});

test("tier, SLA and durations read the forms actually written", () => {
	assert.strictEqual(readTier("Tier 1"), 1);
	assert.strictEqual(readTier(2), 2);
	assert.strictEqual(readTier("critical"), null, "a word that is not a number must not be guessed at");
	assert.strictEqual(readSla("99.5%"), 0.995);
	assert.strictEqual(readDuration("4h"), 240);
	// Zero is a real and expensive choice for an RPO, and is not absence.
	assert.strictEqual(readDuration("0"), 0);
	assert.strictEqual(readDuration(""), null);
});

test("blast radius is transitive and survives a cycle", () => {
	const graph = infraGraph(idx);
	const aurora = [...graph.nodes.values()].find((n) => n.name === "Aurora");
	// Magento depends on Aurora directly; Redis depends on Aurora and Magento
	// depends on Redis — so Aurora reaches both, once each.
	const affected = blastRadius(graph, aurora.note.path).map((n) => n.name).sort();
	assert.deepStrictEqual(affected, ["Magento", "Redis"]);

	const cyclic = infraGraph(
		index({
			"i/A.md": { props: { Type: "service", name: "A", environment: "production", dependencies: ["[[B]]"] }, body: "# A\n" },
			"i/B.md": { props: { Type: "service", name: "B", environment: "production", dependencies: ["[[A]]"] }, body: "# B\n" },
		})
	);
	const a = [...cyclic.nodes.values()].find((n) => n.name === "A");
	assert.strictEqual(blastRadius(cyclic, a.note.path).length, 1);
});

test("a tier-1 component resting on a tier-3 one is caught, and it is invisible on either note", () => {
	const notes = {
		...NOTES,
		"Engineering/Infrastructure/Redis.md": {
			props: { Type: "service", name: "Redis", environment: "production", tier: 3, dependencies: ["[[Aurora]]"], tags: ["infrastructure"] },
			body: "# Redis\n\n[[Aurora]]\n",
		},
	};
	const found = tierInversions(infraGraph(index(notes)));
	assert.strictEqual(found.length, 1);
	assert.strictEqual(found[0].node.name, "Magento");
	assert.strictEqual(found[0].dependency.name, "Redis");
	assert.strictEqual(forRule(run(notes), "tier-inversion").length, 1);
});

test("a tier-1 component with no objective or runbook is reported; an ungraded one is not", () => {
	const notes = {
		...NOTES,
		"i/Bare.md": { props: { Type: "service", name: "Bare", environment: "production" }, body: "# Bare\n\n[[Magento]]\n" },
		"i/Critical.md": { props: { Type: "service", name: "Critical", environment: "production", tier: 1 }, body: "# Critical\n\n[[Magento]]\n" },
	};
	const result = run(notes);
	assert.deepStrictEqual(forRule(result, "tier-one-needs-slo").map((i) => i.path), ["i/Critical.md"]);
	assert.deepStrictEqual(forRule(result, "tier-one-needs-runbook").map((i) => i.path), ["i/Critical.md"]);
});

test("an SLA at or tighter than the SLO is an error", () => {
	const equal = { ...NOTES, "i/X.md": { props: { Type: "service", name: "X", environment: "production", tier: 1, slo: ["availability 99.9% over 30d"], sla: "99.9%", runbook: "r", escalation: "e" }, body: "# X\n\n[[Magento]]\n" } };
	const found = forRule(run(equal), "sla-tighter-than-slo");
	assert.strictEqual(found.length, 1);
	assert.match(found[0].message, /equal to/);
	// The fixture's Magento is 99.5% SLA against a 99.9% SLO — correct, and silent.
	assert.strictEqual(forRule(run(), "sla-tighter-than-slo").length, 0);
});

test("an RTO with a stale or absent restore test is reported", () => {
	// The fixture tested Aurora on 2026-07-15 and Magento on 2026-08-01, both
	// inside 180 days of the fixed NOW, so neither is reported.
	assert.strictEqual(forRule(run(), "untested-restore").length, 0);
	assert.strictEqual(forRule(run(undefined, { restoreTestDays: 7 }), "untested-restore").length, 2, "a 7-day freshness window makes both stale");

	const never = { ...NOTES, "i/Y.md": { props: { Type: "service", name: "Y", environment: "production", rto: "1h" }, body: "# Y\n\n[[Magento]]\n" } };
	assert.strictEqual(forRule(run(never), "untested-restore").length, 1);
});

test("the detection split is kept apart from the total", () => {
	const row = incidents(idx)[0];
	assert.strictEqual(row.timeToDetectMinutes, 20);
	assert.strictEqual(row.timeToRestoreMinutes, 70);
	assert.strictEqual(row.durationMinutes, 90);
});

test("the detection gap is null when nobody records a source, and 0% is not the same answer", () => {
	assert.deepStrictEqual(incidentStats(incidents(idx)).detectionGap, { humanFirst: 0, recorded: 1 });

	const silent = index({
		"i/INC-2026-009 — X.md": { props: { Type: "incident", id: "INC-2026-009", status: "resolved", severity: "SEV-3", started: "2026-08-01T00:00", resolved: "2026-08-01T01:00" }, body: "# X\n" },
	});
	assert.strictEqual(incidentStats(incidents(silent)).detectionGap, null);
});

test("an action item without an owner or a date is reported; a complete one is not", () => {
	assert.strictEqual(forRule(run(), "weak-action-items").length, 0, "the fixture's one open item has both");

	const weak = {
		"i/INC-2026-009 — X.md": {
			props: { Type: "incident", id: "INC-2026-009", status: "resolved", severity: "SEV-3", started: "2026-08-01T00:00", resolved: "2026-08-01T01:00", detected_by: "monitor" },
			body: "# X\n\n## Follow-up Actions\n\n- [ ] Fix the thing\n- [ ] Also this — [[Dana Reyes]]\n",
		},
	};
	const found = forRule(run(weak), "weak-action-items");
	assert.strictEqual(found.length, 1);
	assert.match(found[0].message, /2 open follow-up items/);
});

test("a release counts as a deployment only once it has actually happened", () => {
	// The fixture holds one complete release in the past and one pending in 2029.
	// Counting every release note would build a deployment frequency mostly out
	// of releases that have not happened.
	const rows = releases(idx, NOW);
	assert.strictEqual(rows.length, 2);
	assert.deepStrictEqual(rows.filter((r) => r.shipped).map((r) => r.version), ["v3.35"]);
});

test("three DORA keys compute and the fourth is refused", () => {
	const report = dora(releases(idx, NOW), incidents(idx), NOW, 90);
	const by = Object.fromEntries(report.metrics.map((m) => [m.label, m]));
	assert.strictEqual(report.deployments, 1);
	assert.strictEqual(by["Deployment frequency"].value, "one every 90 days");
	assert.strictEqual(by["Change failure rate"].value, "100%");
	assert.strictEqual(by["Failed deployment recovery"].value, "1h 10m");
	// Lead time needs commit timestamps the vault does not have. It is refused
	// rather than estimated from the release note's own date, which would
	// measure the release train instead of the change.
	assert.strictEqual(by["Lead time for changes"].value, null);
	assert.match(by["Lead time for changes"].basis, /not derivable/);
});

test("a rate from too few observations is shown but not graded", () => {
	// One deployment and one incident give a 100% change failure rate, so the
	// number is shown and the verdict withheld.
	const report = dora(releases(idx, NOW), incidents(idx), NOW, 90);
	const cfr = report.metrics.find((m) => m.label === "Change failure rate");
	assert.strictEqual(cfr.value, "100%");
	assert.strictEqual(cfr.band, "no-data");
	assert.match(cfr.basis, /too few to grade/);
	assert.strictEqual(verdict(cfr.band), "⚪");
});

test("no data is reported as no data, never as a zero", () => {
	const empty = dora([], [], NOW, 90);
	for (const metric of empty.metrics) {
		assert.strictEqual(metric.value, null, `${metric.label} invented a value out of nothing`);
		assert.strictEqual(metric.band, "no-data");
		assert.strictEqual(verdict(metric.band), "⚪", "no data must not be scored green or red");
	}
});

test("the report renders, says what it measures, and escapes what would break a table", () => {
	const text = reliabilityReport(idx, run().issues, { now: NOW, isoDate: "2026-08-24", windowDays: 90, scope: "3 folders", restoreTestDays: 180 });

	assert.ok(text.startsWith("---\n"), "frontmatter must start on line 1");
	assert.ok(text.includes("# Reliability snapshot — 2026-08-24"));
	// The caveat is on the face of the report, not in a footnote. This is the
	// assertion that matters most in this file.
	assert.match(text, /\*\*Every number here is a count of notes\.\*\*/);
	assert.match(text, /No data is not a zero/);
	assert.ok(text.includes("```mermaid"), "the dependency diagram is missing");
	assert.ok(!text.includes("style N0 fill"), "mermaid fills do not survive a theme change");
	assert.ok(text.includes("Aurora"));

	// A pipe inside a cell splits the table, backticks or not.
	const piped = reliabilityReport(
		index({ "i/P.md": { props: { Type: "service", name: "P", environment: "production", tier: 1, slo: ["availability 99% | 30d"] }, body: "# P\n" } }),
		[],
		{ now: NOW, isoDate: "2026-08-24", windowDays: 90, scope: "x", restoreTestDays: 180 }
	);
	assert.ok(piped.includes("99% \\| 30d"), "an unescaped pipe reached a table cell");
});

test("an empty vault renders a report that says so rather than one that looks healthy", () => {
	const text = reliabilityReport(index({}), [], { now: NOW, isoDate: "2026-08-24", windowDays: 90, scope: "x", restoreTestDays: 180 });
	assert.match(text, /No infrastructure notes are in scope/);
	assert.match(text, /This is not a reliability result/);
});

done();

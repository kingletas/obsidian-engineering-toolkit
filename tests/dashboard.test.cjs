const { assert, suite, test, done, load } = require("./harness.cjs");
const { dashboard, bar, duration } = load("dashboard-dashboard-engine");
const { index } = require("./fixtures.cjs");

const ALL = { adr: true, infrastructure: true, incidents: true, decisions: true, linter: true, automation: false };

suite("dashboard");

test("every section is present when every module is on", () => {
	const data = dashboard(index(), [], ALL);
	assert.strictEqual(data.adrTotal, 2);
	assert.strictEqual(data.infrastructure.total, 3);
	assert.strictEqual(data.incidentTotal, 1);
	assert.strictEqual(data.decisionTotal, 1);
	assert.deepStrictEqual(data.findings, { error: 0, warning: 0, info: 0 });
});

test("a module that is off contributes null, never zero", () => {
	// A section reading `0 services` and a module that is not running look
	// identical on screen and are completely different facts.
	const data = dashboard(index(), [], { ...ALL, infrastructure: false, linter: false });
	assert.strictEqual(data.infrastructure, null);
	assert.strictEqual(data.findings, null);
	assert.strictEqual(data.adrTotal, 2, "the modules that are on are unaffected");
});

test("an empty vault produces zeroes rather than dividing by anything", () => {
	const data = dashboard(index({}), [], ALL);
	assert.strictEqual(data.scannedNotes, 0);
	assert.strictEqual(data.incidents.medianMinutes, null);
	assert.strictEqual(bar(0), "░░░░░░░░░░░░");
});

test("a duration of unknown is a dash, not zero minutes", () => {
	assert.strictEqual(duration(null), "—");
	assert.strictEqual(duration(0), "0m");
	assert.strictEqual(duration(134), "2h 14m");
});

done();

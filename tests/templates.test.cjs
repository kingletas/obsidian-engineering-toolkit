const { assert, suite, test, done, load } = require("./harness.cjs");
const { adrNote, incidentNote, decisionNote, infraNote } = load("templates");
const { frontmatter, isoDate, appendToListUnder, uniquePath } = load("core-notes");

suite("templates");

const when = new Date(2026, 7, 24, 20, 5);

test("the ADR template is the one already in the vault, not the BRD's generic one", () => {
	// Four real ADRs are written to the playbook template. A fifth in a
	// different shape would be a second convention, not added structure.
	const text = adrNote({ id: "ADR-0005", title: "Use Redis", status: "proposed", date: when, owner: "[[Dana Reyes]]", tags: ["adr"] });
	assert.ok(text.startsWith("---\n"), "frontmatter must start on line 1 or Obsidian will not read it");
	assert.match(text, /^Type: ADR$/m);
	assert.match(text, /^domain: Decisions$/m);
	assert.match(text, /^State: active$/m);
	assert.match(text, /^# ADR-0005 — Use Redis$/m);
	for (const section of ["## Context", "## Decision", "## Alternatives", "## Consequences", "## Related"]) {
		assert.ok(text.includes(section), `missing ${section}`);
	}
	assert.ok(text.includes("[[Architecture Decision Records]]"));
});

test("a wikilink in frontmatter is quoted, or YAML reads it as a nested list", () => {
	assert.strictEqual(frontmatter({ Owner: "[[Dana Reyes]]" }), '---\nOwner: "[[Dana Reyes]]"\n---');
});

test("an empty list is written as a bare key rather than as the string []", () => {
	assert.strictEqual(frontmatter({ tags: [] }), "---\ntags:\n---");
	assert.strictEqual(frontmatter({ tags: ["a", "b"] }), "---\ntags:\n  - a\n  - b\n---");
});

test("the date is local, not UTC", () => {
	// `toISOString()` would file a note created at 8pm on the 24th under the 25th
	// for anybody west of Greenwich.
	assert.strictEqual(isoDate(new Date(2026, 7, 24, 20, 5)), "2026-08-24");
});

test("every template puts a blank line around each block", () => {
	for (const text of [
		adrNote({ id: "ADR-1", title: "T", status: "proposed", date: when, owner: "x", tags: [] }),
		incidentNote({ id: "INC-2026-001", title: "T", severity: "SEV-2", status: "open", started: when, owner: "x", tags: [] }),
		decisionNote({ title: "T", date: when, owner: "x", tags: [] }),
		infraNote({ type: "service", title: "T", environment: "production", owner: "x", dependencies: [], tags: [], tier: 1, slo: "availability 99.9% over 30d" }),
	]) {
		// The frontmatter block is YAML, not Markdown -- its list items are
		// indented mapping values and a blank line above one would break it.
		const lines = text.slice(text.indexOf("\n---", 3) + 4).split("\n");
		for (let i = 1; i < lines.length; i += 1) {
			const isBlock = /^(#{1,6}\s|\||>|\s*[-*+]\s|```)/.test(lines[i]);
			const previous = lines[i - 1];
			if (!isBlock || previous.trim() === "") continue;
			// A block may follow another line of the same block.
			const sameBlock = /^(\||>|\s*[-*+]\s|```)/.test(previous);
			assert.ok(sameBlock, `line ${i + 1} starts a block with no blank line above it:\n${previous}\n${lines[i]}`);
		}
	}
});

test("the infrastructure template writes the contract as properties, and the list stays a list", () => {
	const text = infraNote({ type: "service", title: "Magento", environment: "production", owner: "x", dependencies: ["Aurora"], tags: [], tier: 1, slo: "availability 99.9% over 30d" });
	assert.match(text, /^tier: 1$/m);
	// A single objective is still written as a list: a component acquires a
	// second one the moment anybody thinks about latency, and a property that
	// changes shape between one and two values breaks every reader of it.
	assert.ok(text.includes("slo:\n  - availability 99.9% over 30d"), text.slice(0, 400));
	// Absent parts of the contract are present and empty rather than omitted, so
	// the Properties panel shows the fields somebody still has to fill in.
	for (const key of ["sla", "rto", "rpo", "last_restore_test", "runbook"]) {
		assert.match(text, new RegExp(`^${key}: $`, "m"), `${key} is not offered as an empty property`);
	}
});

test("the incident template offers the detection properties before anyone forgets", () => {
	const text = incidentNote({ id: "INC-2026-003", title: "T", severity: "SEV-2", status: "open", started: when, owner: "x", tags: [] });
	for (const key of ["detected_at", "detected_by", "caused_by_deploy", "deploy_ref"]) {
		assert.ok(new RegExp(`^${key}:`, "m").test(text), `${key} is missing from the incident template`);
	}
	// The follow-up example carries both an owner and a date, because the
	// template is where the convention is taught. The owner is the configured
	// one, never a name baked into the template.
	assert.match(text, /- \[ \] Action — x 📅/);
	const unowned = incidentNote({ id: "INC-2026-004", title: "T", severity: "SEV-3", status: "open", started: when, owner: "", tags: [] });
	assert.match(unowned, /- \[ \] Action — @owner 📅/, "an unset owner still leaves a visible slot to fill");
});

test("the incident template seeds the timeline with the start time", () => {
	const text = incidentNote({ id: "INC-2026-002", title: "Down", severity: "SEV-1", status: "investigating", started: when, service: "Magento", owner: "x", tags: [] });
	assert.match(text, /^service: "\[\[Magento\]\]"$/m);
	assert.ok(text.includes("| 2026-08-24T20:05 | Started |"));
	assert.match(text, /^resolved: $/m, "resolved is present and empty, so the property panel shows the field");
});

test("appending under a heading adds a line and never rewrites one", () => {
	const before = "# Index\n\n## Records\n\n- [[A]]\n- [[B]]\n\n## Related\n\n- [[C]]\n";
	const after = appendToListUnder(before, "Records", "- [[D]]");
	assert.strictEqual(after, "# Index\n\n## Records\n\n- [[A]]\n- [[B]]\n- [[D]]\n\n## Related\n\n- [[C]]\n");
	// Already present: a no-op, not a duplicate.
	assert.strictEqual(appendToListUnder(after, "Records", "- [[D]]"), after);
	// Heading absent: the note is left completely alone.
	assert.strictEqual(appendToListUnder(before, "Nothing", "- [[D]]"), null);
});

test("creating a note never lands on an existing path", () => {
	const taken = new Set(["f/A.md", "f/A 2.md"]);
	assert.strictEqual(uniquePath("f", "A", (p) => taken.has(p)), "f/A 3.md");
	assert.strictEqual(uniquePath("", "A", () => false), "A.md");
});

done();

// A small vault parsed through the real parser and backlink builder, so rules
// are tested against shapes the parser actually produces.
const { load } = require("./harness.cjs");
const { parseNote, DEFAULT_PARSE_OPTIONS } = load("core-parser");
const { assemble } = load("core-indexer");

/** path -> { props, body } */
const NOTES = {
	"Engineering/Decision Records/ADR-0001 — Use MariaDB.md": {
		props: { Type: "ADR", status: "accepted", date: "2026-08-01", aliases: ["ADR-0001"], tags: ["adr"] },
		body: "# ADR-0001 — Use MariaDB\n\n## Context\n\nx\n\n## Decision\n\nx\n\n## Alternatives\n\nx\n\n## Consequences\n\nx\n",
	},
	"Engineering/Decision Records/ADR-0002 — Patch Core.md": {
		props: { Type: "ADR", status: "accepted", date: "2026-08-02", supersedes: ["ADR-0001"], aliases: ["ADR-0002"], tags: ["adr"] },
		body: "# ADR-0002 — Patch Core\n\n## Context\n\nSee [[ADR-0001 — Use MariaDB]].\n\n## Decision\n\nx\n\n## Alternatives\n\nx\n\n## Consequences\n\nx\n",
	},
	"Engineering/Infrastructure/Magento.md": {
		props: {
			Type: "service",
			name: "Magento",
			environment: "production",
			// Deliberately tier 2, below the database it rests on. The baseline
			// fixture is a *correct* estate, so any rule firing on it is a signal
			// rather than a known exception somebody has to remember.
			tier: 2,
			slo: ["availability 99.9% over 30d"],
			sla: "99.5%",
			rto: "4h",
			rpo: "15m",
			last_restore_test: "2026-08-01",
			runbook: "[[Magento Runbook]]",
			escalation: "[[Dana Reyes]]",
			dependencies: ["[[Aurora]]", "[[Redis]]"],
			tags: ["infrastructure"],
		},
		body: "# Magento\n\nSee [[Aurora]] and [[Redis]].\n",
	},
	"Engineering/Infrastructure/Aurora.md": {
		props: { Type: "database", name: "Aurora", environment: "production", tier: 1, slo: ["availability 99.95% over 30d"], rto: "1h", runbook: "[[Aurora Runbook]]", escalation: "[[Dana Reyes]]", last_restore_test: "2026-07-15", tags: ["infrastructure"] },
		body: "# Aurora\n",
	},
	"Engineering/Infrastructure/Redis.md": {
		props: { Type: "service", name: "Redis", environment: "production", tier: 2, dependencies: ["[[Aurora]]"], tags: ["infrastructure"] },
		body: "# Redis\n\n[[Aurora]]\n",
	},
	"Engineering/Incidents/INC-2026-001 — Checkout Down.md": {
		props: { Type: "incident", id: "INC-2026-001", status: "resolved", severity: "SEV-2", started: "2026-08-10T10:00", detected_at: "2026-08-10T10:20", detected_by: "monitor", resolved: "2026-08-10T11:30", service: "[[Magento]]", caused_by_deploy: true, deploy_ref: "v3.35", tags: ["incident"] },
		body: "# INC-2026-001 — Checkout Down\n\n## Summary\n\nx\n\n## Impact\n\nx\n\n## Detection\n\nx\n\n## Timeline\n\nx\n\n## Root Cause\n\nx\n\n## Resolution\n\nx\n\n## Follow-up Actions\n\n- [x] done\n- [ ] Add a canary — [[Dana Reyes]] 📅 2026-09-01\n",
	},
	// The runbook and escalation targets exist, because a `runbook:` pointing at
	// no note is a real finding and the baseline fixture must not carry one.
	"Engineering/Infrastructure/Magento Runbook.md": { props: {}, body: "# Magento Runbook\n" },
	"Engineering/Infrastructure/Aurora Runbook.md": { props: {}, body: "# Aurora Runbook\n" },
	"Engineering/People/Dana Reyes.md": { props: {}, body: "# Dana Reyes\n" },
	"Engineering/Releases/Cities/3. Petra.md": {
		props: { Version: "v3.35", Branch: "release/petra", Status: "Complete", "Release Time": "2026-08-05T22:00:00", tags: ["release"] },
		body: "# Petra\n\n[[Magento]]\n",
	},
	"Engineering/Releases/Cities/4. Wari.md": {
		props: { Version: "v3.36", Branch: "release/wari", Status: "Pending", "Release Time": "2029-04-24T22:58:00", tags: ["release"] },
		body: "# Wari\n\n[[Magento]]\n",
	},
	"Engineering/Decisions/Decision — Use pnpm.md": {
		props: { Type: "decision", date: "2026-08-12", status: "active", tags: ["decision"] },
		body: "# Decision — Use pnpm\n\n## Decision\n\nx\n\n## Reason\n\nx\n\nRelated: [[Magento]]\n",
	},
};

function wikilinks(body) {
	const out = [];
	for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) out.push({ link: match[1] });
	return out;
}

function buildRecords(notes = NOTES) {
	const names = new Map();
	for (const path of Object.keys(notes)) names.set(path.split("/").pop().replace(/\.md$/, ""), path);
	const resolve = (raw) => names.get(raw.split("|")[0].trim()) ?? null;

	const records = new Map();
	for (const [path, note] of Object.entries(notes)) {
		const basename = path.split("/").pop().replace(/\.md$/, "");
		const props = note.props ?? note;
		const body = note.body ?? "";
		const links = [...wikilinks(body), ...frontmatterLinks(props)];
		records.set(
			path,
			parseNote(
				{
					path,
					basename,
					frontmatter: props,
					links,
					embeds: [],
					tags: Array.isArray(props.tags) ? props.tags : [],
					headings: [...body.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => m[1]),
					body,
					mtime: 0,
					size: body.length,
				},
				resolve,
				DEFAULT_PARSE_OPTIONS
			)
		);
	}
	return records;
}

/** Obsidian's metadata cache reports wikilinks written inside frontmatter as
 * links too. Reproducing that matters: `dependencies: ["[[Aurora]]"]` is how
 * every infrastructure note declares its edges, and a fixture that dropped them
 * would make the orphan rule pass for the wrong reason. */
function frontmatterLinks(props) {
	const out = [];
	for (const value of Object.values(props)) {
		const items = Array.isArray(value) ? value : [value];
		for (const item of items) {
			if (typeof item !== "string") continue;
			for (const match of item.matchAll(/\[\[([^\]]+)\]\]/g)) out.push({ link: match[1] });
		}
	}
	return out;
}

const index = (notes) => assemble(buildRecords(notes));

module.exports = { NOTES, buildRecords, index };

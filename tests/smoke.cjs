// Loads the built main.js with a stubbed `obsidian` and checks the commands,
// view, settings defaults and activation rules are wired, since those fail only
// when invoked.
const Module = require("module");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const registered = { commands: [], views: [], ribbons: [], settingTabs: 0, events: 0 };

class Base {
	constructor(...args) {
		this._args = args;
	}
}

const stub = {
	Plugin: class extends Base {
		constructor(app, manifest) {
			super(app, manifest);
			this.app = app;
			this.manifest = manifest;
		}
		registerView(type) { registered.views.push(type); }
		addCommand(command) { registered.commands.push(command); }
		addRibbonIcon(icon, title) { registered.ribbons.push(title); }
		addSettingTab() { registered.settingTabs += 1; }
		addStatusBarItem() { return { addClass() {}, setText() {}, setAttr() {} }; }
		registerEvent(ref) {
			// Obsidian calls `ref.e.offref(ref)` on unload, so a plain function would throw
			// only at disable time; assert the shape at registration instead.
			assert.strictEqual(typeof ref, "object", "registerEvent was given something that is not an EventRef");
			registered.events += 1;
		}
		async loadData() { return this._data ?? null; }
		async saveData(data) { this._data = data; }
	},
	ItemView: class extends Base {},
	PluginSettingTab: class extends Base {},
	Modal: class extends Base {},
	Setting: class {
		setName() { return this; }
		setDesc() { return this; }
		setHeading() { return this; }
		addToggle() { return this; }
		addDropdown() { return this; }
		addText() { return this; }
		addTextArea() { return this; }
		addButton() { return this; }
		addExtraButton() { return this; }
	},
	Notice: class {},
	TFile: class extends Base {},
	TFolder: class extends Base {},
	WorkspaceLeaf: class extends Base {},
	setIcon: () => {},
	normalizePath: (p) => p.replace(/\/+/g, "/"),
	parseYaml: () => null,
};

const orig = Module._load;
Module._load = function (request) {
	if (request === "obsidian") return stub;
	return orig.apply(this, arguments);
};

// package.json says "type":"module" but Obsidian requires a CJS bundle. Node
// needs the extension to agree before it will require() it; Obsidian loads
// main.js itself and does not care.
const bundle = path.resolve(__dirname, "..", "main.js");
assert.ok(fs.existsSync(bundle), "main.js is missing — run `npm run build` first");
const tmp = path.join(__dirname, "main.build.cjs");
fs.copyFileSync(bundle, tmp);
const mod = require(tmp);
fs.unlinkSync(tmp);

console.log("smoke");
let passed = 0;
const ok = (message) => {
	passed += 1;
	console.log(`  ok  ${message}`);
};

const Plugin = mod.default ?? mod;
assert.strictEqual(typeof Plugin, "function", "default export is not a class");
assert.strictEqual(Object.getPrototypeOf(Plugin), stub.Plugin, "does not extend Plugin");
ok("the bundle loads and extends Plugin");

// A minimal app: every method the load path touches and nothing else. A stub
// that answers everything would hide a call with no business being on the load
// path in the first place.
const app = {
	workspace: {
		onLayoutReady(fn) { this._ready = fn; },
		getActiveFile: () => null,
		getLeavesOfType: () => [],
		getLeaf: () => ({ setViewState() {}, openFile() {} }),
		getRightLeaf: () => null,
		revealLeaf() {},
		on: () => ({}),
	},
	metadataCache: { on: () => ({}), offref() {}, getFirstLinkpathDest: () => null, getFileCache: () => null },
	vault: {
		on: () => ({}),
		getMarkdownFiles: () => [],
		getAbstractFileByPath: () => null,
		adapter: { async exists() { return false; }, async read() { return ""; }, async write() {} },
	},
	fileManager: {},
};

const plugin = new Plugin(app, { id: "engineering-toolkit", dir: ".obsidian/plugins/engineering-toolkit" });

(async () => {
	await plugin.onload();

	const ids = registered.commands.map((c) => c.id).sort();
	for (const required of [
		"scan",
		"open-dashboard",
		"open-findings",
		"check-note",
		"create-adr",
		"create-incident",
		"create-decision",
		"create-infrastructure",
		"resolve-incident",
		"promote-decision",
		"fix-all",
		"reliability-snapshot",
	]) {
		assert.ok(ids.includes(required), `missing command \`${required}\` (have: ${ids.join(", ")})`);
	}
	ok(`${ids.length} commands registered, one per MVP capability in §14`);

	// Note-scoped commands must disappear rather than be invocable and fail;
	// `reliability-snapshot` is gated on its module, so it is checked separately.
	for (const id of ["check-note", "resolve-incident", "promote-decision"]) {
		const command = registered.commands.find((c) => c.id === id);
		assert.ok(command?.checkCallback, `\`${id}\` is not note-scoped`);
		assert.strictEqual(command.checkCallback(true), false, `\`${id}\` is available with no active file`);
	}
	const snapshot = registered.commands.find((c) => c.id === "reliability-snapshot");
	assert.strictEqual(snapshot.checkCallback(true), true, "the snapshot command is hidden while its module is on");
	ok("note-scoped commands hide themselves when there is no note; the snapshot command is gated on its module instead");

	assert.deepStrictEqual(registered.views, ["engineering-toolkit-dashboard"]);
	assert.strictEqual(registered.settingTabs, 1);
	assert.strictEqual(registered.ribbons.length, 1);
	ok("the dashboard view, the settings tab and the ribbon icon are registered");

	assert.strictEqual(registered.events, 3, `expected 3 vault events, got ${registered.events}`);
	app.workspace._ready();
	assert.strictEqual(registered.events, 4, "the startup scan did not wait for the metadata cache to resolve");
	ok("the vault events that drive incremental indexing are registered, and startup waits for `resolved`");

	// Defaults must survive an empty data.json.
	assert.strictEqual(plugin.settings.modules.linter, true);
	assert.strictEqual(plugin.settings.modules.automation, false, "the module that writes to notes must ship off");
	// Empty rather than a folder list. A shipped folder name would be one vault's
	// folder, silently scoping every other install to a path that does not exist --
	// which presents as "the index found nothing" rather than as an unset setting.
	assert.deepStrictEqual(plugin.settings.includeFolders, []);
	assert.strictEqual(plugin.settings.adrFolder, "Engineering/Decision Records");
	// Empty, because whatever goes here is stamped onto every record the create
	// commands write, and a default would sign one vault with another person's name.
	assert.strictEqual(plugin.settings.owner, "");
	assert.strictEqual(plugin.settings.modules.reliability, true);
	// 90 days rather than 30: this estate ships every three to four weeks, and a
	// 30-day window would often hold one release or none.
	assert.strictEqual(plugin.settings.doraWindowDays, 90);
	ok("settings fall back to defaults, unscoped and unsigned until you set them");

	// A stored automation must never come back switched on -- not from an older
	// settings file, not from a vault copied between machines.
	plugin._data = { automations: [{ id: "x", name: "Stored", enabled: true, event: "note-created", conditions: [], actions: [] }] };
	await plugin.loadSettings();
	assert.strictEqual(plugin.settings.automations[0].enabled, false, "a stored automation was loaded already enabled");
	ok("a stored automation is forced off on load, whatever the file says");

	assert.strictEqual(typeof plugin.indexer.scope, "function");
	assert.deepStrictEqual(plugin.indexer.scope().include, plugin.settings.includeFolders);
	ok("the indexer reports the scope it is actually using");

	// An empty vault must produce an empty index and no findings, not a crash.
	assert.deepStrictEqual(plugin.issues(), []);
	assert.strictEqual(plugin.relint().scannedNotes, 0);
	ok("an empty vault indexes to nothing without throwing");

	// Nothing in the plugin reads a running system, asserted against the shipped
	// bundle because that is what runs.
	const shipped = fs.readFileSync(bundle, "utf8");
	for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /requestUrl\s*\(/, /new WebSocket/]) {
		assert.ok(!pattern.test(shipped), `the bundle makes a network call matching ${pattern}`);
	}
	ok("the shipped bundle contains no network call — nothing is read from a running system");

	// Nothing in the plugin can delete a note. Asserted against the built
	// bundle rather than the source, because that is what actually ships.
	const built = fs.readFileSync(bundle, "utf8");
	for (const pattern of [/vault\.delete\(/, /vault\.trash\(/, /adapter\.remove\(/, /\.trashLocal\(/]) {
		assert.ok(!pattern.test(built), `the bundle contains a deletion call matching ${pattern}`);
	}
	ok("the shipped bundle contains no vault deletion call at all");

	plugin.onunload();
	ok("unload is clean");

	console.log(`smoke: ${passed} passed\n`);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});

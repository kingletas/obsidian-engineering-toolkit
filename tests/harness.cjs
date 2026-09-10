// Three functions. A test file that needs a framework to say "this equals that"
// has bigger problems than the framework.
const assert = require("assert");
const path = require("path");

let passed = 0;
let group = "";

function suite(name) {
	if (group) console.log(`${group}: ${passed} passed\n`);
	group = name;
	passed = 0;
	console.log(name);
}

function test(name, fn) {
	fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

function done() {
	console.log(`${group}: ${passed} passed\n`);
	passed = 0;
}

const load = (name) => require(path.join(__dirname, "build", `${name}.cjs`));

module.exports = { assert, suite, test, done, load };

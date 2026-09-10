// Building a note's text. The plugin creates and appends but never deletes or
// overwrites, and `uniquePath` gives a colliding create a suffix instead.

/** Serialise frontmatter. Written by hand rather than through a YAML library
 * because the output has to be *predictable* -- a template the user then edits
 * should look like the templates they already have, with keys in the order they
 * are declared, not in whatever order a serialiser emits. */
export function frontmatter(props: Record<string, unknown>): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			// An empty list is written as a bare key. Obsidian's Properties panel
			// shows that as an empty list rather than as the string "[]", which is
			// what `aliases: []` renders as and is not what anybody meant.
			lines.push(`${key}:`);
			for (const item of value) lines.push(`  - ${scalar(item)}`);
		} else {
			lines.push(`${key}: ${scalar(value)}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

function scalar(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const text = String(value);
	if (text === "") return "";
	// Quote anything YAML would read as something other than a string, such as an
	// unquoted wikilink, which parses as a nested list.
	if (/^[[{*&!%@`]/.test(text) || /:\s/.test(text) || /^(yes|no|true|false|null|on|off)$/i.test(text) || /^-?\d+(\.\d+)?$/.test(text)) {
		return JSON.stringify(text);
	}
	return text;
}

/** `YYYY-MM-DD` in local time. `toISOString()` is UTC and would file a note
 * created at 8pm on the 24th under the 25th for anyone west of Greenwich. */
export function isoDate(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DDTHH:mm`, the shape §6.3 uses for `started` and `resolved`. */
export function isoMinute(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${isoDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A path in `folder` that no file occupies. Suffixes ` 2`, ` 3`, … the way
 * Obsidian's own "note already exists" handling does. */
export function uniquePath(folder: string, name: string, exists: (path: string) => boolean): string {
	const base = folder ? `${folder}/${name}` : name;
	if (!exists(`${base}.md`)) return `${base}.md`;
	for (let n = 2; n < 100; n += 1) {
		const candidate = `${base} ${n}.md`;
		if (!exists(candidate)) return candidate;
	}
	// 99 collisions means something is wrong that a 100th file will not fix.
	throw new Error(`could not find a free filename for "${name}" in ${folder || "the vault root"}`);
}

/** Insert `line` at the end of the Markdown list under `heading`, or return null
 * when the heading is absent; a line already present is a no-op. */
export function appendToListUnder(text: string, heading: string, line: string): string | null {
	const lines = text.split("\n");
	const wanted = heading.trim().toLowerCase();
	let start = -1;
	for (let i = 0; i < lines.length; i += 1) {
		const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (match && match[2].trim().toLowerCase() === wanted) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	if (lines.includes(line)) return text;

	let end = start + 1;
	let lastItem = -1;
	for (; end < lines.length; end += 1) {
		if (/^#{1,6}\s/.test(lines[end])) break;
		if (/^\s*[-*+]\s/.test(lines[end])) lastItem = end;
	}
	// No list under the heading yet: open one directly after it, with the blank
	// line Obsidian needs before a block that follows a paragraph.
	const at = lastItem >= 0 ? lastItem + 1 : start + 1;
	const insert = lastItem >= 0 ? [line] : ["", line];
	return [...lines.slice(0, at), ...insert, ...lines.slice(at)].join("\n");
}

// Which files the toolkit indexes, as a pure rule. `include` is an allowlist
// where empty means the whole vault, and `exclude` is applied after it.

export interface Scope {
	include: string[];
	exclude: string[];
}

/** Normalise a folder as typed into a settings field: trim, drop a leading `/`
 * and any trailing `/`. `""` and `/` both mean the vault root and are dropped,
 * because an allowlist containing the root is not an allowlist. */
export function normaliseFolder(folder: string): string {
	return folder.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export function normaliseScope(scope: Scope): Scope {
	return {
		include: scope.include.map(normaliseFolder).filter(Boolean),
		exclude: scope.exclude.map(normaliseFolder).filter(Boolean),
	};
}

function under(path: string, folder: string): boolean {
	// The `/` guard is what stops `Engineering` from matching `Engineering Notes/x.md`.
	return path === folder || path.startsWith(folder + "/");
}

/** True when a vault-relative path is in scope. */
export function inScope(path: string, scope: Scope): boolean {
	const { include, exclude } = normaliseScope(scope);
	if (include.length > 0 && !include.some((f) => under(path, f))) return false;
	return !exclude.some((f) => under(path, f));
}

/** One line naming the scope, for the dashboard header and the scan notice. A
 * scoped count that reads as a whole-vault count is the misreading this exists
 * to prevent: 60 notes and 9,000 notes are both "the vault" to somebody
 * glancing at a number with no denominator on it. */
export function describeScope(scope: Scope): string {
	const { include, exclude } = normaliseScope(scope);
	const less = exclude.length === 0 ? "" : `, less ${exclude.length} excluded`;
	if (include.length === 0) return `the whole vault${less}`;
	return `${include.length === 1 ? include[0] : `${include.length} folders`}${less}`;
}

// Parses service level objectives from frontmatter into an error budget, purely.
// An SLO needs an indicator, a target and a window, and the budget is always
// derived from the objective, never read from frontmatter.

/** Written form: `availability 99.9% over 30d`, or with a latency threshold,
 * `latency 99% under 500ms over 30d`. */
export interface SloTarget {
	/** Exactly as written, so a finding can quote it back. */
	raw: string;
	/** `availability`, `latency`, `quality`, or whatever was written. */
	sli: string;
	/** 0..1. Null when the objective could not be read. */
	objective: number | null;
	/** `30d`, `7d`, `4w`. Null when absent. */
	window: string | null;
	windowDays: number | null;
	/** Latency threshold as written, e.g. `500ms`. Null for other SLI types. */
	threshold: string | null;
	/** Set when the declaration is structurally wrong. Null when it parses. */
	problem: SloProblem | null;
}

export type SloProblem = "no-objective" | "no-window" | "percentile" | "objective-out-of-range";

/** Minutes of error budget the objective allows over its window. Null unless
 * both halves are present -- a budget computed from a missing window would be a
 * number with no meaning, and a number with no meaning is worse than a blank. */
export function budgetMinutes(target: SloTarget): number | null {
	if (target.objective === null || target.windowDays === null) return null;
	return Math.round(target.windowDays * 24 * 60 * (1 - target.objective) * 10) / 10;
}

/** `43m`, `4h 22m`, `2d 4h`. Rounded to something a person can hold. */
export function formatBudget(minutes: number | null): string {
	if (minutes === null) return "—";
	if (minutes < 60) return `${round(minutes)}m`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${round(minutes % 60)}m`;
	return `${Math.floor(minutes / 1440)}d ${Math.round((minutes % 1440) / 60)}h`;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

const WINDOW = /(\d+(?:\.\d+)?)\s*(h|hour|hours|d|day|days|w|week|weeks|mo|month|months)\b/i;

export function parseWindow(text: string): { window: string; days: number } | null {
	const match = WINDOW.exec(text);
	if (!match) return null;
	const n = Number.parseFloat(match[1]);
	const unit = match[2].toLowerCase();
	const days = unit.startsWith("h") ? n / 24 : unit.startsWith("w") ? n * 7 : unit.startsWith("mo") ? n * 30 : n;
	return { window: `${match[1]}${unit}`, days };
}

/** A percentile written as an objective, like `p99 500ms`, is reported rather than
 * accepted because it has no proportion to budget against. */
const PERCENTILE = /\bp(?:50|75|90|95|99|99\.9)\b/i;

export function parseSlo(raw: string): SloTarget {
	const text = String(raw).trim();
	const base: SloTarget = { raw: text, sli: "", objective: null, window: null, windowDays: null, threshold: null, problem: null };

	if (PERCENTILE.test(text)) {
		return { ...base, sli: firstWord(text), problem: "percentile" };
	}

	// The SLI is whatever comes before the first number. `checkout availability
	// 99.9% over 30d` keeps both words, because a service with two availability
	// SLOs needs them told apart by name.
	const objectiveMatch = /(\d+(?:\.\d+)?)\s*%/.exec(text);
	const sli = (objectiveMatch ? text.slice(0, objectiveMatch.index) : text).trim().replace(/[:,-]$/, "") || firstWord(text);

	if (!objectiveMatch) return { ...base, sli, problem: "no-objective" };
	const percent = Number.parseFloat(objectiveMatch[1]);
	if (!(percent > 0) || percent > 100) return { ...base, sli, problem: "objective-out-of-range" };

	// The window is looked for only AFTER the objective, so `latency 99% under
	// 500ms over 30d` does not mistake the 500ms threshold for a window.
	const after = text.slice(objectiveMatch.index + objectiveMatch[0].length);
	const window = parseWindow(after);
	const threshold = /under\s+([\d.]+\s*(?:ms|s|seconds?))/i.exec(text)?.[1]?.replace(/\s+/g, "") ?? null;

	const objective = ratio(percent);
	if (!window) return { ...base, sli, objective, threshold, problem: "no-window" };
	return { ...base, sli, objective, window: window.window, windowDays: window.days, threshold, problem: null };
}

function firstWord(text: string): string {
	return text.trim().split(/\s+/)[0] ?? "";
}

/** Read the `slo:` property in any of the shapes a person actually writes it:
 * one string, a list of strings, or a mapping of name to target. */
export function readSlos(value: unknown): SloTarget[] {
	if (value === undefined || value === null || value === "") return [];
	if (Array.isArray(value)) return value.map((entry) => parseSlo(String(entry)));
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).map(([name, target]) => parseSlo(`${name} ${String(target)}`));
	}
	return [parseSlo(String(value))];
}

/** An SLA is a single percentage; the comparison against the SLO is what
 * matters, not its window. Null when unreadable. */
export function readSla(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	const match = /(\d+(?:\.\d+)?)\s*%/.exec(String(value));
	if (!match) return null;
	const percent = Number.parseFloat(match[1]);
	return percent > 0 && percent <= 100 ? ratio(percent) : null;
}

/** A percentage as a fraction, rounded to eight places so identical objectives
 * compare equal; `99.9 / 100` is 0.9990000000000001 in IEEE 754. */
function ratio(percent: number): number {
	return Math.round((percent / 100) * 1e8) / 1e8;
}

/** Tier as a small integer. `1`, `"1"`, `"tier-1"` and `"Tier 1"` all read as 1;
 * anything else is null rather than a guess. */
export function readTier(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	const match = /(\d)/.exec(String(value));
	if (!match) return null;
	const tier = Number.parseInt(match[1], 10);
	return tier >= 1 && tier <= 4 ? tier : null;
}

/** A duration written for an RTO or RPO: `15m`, `4h`, `1d`, `0`. Returns
 * minutes. `0` is meaningful -- an RPO of zero is a real and expensive choice --
 * so it is distinguished from absent, which is null. */
export function readDuration(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	const text = String(value).trim();
	if (/^0+$/.test(text)) return 0;
	const match = /(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?|d|days?)\b/i.exec(text);
	if (!match) return null;
	const n = Number.parseFloat(match[1]);
	const unit = match[2].toLowerCase();
	return unit.startsWith("d") ? n * 1440 : unit.startsWith("h") ? n * 60 : n;
}

// Infrastructure relationships (§5.2, §5.3) and the environment breakdown
// (§5.4, §5.5). Pure, and it never reads a value, resolves a hostname or
// handles a credential (§5.6).

import { ofKind, type NoteRecord, type ToolkitIndex } from "../core/types";
import { ENVIRONMENTS } from "../records/record-types";
import { readDuration, readSla, readSlos, readTier, type SloTarget } from "../reliability/slo";

/** The reliability contract as declared. Everything here is read, never
 * computed from live data -- this plugin documents the promise and something
 * else measures whether it is kept. */
export interface Reliability {
	/** 1 is the most critical. Null when the note does not say. */
	tier: number | null;
	slos: SloTarget[];
	/** 0..1, or null. */
	sla: number | null;
	/** Minutes. */
	rto: number | null;
	rpo: number | null;
	/** ISO date of the last tested restore, as written. */
	lastRestoreTest: string | null;
	runbook: string | null;
	dashboard: string | null;
	alerts: string | null;
	escalation: string | null;
}

export interface InfraNode {
	note: NoteRecord;
	name: string;
	type: string;
	environment: string | null;
	reliability: Reliability;
	/** Resolved paths of the things this depends on. */
	dependencies: string[];
	/** Raw dependency text that resolved to nothing. Kept rather than dropped:
	 * a dependency on a note that does not exist is the most interesting thing
	 * on an infrastructure page, and silently omitting it makes the tree look
	 * complete when it is not. */
	unresolved: string[];
	/** Paths of infrastructure notes that depend on this one. */
	dependents: string[];
}

export interface InfraGraph {
	nodes: Map<string, InfraNode>;
	roots: InfraNode[];
}

function depRefs(note: NoteRecord): string[] {
	const raw = note.props.dependencies ?? note.props.depends_on;
	const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];
	return list.map((entry) => String(entry).replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].trim()).filter(Boolean);
}

export function infraGraph(index: ToolkitIndex): InfraGraph {
	const notes = ofKind(index, "infrastructure");
	const byName = new Map<string, NoteRecord>();
	for (const note of notes) {
		byName.set(note.basename, note);
		const name = note.props.name;
		if (typeof name === "string" && name.trim()) byName.set(name.trim(), note);
	}

	const nodes = new Map<string, InfraNode>();
	for (const note of notes) {
		nodes.set(note.path, {
			note,
			name: typeof note.props.name === "string" && note.props.name.trim() ? note.props.name.trim() : note.basename,
			type: note.type ?? "service",
			environment: typeof note.props.environment === "string" ? note.props.environment.trim().toLowerCase() : null,
			reliability: readReliability(note),
			dependencies: [],
			unresolved: [],
			dependents: [],
		});
	}

	for (const note of notes) {
		const node = nodes.get(note.path);
		if (!node) continue;
		for (const ref of depRefs(note)) {
			const target = byName.get(ref);
			if (!target || target.path === note.path) {
				// A self-dependency is dropped rather than reported: it is almost
				// always a copy-paste in a template and reporting it teaches nothing.
				if (!target) node.unresolved.push(ref);
				continue;
			}
			node.dependencies.push(target.path);
			nodes.get(target.path)?.dependents.push(note.path);
		}
	}

	const roots = [...nodes.values()].filter((node) => node.dependents.length === 0).sort((a, b) => a.name.localeCompare(b.name));
	return { nodes, roots };
}

export function readReliability(note: NoteRecord): Reliability {
	const text = (key: string): string | null => {
		const value = note.props[key];
		if (value === undefined || value === null) return null;
		const out = String(value).trim();
		return out ? out : null;
	};
	return {
		tier: readTier(note.props.tier),
		slos: readSlos(note.props.slo ?? note.props.slos),
		sla: readSla(note.props.sla),
		rto: readDuration(note.props.rto),
		rpo: readDuration(note.props.rpo),
		lastRestoreTest: text("last_restore_test"),
		runbook: text("runbook"),
		dashboard: text("dashboard"),
		alerts: text("alerts"),
		escalation: text("escalation") ?? text("on_call") ?? text("Owner"),
	};
}

/** Every node affected if this one were unavailable: its dependents, transitively,
 * with the visited set as the termination condition so cycles are safe. */
export function blastRadius(graph: InfraGraph, path: string): InfraNode[] {
	const seen = new Set<string>([path]);
	const queue = [path];
	const out: InfraNode[] = [];
	while (queue.length) {
		const current = graph.nodes.get(queue.shift() as string);
		if (!current) continue;
		for (const dependent of current.dependents) {
			if (seen.has(dependent)) continue;
			seen.add(dependent);
			const node = graph.nodes.get(dependent);
			if (!node) continue;
			out.push(node);
			queue.push(dependent);
		}
	}
	return out.sort((a, b) => (a.reliability.tier ?? 9) - (b.reliability.tier ?? 9) || a.name.localeCompare(b.name));
}

/** Dependencies with a weaker tier than the node depending on them. */
export function tierInversions(graph: InfraGraph): Array<{ node: InfraNode; dependency: InfraNode }> {
	const out: Array<{ node: InfraNode; dependency: InfraNode }> = [];
	for (const node of graph.nodes.values()) {
		const tier = node.reliability.tier;
		if (tier === null) continue;
		for (const path of node.dependencies) {
			const dependency = graph.nodes.get(path);
			if (!dependency) continue;
			const other = dependency.reliability.tier;
			if (other === null || other <= tier) continue;
			out.push({ node, dependency });
		}
	}
	return out;
}

/** The §5.3 tree, as lines. Depth-limited and cycle-safe: infrastructure
 * dependency graphs contain cycles in practice (a service that depends on a
 * cache that is warmed by that service), and a renderer that assumes a tree
 * hangs the window rather than drawing a slightly wrong picture. */
export function renderTree(graph: InfraGraph, root: InfraNode, maxDepth = 6): string[] {
	const out: string[] = [root.name];
	const walk = (node: InfraNode, prefix: string, depth: number, seen: Set<string>): void => {
		if (depth > maxDepth) return;
		const children = node.dependencies.map((path) => graph.nodes.get(path)).filter((n): n is InfraNode => !!n);
		const missing = node.unresolved;
		const total = children.length + missing.length;
		let i = 0;
		for (const child of children) {
			const last = i === total - 1;
			i += 1;
			if (seen.has(child.note.path)) {
				out.push(`${prefix}${last ? "└── " : "├── "}${child.name} (cycle)`);
				continue;
			}
			out.push(`${prefix}${last ? "└── " : "├── "}${child.name}`);
			walk(child, `${prefix}${last ? "    " : "│   "}`, depth + 1, new Set([...seen, child.note.path]));
		}
		for (const ref of missing) {
			const last = i === total - 1;
			i += 1;
			out.push(`${prefix}${last ? "└── " : "├── "}${ref} (no note)`);
		}
	};
	walk(root, "", 1, new Set([root.note.path]));
	return out;
}

export interface InfraStats {
	byType: Record<string, number>;
	byEnvironment: Record<string, Record<string, number>>;
	total: number;
	/** Notes whose `environment` is absent or is not one of the three. */
	unplaced: number;
}

export function infraStats(graph: InfraGraph): InfraStats {
	const byType: Record<string, number> = {};
	const byEnvironment: Record<string, Record<string, number>> = {};
	for (const environment of ENVIRONMENTS) byEnvironment[environment] = {};
	let unplaced = 0;

	for (const node of graph.nodes.values()) {
		byType[node.type] = (byType[node.type] ?? 0) + 1;
		const environment = node.environment && isEnvironment(node.environment) ? node.environment : null;
		if (!environment) {
			unplaced += 1;
			continue;
		}
		byEnvironment[environment][node.type] = (byEnvironment[environment][node.type] ?? 0) + 1;
	}

	return { byType, byEnvironment, total: graph.nodes.size, unplaced };
}

function isEnvironment(value: string): boolean {
	return (ENVIRONMENTS as readonly string[]).includes(value);
}

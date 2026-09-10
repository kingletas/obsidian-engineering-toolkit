// Applies a plan: the only automation file that writes to the vault, and it never deletes.
// Writes go through `processFrontMatter` and `renameFile`, so the body is left
// untouched and wikilinks follow a move.

import { TFile, TFolder, normalizePath, type App } from "obsidian";
import { appendToListUnder, uniquePath } from "../core/notes";
import type { PlannedAction } from "./engine";

export interface RunResult {
	/** Rendered descriptions of what was done, or what a dry run would do. */
	performed: string[];
	/** Actions that were already satisfied, or whose note was not the shape the
	 * rule assumed. Reported rather than dropped: a rule that quietly does
	 * nothing looks exactly like a rule that is switched off. */
	skipped: string[];
	failed: string[];
}

export class Runner {
	constructor(
		private app: App,
		/** Called with every path written, so the loop guard can ignore the event
		 * that write is about to produce. */
		private onWrite: (path: string) => void
	) {}

	/** `dryRun` returns the plan's own descriptions without touching anything.
	 * The descriptions come from the plan rather than from this file, so the
	 * preview and the log say the same words about the same action. */
	async run(plan: PlannedAction[], dryRun: boolean): Promise<RunResult> {
		const result: RunResult = { performed: [], skipped: [], failed: [] };
		for (const planned of plan) {
			if (dryRun) {
				result.performed.push(planned.describe);
				continue;
			}
			try {
				const done = await this.apply(planned);
				(done ? result.performed : result.skipped).push(planned.describe);
			} catch (error) {
				result.failed.push(`${planned.describe} — ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return result;
	}

	/** Returns false when the action was a no-op: the property already held the
	 * value, the tag was already there, the heading does not exist. That is the
	 * third leg of the loop guard -- a steady state produces no write, so it
	 * produces no event, so nothing re-triggers. */
	private async apply(planned: PlannedAction): Promise<boolean> {
		const { action, value } = planned;
		if (action.kind === "create-note") return this.create(value || action.target, planned);

		const file = this.app.vault.getAbstractFileByPath(planned.sourcePath);
		if (!(file instanceof TFile)) return false;

		switch (action.kind) {
			case "set-property":
				return this.setProperty(file, action.target, value);
			case "add-tag":
				return this.addTag(file, action.target);
			case "move-note":
				return this.move(file, value || action.target);
			case "append-text":
				return this.append(file, action.target, value);
			case "create-task":
				return this.append(file, action.target, `- [ ] ${value}`);
			case "add-link":
				return this.addLink(file, value || action.target);
			default:
				return false;
		}
	}

	private async setProperty(file: TFile, property: string, value: string): Promise<boolean> {
		if (!property.trim()) return false;
		let changed = false;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (String(fm[property] ?? "") === value) return;
			fm[property] = value;
			changed = true;
		});
		if (changed) this.onWrite(file.path);
		return changed;
	}

	private async addTag(file: TFile, tag: string): Promise<boolean> {
		const clean = tag.replace(/^#/, "").trim();
		if (!clean) return false;
		let changed = false;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const existing = Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String) : typeof fm.tags === "string" ? [fm.tags] : [];
			if (existing.includes(clean)) return;
			fm.tags = [...existing, clean];
			changed = true;
		});
		if (changed) this.onWrite(file.path);
		return changed;
	}

	/** A move is the one action that can lose work, so it is the one action with
	 * a guard rail: an existing file at the destination is never overwritten --
	 * the moved note gets a suffixed name instead -- and a missing destination
	 * folder is created rather than failing halfway. */
	private async move(file: TFile, folder: string): Promise<boolean> {
		const target = normalizePath(folder.replace(/\/+$/, ""));
		if (!target || file.parent?.path === target) return false;
		const existing = this.app.vault.getAbstractFileByPath(target);
		if (!existing) await this.app.vault.createFolder(target).catch(() => undefined);
		else if (!(existing instanceof TFolder)) throw new Error(`${target} is a file, not a folder`);

		const destination = uniquePath(target, file.basename, (p) => this.app.vault.getAbstractFileByPath(p) !== null);
		await this.app.fileManager.renameFile(file, destination);
		this.onWrite(destination);
		return true;
	}

	private async create(name: string, planned: PlannedAction): Promise<boolean> {
		const clean = normalizePath(name.replace(/\.md$/i, ""));
		if (!clean) return false;
		const slash = clean.lastIndexOf("/");
		const folder = slash < 0 ? "" : clean.slice(0, slash);
		const basename = slash < 0 ? clean : clean.slice(slash + 1);
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => undefined);
		const path = uniquePath(folder, basename, (p) => this.app.vault.getAbstractFileByPath(p) !== null);
		await this.app.vault.create(path, `# ${basename}\n\nCreated by the automation **${planned.rule.name}** from [[${planned.sourcePath.replace(/\.md$/, "").split("/").pop()}]].\n`);
		this.onWrite(path);
		return true;
	}

	private async append(file: TFile, heading: string, text: string): Promise<boolean> {
		if (!text.trim()) return false;
		const current = await this.app.vault.read(file);
		if (heading.trim()) {
			const line = text.startsWith("- ") ? text : `- ${text}`;
			const updated = appendToListUnder(current, heading, line);
			// A missing heading means the note is not the shape the rule assumed, so
			// skip it and let the execution log say so.
			if (updated === null || updated === current) return false;
			await this.app.vault.modify(file, updated);
		} else {
			if (current.includes(text)) return false;
			await this.app.vault.modify(file, `${current.replace(/\s*$/, "")}\n\n${text}\n`);
		}
		this.onWrite(file.path);
		return true;
	}

	private async addLink(file: TFile, target: string): Promise<boolean> {
		const clean = target.replace(/^\[\[|\]\]$/g, "").trim();
		if (!clean) return false;
		const current = await this.app.vault.read(file);
		if (current.includes(`[[${clean}]]`)) return false;
		const updated = appendToListUnder(current, "Related", `- [[${clean}]]`);
		await this.app.vault.modify(file, updated ?? `${current.replace(/\s*$/, "")}\n\n## Related\n\n- [[${clean}]]\n`);
		this.onWrite(file.path);
		return true;
	}
}

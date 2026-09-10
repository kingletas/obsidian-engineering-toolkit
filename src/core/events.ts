// A three-method emitter. The plugin has one event -- "the index changed" --
// and pulling in a dependency for that would be silly.

export type Listener<T> = (payload: T) => void;

export class Emitter<T> {
	private listeners = new Set<Listener<T>>();

	on(listener: Listener<T>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(payload: T): void {
		// Copied before iterating: a view that unsubscribes inside its own handler
		// -- which is what a closing pane does -- would otherwise mutate the set
		// mid-iteration.
		for (const listener of [...this.listeners]) listener(payload);
	}
}

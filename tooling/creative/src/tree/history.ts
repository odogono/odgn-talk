import {
  detached as detach,
  equal,
  freeze,
  type TreeChange,
  type TreeJournal,
} from './project-tree';

/** Detach durable history at the retaining boundary, never freeze live data. */
export const detachJournal = (journal: TreeJournal): TreeJournal =>
  freeze(
    journal.map(change =>
      change.kind === 'children'
        ? detach(change)
        : {
            ...change,
            before: detach(change.before),
            after: detach(change.after),
          },
    ),
  );

/** Fold only incoming writes. Structural changes delimit reversible field runs. */
export class TreeHistory {
  #changes: TreeChange[] = [];
  #fields = new Map<string, number>();

  get changes(): TreeJournal {
    return this.#changes;
  }

  append(journal: TreeJournal): void {
    for (const change of journal) {
      if (change.kind === 'children') {
        this.#fields.clear();
        this.#changes.push(change);
        continue;
      }
      const key = `${change.owner}:${change.field}`;
      const index = this.#fields.get(key);
      if (index === undefined) {
        this.#fields.set(key, this.#changes.length);
        this.#changes.push(change);
      } else {
        // Indices in #fields always point at field changes.
        const previous = this.#changes[index] as typeof change;
        this.#changes[index] = { ...previous, after: change.after };
      }
    }
  }

  snapshot(): TreeJournal {
    // Field payloads are replaced atomically by ProjectTree, never mutated in
    // place. Keep those values during a live edit; detach only its endpoints.
    return detachJournal(
      this.#changes.filter(
        change =>
          change.kind === 'children' || !equal(change.before, change.after),
      ),
    );
  }
}

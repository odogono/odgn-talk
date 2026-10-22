// The Variables window (#1141): the Script Variables of a browsing Play
// Session, read-only. It keeps the last values it showed after the session
// ends, until the next one starts, as the Errors window keeps its list.
import { signal, type Signal } from '@preact/signals';
import { render } from 'preact';
import { byId } from './dom';
import {
  rowValues,
  summary,
  variableRows,
  type VariableRow,
  type VariableScript,
} from './variables';

/** The scripts shown, and how many times each row's value has changed. */
type Shown = {
  changes: ReadonlyMap<string, number>;
  ended: boolean;
  expanded: ReadonlySet<string>;
  scripts: readonly VariableScript[];
};

const Row = ({
  changes,
  onSelect,
  onToggle,
  row,
}: {
  changes: number;
  onSelect: (owner: number) => void;
  onToggle: (key: string) => void;
  row: VariableRow;
}) => {
  const indent = { paddingLeft: `${row.depth * 0.9 + 0.2}rem` };
  if (row.more !== undefined) {
    return (
      <li className="more" style={indent}>
        … {row.more} more
      </li>
    );
  }
  const value = row.value!;
  const owner = value.kind === 'object' && value.live ? value.owner : undefined;
  return (
    <li style={indent}>
      {row.expanded === undefined ? (
        <span className="name">{row.label}</span>
      ) : (
        <button
          aria-expanded={row.expanded}
          className="name toggle"
          onClick={() => onToggle(row.key)}
          type="button"
        >
          {row.expanded ? '▾' : '▸'} {row.label}
        </button>
      )}
      {/* Keyed by its change count, so each change restarts the highlight. */}
      <span className={changes ? 'value changed' : 'value'} key={changes}>
        {owner === undefined ? (
          summary(value)
        ) : (
          <button
            className="element"
            onClick={() => onSelect(owner)}
            title="Select this Element"
            type="button"
          >
            {summary(value)}
          </button>
        )}
      </span>
    </li>
  );
};

const VariablesPanel = ({
  onSelect,
  onToggle,
  shown,
}: {
  onSelect: (owner: number) => void;
  onToggle: (key: string) => void;
  shown: Signal<Shown>;
}) => {
  const { changes, ended, expanded, scripts } = shown.value;
  return (
    <>
      <p className="muted" hidden={scripts.length > 0} id="variables-empty">
        No Script Variables yet. They appear here while browsing.
      </p>
      <p
        className="muted"
        hidden={!ended || !scripts.length}
        id="variables-ended"
      >
        From the ended session.
      </p>
      {scripts.map(script => (
        <section className="variables-script" key={script.script}>
          <h3>{script.label}</h3>
          <ul>
            {variableRows(script, expanded).map(row => (
              <Row
                changes={changes.get(row.key) ?? 0}
                key={row.key}
                onSelect={onSelect}
                onToggle={onToggle}
                row={row}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
};

export class VariablesWindow {
  readonly #window = byId('variables-window');
  readonly #shown = signal<Shown>({
    changes: new Map(),
    ended: false,
    expanded: new Set(),
    scripts: [],
  });
  #values = new Map<string, string>();

  constructor(onSelect: (owner: number) => void) {
    render(
      <VariablesPanel
        onSelect={onSelect}
        onToggle={key => this.#toggle(key)}
        shown={this.#shown}
      />,
      byId('variables-panel'),
    );
  }

  get visible(): boolean {
    return !this.#window.hidden;
  }

  /** A new session: the last one's values go. */
  start(): void {
    this.#values = new Map();
    this.#shown.value = {
      ...this.#shown.value,
      changes: new Map(),
      ended: false,
      scripts: [],
    };
  }

  /** Keeps the values shown, marked as from the ended session. */
  end(): void {
    this.#shown.value = { ...this.#shown.value, ended: true };
  }

  /** Shows a refresh, counting a change for each row whose value differs. */
  update(scripts: readonly VariableScript[]): void {
    const values = rowValues(scripts);
    const changes = new Map(this.#shown.value.changes);
    for (const [key, value] of values) {
      const last = this.#values.get(key);
      if (last !== undefined && last !== value) {
        changes.set(key, (changes.get(key) ?? 0) + 1);
      }
    }
    this.#values = values;
    this.#shown.value = { ...this.#shown.value, changes, scripts };
  }

  #toggle(key: string): void {
    const expanded = new Set(this.#shown.value.expanded);
    if (!expanded.delete(key)) {
      expanded.add(key);
    }
    this.#shown.value = { ...this.#shown.value, expanded };
  }
}

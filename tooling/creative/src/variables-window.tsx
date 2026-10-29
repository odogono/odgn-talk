// The Variables window (#1141): the Script Variables of a browsing Play
// Session, read-only. It keeps the last values it showed after the session
// ends, until the next one starts, as the Errors window keeps its list.
// Its Watches (#1210) are kept across sessions of one Project, and are
// evaluated by the worker only while Play is paused (ADR 0129). A Run stopped
// at a Breakpoint shows its frames and their locals first (ADR 0147).
import { signal, type Signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { render } from 'preact';
import { byId } from './dom';
import { copySource } from './copy-source';
import { type FrameView, type StoppedRun } from './play-protocol';
import {
  rowValues,
  sourceOf,
  summary,
  variableRows,
  type VariableRow,
  type VariableScript,
  type VariableValue,
  type Watch,
  type WatchResult,
} from './variables';

/** A context a Watch can run in: a Message Box target of one session. */
export type WatchContext = { id: number; label: string; session: number };

/** A Watch as the window keeps it; its context may be from an ended session. */
type ShownWatch = { context?: WatchContext; id: number; text: string };

type Watching = {
  pageChanged: boolean;
  paused: boolean;
  results: ReadonlyMap<number, WatchResult>;
  session: number;
  targets: readonly WatchContext[];
  watches: readonly ShownWatch[];
};

/** The scripts shown, and how many times each row's value has changed. */
type Shown = {
  changes: ReadonlyMap<string, number>;
  ended: boolean;
  expanded: ReadonlySet<string>;
  scripts: readonly VariableScript[];
};

/** Copies a row's value as source, saying so in its title for a moment. */
const CopyButton = ({ label, source }: { label: string; source?: string }) => {
  const [said, setSaid] = useState<string | undefined>();
  return (
    <button
      aria-label={`Copy ${label} as source`}
      className="copy"
      onClick={() => {
        void copySource(source).then(text => {
          setSaid(text);
          setTimeout(() => setSaid(undefined), 2000);
        });
      }}
      title={said ?? 'Copy as source'}
      type="button"
    >
      {said === undefined ? '⧉' : source === undefined ? 'no source form' : '✓'}
    </button>
  );
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
      <CopyButton label={row.label} source={sourceOf(value)} />
    </li>
  );
};

/**
 * One value's rows, as `:inspect` shows them (ADR 0141), with lists and maps
 * opened here rather than in the window's shared state.
 */
const ValueRows = ({
  name,
  onSelect,
  value,
}: {
  name: string;
  onSelect: (owner: number) => void;
  value: VariableValue;
}) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (!next.delete(key)) {
      next.add(key);
    }
    setExpanded(next);
  };
  return (
    <ul className="value-rows">
      {variableRows(
        { label: '', script: 'inspect', vars: [[name, value]] },
        expanded,
      ).map(row => (
        <Row
          changes={0}
          key={row.key}
          onSelect={onSelect}
          onToggle={toggle}
          row={row}
        />
      ))}
    </ul>
  );
};

/** Draws an inspected value's rows into `parent`, as the Message Box does. */
export const renderValueRows = (
  parent: Element,
  name: string,
  value: VariableValue,
  onSelect: (owner: number) => void,
): void => {
  render(<ValueRows name={name} onSelect={onSelect} value={value} />, parent);
};

/**
 * The Message Box's last `:inspect`, where it ran, and how its Elements are
 * selected, since an Edit result places them in the Project as it was then.
 */
type Inspected = {
  context: string;
  id: number;
  onSelect: (owner: number) => void;
  text: string;
  value: VariableValue;
};

const InspectedSection = ({
  inspected,
}: {
  inspected: Signal<Inspected | undefined>;
}) => {
  const shown = inspected.value;
  return shown ? (
    <section className="variables-script variables-inspected">
      <h3>Inspected · {shown.context}</h3>
      {/* Keyed by inspection, so each one starts closed. */}
      <ValueRows
        key={shown.id}
        name={shown.text}
        onSelect={shown.onSelect}
        value={shown.value}
      />
    </section>
  ) : null;
};

/**
 * A stopped Run's frames, innermost first. Clicking one selects it, as the
 * context Watches and the Message Box run in, and opens its line.
 */
const StoppedSection = ({
  expanded,
  onFrame,
  onSelect,
  onToggle,
  selected,
  stopped,
}: {
  expanded: ReadonlySet<string>;
  onFrame: (frame: FrameView, index: number) => void;
  onSelect: (owner: number) => void;
  onToggle: (key: string) => void;
  selected: Signal<number>;
  stopped: Signal<StoppedRun | undefined>;
}) => {
  const run = stopped.value;
  return run ? (
    <section className="variables-stopped">
      <h3>Stopped at a Breakpoint</h3>
      {run.frames.map((frame, index) => (
        <section
          aria-current={index === selected.value ? 'true' : undefined}
          className="variables-script variables-frame"
          key={index}
        >
          <h4>
            <button
              onClick={() => onFrame(frame, index)}
              title="Run Watches and the Message Box here, and show this line"
              type="button"
            >
              {frame.label} · line {frame.line}
            </button>
          </h4>
          <ul>
            {variableRows(
              {
                label: frame.label,
                script: `frame:${run.run}:${index}`,
                vars: frame.locals,
              },
              expanded,
            ).map(row => (
              <Row
                changes={0}
                key={row.key}
                onSelect={onSelect}
                onToggle={onToggle}
                row={row}
              />
            ))}
          </ul>
          {frame.locals.length ? null : <p className="muted">No locals.</p>}
        </section>
      ))}
    </section>
  ) : null;
};

const contextValue = (context: WatchContext | undefined) =>
  context ? `${context.session}:${context.id}` : 'default';

const ContextSelect = ({
  context,
  label,
  onChange,
  session,
  targets,
}: {
  context?: WatchContext;
  label: string;
  onChange: (context: WatchContext | undefined) => void;
  session: number;
  targets: readonly WatchContext[];
}) => {
  const stale =
    context &&
    (context.session !== session ||
      !targets.some(target => target.id === context.id));
  return (
    <select
      aria-label={label}
      onChange={event => {
        const value = (event.target as HTMLSelectElement).value;
        onChange(targets.find(target => contextValue(target) === value));
      }}
      value={contextValue(context)}
    >
      <option value="default">Default context</option>
      {targets.map(target => (
        <option key={target.id} value={contextValue(target)}>
          {target.label}
        </option>
      ))}
      {stale && (
        <option value={contextValue(context)}>
          {context.label} (unavailable)
        </option>
      )}
    </select>
  );
};

const WatchRow = ({
  changes,
  expanded,
  onContext,
  onRemove,
  onSelect,
  onToggle,
  result,
  session,
  targets,
  watch,
}: {
  changes: ReadonlyMap<string, number>;
  expanded: ReadonlySet<string>;
  onContext: (context: WatchContext | undefined) => void;
  onRemove: () => void;
  onSelect: (owner: number) => void;
  onToggle: (key: string) => void;
  result?: WatchResult;
  session: number;
  targets: readonly WatchContext[];
  watch: ShownWatch;
}) => {
  const rows =
    result?.state === 'value'
      ? variableRows(
          {
            label: '',
            script: `watch:${watch.id}`,
            vars: [[watch.text, result.value]],
          },
          expanded,
        )
      : [];
  return (
    <li className="watch">
      <div className="watch-head">
        <ContextSelect
          context={watch.context}
          label={`Context of ${watch.text}`}
          onChange={onContext}
          session={session}
          targets={targets}
        />
        <button
          aria-label={`Remove ${watch.text}`}
          className="remove"
          onClick={onRemove}
          type="button"
        >
          ×
        </button>
      </div>
      {result?.state === 'value' ? (
        <ul>
          {rows.map(row => (
            <Row
              changes={changes.get(row.key) ?? 0}
              key={row.key}
              onSelect={onSelect}
              onToggle={onToggle}
              row={row}
            />
          ))}
        </ul>
      ) : (
        <div className="watch-status">
          <span className="name">{watch.text}</span>{' '}
          <span className={result?.state === 'error' ? 'value error' : 'value'}>
            {result === undefined
              ? '—'
              : result.state === 'waiting'
                ? '(waiting)'
                : result.state === 'unavailable'
                  ? '(unavailable)'
                  : result.error}
          </span>
        </div>
      )}
      {result?.state === 'value' && result.effects && (
        <p className="watch-effects">⚠ This Watch sent a message.</p>
      )}
    </li>
  );
};

const WatchesSection = ({
  changes,
  expanded,
  onSelect,
  onToggle,
  update,
  watching,
}: {
  changes: ReadonlyMap<string, number>;
  expanded: ReadonlySet<string>;
  onSelect: (owner: number) => void;
  onToggle: (key: string) => void;
  update: (change: (watches: readonly ShownWatch[]) => ShownWatch[]) => void;
  watching: Signal<Watching>;
}) => {
  const { pageChanged, paused, results, session, targets, watches } =
    watching.value;
  const [context, setContext] = useState<WatchContext | undefined>();
  // Read from the form, which may be submitted before a re-render.
  const add = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.querySelector('input')!;
    const chosen = form.querySelector('select')!.value;
    const text = input.value.trim();
    if (text) {
      const added = {
        id: nextWatch++,
        text,
        context: targets.find(target => contextValue(target) === chosen),
      };
      update(all => [...all, added]);
      input.value = '';
    }
  };
  return (
    <section
      className={
        paused
          ? 'variables-script variables-watches'
          : 'variables-script variables-watches stale'
      }
    >
      <h3>Watches</h3>
      <form className="watch-add" onSubmit={add}>
        <input aria-label="Watch expression" placeholder="Expression" />
        <ContextSelect
          context={context}
          label="Watch context"
          onChange={setContext}
          session={session}
          targets={targets}
        />
        <button type="submit">Add</button>
      </form>
      <p className="muted" hidden={paused || !watches.length}>
        Watches update while Play is paused.
      </p>
      <p className="watch-effects" hidden={!pageChanged}>
        ⚠ A Watch changed the Page.
      </p>
      <ul>
        {watches.map(watch => (
          <WatchRow
            changes={changes}
            expanded={expanded}
            key={watch.id}
            onContext={next =>
              // A new id, so the worker treats it as a new Watch.
              update(all =>
                all.map(w =>
                  w.id === watch.id
                    ? { ...watch, id: nextWatch++, context: next }
                    : w,
                ),
              )
            }
            onRemove={() => update(all => all.filter(w => w.id !== watch.id))}
            onSelect={onSelect}
            onToggle={onToggle}
            result={results.get(watch.id)}
            session={session}
            targets={targets}
            watch={watch}
          />
        ))}
      </ul>
    </section>
  );
};

let nextWatch = 1;

const VariablesPanel = ({
  inspected,
  onFrame,
  onSelect,
  onToggle,
  selected,
  shown,
  stopped,
  update,
  watching,
}: {
  inspected: Signal<Inspected | undefined>;
  onFrame: (frame: FrameView, index: number) => void;
  onSelect: (owner: number) => void;
  onToggle: (key: string) => void;
  selected: Signal<number>;
  shown: Signal<Shown>;
  stopped: Signal<StoppedRun | undefined>;
  update: (change: (watches: readonly ShownWatch[]) => ShownWatch[]) => void;
  watching: Signal<Watching>;
}) => {
  const { changes, ended, expanded, scripts } = shown.value;
  return (
    <>
      <StoppedSection
        expanded={expanded}
        onFrame={onFrame}
        onSelect={onSelect}
        onToggle={onToggle}
        selected={selected}
        stopped={stopped}
      />
      <WatchesSection
        changes={changes}
        expanded={expanded}
        onSelect={onSelect}
        onToggle={onToggle}
        update={update}
        watching={watching}
      />
      <InspectedSection inspected={inspected} />
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
  readonly #watching = signal<Watching>({
    pageChanged: false,
    paused: false,
    results: new Map(),
    session: 0,
    targets: [],
    watches: [],
  });
  readonly #inspected = signal<Inspected | undefined>(undefined);
  readonly #stopped = signal<StoppedRun | undefined>(undefined);
  readonly #frame = signal(0);
  #inspections = 0;
  #values = new Map<string, string>();

  /**
   * `onWatches` hears each change to the list of Watches, and `onFrame` each
   * click on a stopped Run's frame.
   */
  constructor(
    onSelect: (owner: number) => void,
    private readonly onWatches: () => void = () => {},
    onFrame: (frame: FrameView, index: number) => void = () => {},
  ) {
    render(
      <VariablesPanel
        inspected={this.#inspected}
        onFrame={(frame, index) => {
          this.#frame.value = index;
          onFrame(frame, index);
        }}
        onSelect={onSelect}
        onToggle={key => this.#toggle(key)}
        selected={this.#frame}
        shown={this.#shown}
        stopped={this.#stopped}
        update={change => {
          const current = this.#watching.value;
          this.#watching.value = {
            ...current,
            watches: change(current.watches),
          };
          this.onWatches();
        }}
        watching={this.#watching}
      />,
      byId('variables-panel'),
    );
  }

  /**
   * The Watches as the worker runs them in `session`: a context from another
   * session, or one no longer loaded, is sent as one that cannot be found.
   */
  watchesFor(session: number): Watch[] {
    const { targets, watches } = this.#watching.value;
    return watches.map(({ context, id, text }) => ({
      id,
      text,
      ...(context === undefined
        ? {}
        : {
            target:
              context.session === session &&
              targets.some(target => target.id === context.id)
                ? context.id
                : -1,
          }),
    }));
  }

  /** The browsing session's loaded contexts, and whether it is paused. */
  context(
    session: number,
    targets: readonly { id: number; label: string }[],
    paused: boolean,
  ): void {
    const current = this.#watching.value;
    if (
      current.session === session &&
      current.paused === paused &&
      current.targets.map(t => t.id).join() === targets.map(t => t.id).join()
    ) {
      return;
    }
    this.#watching.value = {
      ...current,
      session,
      paused,
      targets: targets.map(({ id, label }) => ({ id, label, session })),
    };
  }

  /** Shows the worker's Watch results. */
  watchResults(results: readonly WatchResult[], pageChanged?: boolean): void {
    const current = this.#watching.value;
    const shown = new Map(current.results);
    for (const result of results) {
      shown.set(result.id, result);
    }
    const values = new Map(this.#values);
    const changes = new Map(this.#shown.value.changes);
    for (const result of results) {
      const watch = current.watches.find(w => w.id === result.id);
      if (result.state !== 'value' || !watch) {
        continue;
      }
      for (const [key, value] of rowValues([
        {
          label: '',
          script: `watch:${watch.id}`,
          vars: [[watch.text, result.value]],
        },
      ])) {
        const last = values.get(key);
        if (last !== undefined && last !== value) {
          changes.set(key, (changes.get(key) ?? 0) + 1);
        }
        values.set(key, value);
      }
    }
    this.#values = values;
    this.#shown.value = { ...this.#shown.value, changes };
    this.#watching.value = {
      ...current,
      results: shown,
      ...(pageChanged === undefined ? {} : { pageChanged }),
    };
  }

  /** Shows the Message Box's latest `:inspect` result. */
  inspect(
    text: string,
    value: VariableValue,
    context: string,
    onSelect: (owner: number) => void,
  ): void {
    this.#inspected.value = {
      id: ++this.#inspections,
      text,
      value,
      context,
      onSelect,
    };
  }

  /** Another Project: its Watches and inspected value go. */
  clearWatches(): void {
    this.#inspected.value = undefined;
    this.#watching.value = {
      ...this.#watching.value,
      pageChanged: false,
      results: new Map(),
      watches: [],
    };
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
    this.#stopped.value = undefined;
  }

  /** Shows the Run a Breakpoint stopped, or that none is. */
  stoppedRun(run: StoppedRun | undefined): void {
    if (JSON.stringify(run) !== JSON.stringify(this.#stopped.value)) {
      // Another Run's stop starts at its innermost frame, as the worker's does.
      if (run?.run !== this.#stopped.value?.run) {
        this.#frame.value = 0;
      }
      this.#stopped.value = run;
    }
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
    // Watch rows keep their values across Script Variable refreshes.
    for (const [key, value] of this.#values) {
      if (key.startsWith('["watch:')) {
        values.set(key, value);
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

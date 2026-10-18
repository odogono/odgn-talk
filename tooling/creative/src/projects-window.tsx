/** @jsxImportSource preact */
// The pragma lets `bun test` from the repo root, which imports projects.ts,
// compile this file without Folio's tsconfig.
import type { ReadonlySignal } from '@preact/signals';
import { render } from 'preact';
import { useRef } from 'preact/hooks';
import type { ExampleProject } from './examples';
import type { ProjectRecord, VersionInfo } from './storage';

const when = (time: number): string => new Date(time).toLocaleString();

/**
 * What the Projects and Earlier Versions lists show. `projects.ts` loads
 * the records and versions from storage and keeps the rest current.
 */
export type ProjectsWindowState = {
  confirmingDeleteId: ReadonlySignal<string | undefined>;
  currentId: ReadonlySignal<string>;
  /** Whether this tab holds the edit lock. */
  editing: ReadonlySignal<boolean>;
  /** The current Project was deleted in another tab. */
  orphaned: ReadonlySignal<boolean>;
  /** The version on the desk, while previewing one. */
  previewSeq: ReadonlySignal<number | undefined>;
  records: ReadonlySignal<readonly ProjectRecord[]>;
  renamingId: ReadonlySignal<string | undefined>;
  /** False when the browser keeps nothing; the lists say so. */
  stored: boolean;
  versions: ReadonlySignal<readonly VersionInfo[]>;
};

export type ProjectsWindowActions = {
  /** Back to the latest version from a preview. */
  backToLatest: () => void;
  /** Puts back Delete after its confirmation, or closes a rename field. */
  cancel: () => void;
  /** Asks to confirm deleting a Project. */
  confirmDelete: (id: string) => void;
  delete: (id: string) => void;
  duplicate: (id: string) => void;
  open: (id: string) => void;
  openExample: (example: ExampleProject) => void;
  previewVersion: (version: VersionInfo) => void;
  rename: (id: string, title: string) => void;
  /** Shows a rename field in place of the Project's row. */
  startRename: (id: string) => void;
};

type Props = { actions: ProjectsWindowActions; state: ProjectsWindowState };

const RenameRow = ({
  actions,
  item,
}: {
  actions: ProjectsWindowActions;
  item: ProjectRecord;
}) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      {/* defaultValue: a redraw of the list keeps what the author typed. */}
      <input aria-label="Project name" defaultValue={item.title} ref={input} />
      <button
        onClick={() => actions.rename(item.id, input.current!.value)}
        type="button"
      >
        Save
      </button>
      <button onClick={actions.cancel} type="button">
        Cancel
      </button>
    </>
  );
};

const ProjectRow = ({
  actions,
  item,
  state,
}: Props & { item: ProjectRecord }) => {
  const current = item.id === state.currentId.value;
  const lockedHere = current && !state.editing.value;
  return (
    <>
      <span className={current ? 'title current' : 'title'}>
        {`${item.title} `}
        <span className="muted">{when(item.modifiedAt)}</span>
      </span>
      {current ? null : (
        <button onClick={() => actions.open(item.id)} type="button">
          Open
        </button>
      )}
      <button
        disabled={lockedHere}
        onClick={() => actions.startRename(item.id)}
        type="button"
      >
        Rename
      </button>
      <button onClick={() => actions.duplicate(item.id)} type="button">
        Duplicate
      </button>
      {state.confirmingDeleteId.value === item.id ? (
        <>
          <button onClick={() => actions.delete(item.id)} type="button">
            Delete this Project?
          </button>
          <button onClick={actions.cancel} type="button">
            Keep
          </button>
        </>
      ) : (
        <button
          disabled={lockedHere}
          onClick={() => actions.confirmDelete(item.id)}
          type="button"
        >
          Delete
        </button>
      )}
    </>
  );
};

const ProjectList = (props: Props) => {
  const { state } = props;
  if (!state.stored) {
    return <li>{"Projects can't be kept in this browser."}</li>;
  }
  return (
    <>
      {state.records.value.map(item => (
        <li key={item.id}>
          {state.renamingId.value === item.id ? (
            <RenameRow actions={props.actions} item={item} />
          ) : (
            <ProjectRow {...props} item={item} />
          )}
        </li>
      ))}
    </>
  );
};

const VersionList = ({ actions, state }: Props) => {
  if (!state.stored || state.orphaned.value) {
    return <li>No earlier versions are kept.</li>;
  }
  const previewSeq = state.previewSeq.value;
  const previewing = previewSeq !== undefined;
  return (
    <>
      {state.versions.value.map((version, index) => {
        const viewing = previewSeq === version.seq;
        const pages = `${version.pageCount} Page${version.pageCount === 1 ? '' : 's'}`;
        return (
          <li key={version.seq}>
            <span className="when">
              {`${when(version.savedAt)} `}
              <span className="muted">
                {`${pages}${index === 0 ? ' · latest' : ''}`}
              </span>
            </span>
            <button
              disabled={viewing || (index === 0 && !previewing)}
              onClick={() =>
                index === 0 && previewing
                  ? actions.backToLatest()
                  : actions.previewVersion(version)
              }
              type="button"
            >
              {viewing ? 'Viewing' : 'Preview'}
            </button>
          </li>
        );
      })}
    </>
  );
};

const ExampleList = ({
  examples,
  openExample,
}: {
  examples: readonly ExampleProject[];
  openExample: (example: ExampleProject) => void;
}) => (
  <>
    {examples.map(example => (
      <li key={example.name}>
        <button
          data-example={example.name}
          onClick={() => openExample(example)}
          type="button"
        >
          {`Open ${example.name}`}
        </button>
        <span className="muted">{example.description}</span>
      </li>
    ))}
  </>
);

/**
 * Renders the Project list, the Earlier Versions list and the Example
 * Projects into their `<ul>`s. Each list follows its signals and updates
 * in place, so a rename field keeps its focus and typed text across redraws.
 */
export const mountProjectsWindow = (
  containers: {
    examples: HTMLElement;
    projects: HTMLElement;
    versions: HTMLElement;
  },
  options: {
    actions: ProjectsWindowActions;
    examples: readonly ExampleProject[];
    state: ProjectsWindowState;
  },
): (() => void) => {
  const { actions, examples, state } = options;
  render(<ProjectList actions={actions} state={state} />, containers.projects);
  render(<VersionList actions={actions} state={state} />, containers.versions);
  render(
    <ExampleList examples={examples} openExample={actions.openExample} />,
    containers.examples,
  );
  return () => {
    render(null, containers.projects);
    render(null, containers.versions);
    render(null, containers.examples);
  };
};

// The Code Browser's columns, after the Smalltalk System Browser: Sources,
// then the chosen Source's Scripts, then the shown Script's Handlers, over
// the source editor. They follow the authored hierarchy, independently of
// the canvas selection. The source editor remains a CodeMirror view.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeepReadonly } from './readonly';
import type {
  Element,
  Project,
  ProjectLibrary,
  ProjectTestScript,
} from './model';
import type { TestResult } from './test-runner';
import { showContextMenu } from './context-menu';
import {
  ownerById,
  ownerId,
  scriptPage,
  type ScriptOwner,
} from './script-manifest';

export type CodeSelection = {
  id: number;
  kind: 'script' | 'library' | 'test';
};
/** A named source the Code Browser can rename and delete. */
export type NamedSource =
  | { kind: 'library'; source: DeepReadonly<ProjectLibrary> }
  | { kind: 'test'; source: DeepReadonly<ProjectTestScript> };
/** The last Run Tests, or that it is running. */
export type TestRun = { results: TestResult[] } | 'running' | undefined;
export const sourceKey = (source: CodeSelection): string =>
  `${source.kind}:${source.id}`;

type Props = {
  /** The shown Script's Handlers, in source order. */
  handlers: { line: number; name: string }[];
  named?: NamedSource;
  onDelete(): void;
  onNew(kind: NamedSource['kind']): void;
  onOpenLine(line: number): void;
  onOpenResult(result: TestResult): void;
  onRename(name: string): string | undefined;
  onRunTests(): void;
  onSelect(source: CodeSelection): void;
  project: DeepReadonly<Project>;
  readOnly: boolean;
  selected: CodeSelection;
  tests: TestRun;
};

const LABELS = { library: 'Library', test: 'Test Script' } as const;

// The first column's entries: the Project, each Page, Libraries and Tests.
type Group = 'project' | 'libraries' | 'tests' | number;
const groupOf = (
  project: DeepReadonly<Project>,
  selected: CodeSelection,
): Group => {
  if (selected.kind === 'library') {
    return 'libraries';
  }
  if (selected.kind === 'test') {
    return 'tests';
  }
  const owner = ownerById(project, selected.id);
  return (
    (owner && owner !== project && scriptPage(project, owner)?.id) || 'project'
  );
};

// Each Element with its Group path, so a Group's members follow it.
const allMembers = (
  nodes: readonly DeepReadonly<Element>[],
  path: string[] = [],
): { element: DeepReadonly<Element>; path: string[] }[] =>
  nodes.flatMap(element => [
    { element, path },
    ...(element.kind === 'group'
      ? allMembers(element.members, [...path, element.name])
      : []),
  ]);

const script = (owner: ScriptOwner): CodeSelection => ({
  kind: 'script',
  id: ownerId(owner),
});

const Column = ({
  children,
  footer,
  title,
}: {
  children: preact.ComponentChildren;
  footer?: preact.ComponentChildren;
  title: preact.ComponentChildren;
}) => (
  <section
    aria-label={typeof title === 'string' ? title : undefined}
    className="browser-column"
  >
    <h3>{title}</h3>
    <ul>{children}</ul>
    {footer && <div className="browser-column-footer">{footer}</div>}
  </section>
);

const Item = ({
  current,
  label,
  onContextMenu,
  onDblClick,
  onSelect,
  title,
}: {
  current: boolean;
  label: preact.ComponentChildren;
  onContextMenu?(event: MouseEvent): void;
  onDblClick?(): void;
  onSelect(): void;
  title?: string;
}) => (
  <li>
    <button
      aria-current={current ? 'true' : undefined}
      // A second click of a double-click renames.
      onClick={event =>
        event.detail === 2 && onDblClick ? onDblClick() : onSelect()
      }
      onContextMenu={onContextMenu}
      title={title}
      type="button"
    >
      {label}
    </button>
  </li>
);

// Renames the selected Library or Test Script in place; Enter or leaving
// the field commits, Escape cancels.
const RenameField = ({
  initial,
  label,
  onDone,
  onRename,
}: {
  initial: string;
  label: string;
  onDone(): void;
  onRename(name: string): string | undefined;
}) => {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = () => {
    const problem = onRename(name.trim());
    if (problem) {
      setError(problem);
    } else {
      onDone();
    }
  };
  return (
    <li className="rename">
      <input
        aria-label={label}
        onBlur={commit}
        onInput={event => setName(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onDone();
          }
        }}
        ref={input}
        value={name}
      />
      {error && <span role="status">{error}</span>}
    </li>
  );
};

const Columns = (props: Props) => {
  const { project, selected, onSelect } = props;
  // Libraries or Tests chosen while they have no source to show.
  const [emptyGroup, setEmptyGroup] = useState<'libraries' | 'tests'>();
  const [renaming, setRenaming] = useState<string>();
  const group = emptyGroup ?? groupOf(project, selected);
  const choose = (source: CodeSelection) => {
    setEmptyGroup(undefined);
    onSelect(source);
  };
  const isSelected = (source: CodeSelection) =>
    !emptyGroup && sourceKey(source) === sourceKey(selected);
  const openGroup = (next: Group) => {
    if (next === 'libraries' || next === 'tests') {
      const first = (
        next === 'libraries' ? project.libraries : project.testScripts
      )[0];
      if (first) {
        choose({
          kind: next === 'libraries' ? 'library' : 'test',
          id: first.id!,
        });
      } else {
        setEmptyGroup(next);
      }
    } else if (next === 'project') {
      choose(script(project));
    } else {
      choose({ kind: 'script', id: next });
    }
  };

  const sources = (
    <Column title="Sources">
      <Item
        current={group === 'project'}
        label={`Project: ${project.name}`}
        onSelect={() => openGroup('project')}
      />
      {project.pages.map(page => (
        <Item
          current={group === page.id}
          key={page.id}
          label={`Page: ${page.name}`}
          onSelect={() => openGroup(page.id!)}
        />
      ))}
      <Item
        current={group === 'libraries'}
        label="Libraries"
        onSelect={() => openGroup('libraries')}
      />
      <Item
        current={group === 'tests'}
        label="Tests"
        onSelect={() => openGroup('tests')}
      />
    </Column>
  );

  const named = (kind: NamedSource['kind']) => {
    const list = kind === 'library' ? project.libraries : project.testScripts;
    return (
      <Column
        footer={
          <>
            <button
              disabled={props.readOnly}
              onClick={() => {
                setEmptyGroup(undefined);
                props.onNew(kind);
              }}
              title={`New ${LABELS[kind]}`}
              type="button"
            >
              + New {LABELS[kind]}
            </button>
            {kind === 'test' && (
              <button
                disabled={!list.length || props.tests === 'running'}
                onClick={props.onRunTests}
                type="button"
              >
                Run Tests
              </button>
            )}
          </>
        }
        title={kind === 'library' ? 'Libraries' : 'Test Scripts'}
      >
        {list.map(source => {
          const selection = { kind, id: source.id! };
          return renaming === sourceKey(selection) &&
            props.named?.source.id === source.id ? (
            <RenameField
              initial={source.name}
              key={source.id}
              label={`${LABELS[kind]} name`}
              onDone={() => setRenaming(undefined)}
              onRename={props.onRename}
            />
          ) : (
            <Item
              current={isSelected(selection)}
              key={source.id}
              label={source.name}
              onContextMenu={event => {
                event.preventDefault();
                choose(selection);
                showContextMenu(event.clientX, event.clientY, [
                  {
                    label: 'Rename',
                    disabled: props.readOnly,
                    run: () => setRenaming(sourceKey(selection)),
                  },
                  {
                    label: `Delete ${LABELS[kind]}`,
                    disabled: props.readOnly,
                    run: props.onDelete,
                  },
                ]);
              }}
              onDblClick={() => {
                if (!props.readOnly) {
                  setRenaming(sourceKey(selection));
                }
              }}
              onSelect={() => choose(selection)}
              title="Double-click to rename; right-click for more"
            />
          );
        })}
      </Column>
    );
  };

  let scripts;
  if (group === 'libraries') {
    scripts = named('library');
  } else if (group === 'tests') {
    scripts = named('test');
  } else if (group === 'project') {
    scripts = (
      <Column title="Scripts">
        <Item
          current={isSelected(script(project))}
          label="Project Script"
          onSelect={() => choose(script(project))}
        />
      </Column>
    );
  } else {
    const page = project.pages.find(p => p.id === group)!;
    scripts = (
      <Column title="Scripts">
        <Item
          current={isSelected(script(page))}
          label="Page Script"
          onSelect={() => choose(script(page))}
        />
        {allMembers(page.elements).map(({ element, path }) => (
          <Item
            current={isSelected(script(element))}
            key={element.id}
            label={
              <>
                {path.length > 0 && (
                  <span className="path">{path.join(' › ')} › </span>
                )}
                {element.name}
              </>
            }
            onSelect={() => choose(script(element))}
            title={element.kind}
          />
        ))}
      </Column>
    );
  }

  const handlers = (
    <Column title="Handlers">
      {!emptyGroup &&
        props.handlers.map(handler => (
          <Item
            current={false}
            key={`${handler.name}:${handler.line}`}
            label={`on ${handler.name}`}
            onSelect={() => props.onOpenLine(handler.line)}
          />
        ))}
    </Column>
  );

  return (
    <>
      <nav aria-label="Project code" className="browser-columns">
        {sources}
        {scripts}
        {handlers}
      </nav>
      <TestResults {...props} />
    </>
  );
};

// Each Test Handler's result; a failure opens its line.
const TestResults = ({ tests, onOpenResult }: Props) => {
  if (tests === undefined) {
    return null;
  }
  if (tests === 'running') {
    return (
      <p className="test-results" role="status">
        Running tests…
      </p>
    );
  }
  const failed = tests.results.filter(r => !r.ok).length;
  return (
    <section aria-label="Test results" className="test-results">
      <p role="status">
        {tests.results.length
          ? `${tests.results.length - failed} passed, ${failed} failed`
          : 'No Test Handlers found'}
      </p>
      <ul>
        {tests.results.map(result => (
          <li
            className={result.ok ? 'passed' : 'failed'}
            key={`${result.script.id}:${result.test}`}
          >
            <button onClick={() => onOpenResult(result)} type="button">
              {result.ok ? '✓' : '✗'} {result.script.name}{' '}
              {result.test || `line ${result.at.line}`}
            </button>
            {result.problems.length > 0 && (
              <pre>{result.problems.join('\n')}</pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

export const renderCodeOutline = (parent: HTMLElement, props: Props): void => {
  render(<Columns {...props} />, parent);
};

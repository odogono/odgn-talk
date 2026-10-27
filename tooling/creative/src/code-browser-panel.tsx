// The browser's outline follows the authored hierarchy, independently of
// the canvas selection. The source editor remains a CodeMirror view.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { DeepReadonly } from './readonly';
import type {
  Element,
  Project,
  ProjectLibrary,
  ProjectTestScript,
} from './model';
import type { TestResult } from './test-runner';
import { ownerId, type ScriptOwner } from './script-manifest';

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
  named?: NamedSource;
  onDelete(): void;
  onNew(kind: NamedSource['kind']): void;
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

const SourceName = ({
  named,
  onRename,
  readOnly,
}: Pick<Props, 'named' | 'onRename' | 'readOnly'>) => {
  const [name, setName] = useState(named?.source.name ?? '');
  const [error, setError] = useState('');
  useEffect(() => {
    setName(named?.source.name ?? '');
    setError('');
  }, [named?.source.name]);
  if (!named) {
    return null;
  }
  const rename = () => setError(onRename(name.trim()) ?? '');
  const label = `${LABELS[named.kind]} name`;
  return (
    <div className="library-name">
      <label>
        {label}
        <input
          aria-label={label}
          disabled={readOnly}
          onBlur={rename}
          onInput={event => setName(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              rename();
            }
          }}
          value={name}
        />
      </label>
      <span role="status">{error}</span>
    </div>
  );
};

const Outline = (props: Props) => {
  const { project, selected, onSelect } = props;
  const sourceButton = (source: CodeSelection, label: string) => (
    <button
      aria-current={
        sourceKey(source) === sourceKey(selected) ? 'true' : undefined
      }
      onClick={() => onSelect(source)}
      type="button"
    >
      {label}
    </button>
  );
  const scriptButton = (owner: ScriptOwner, label: string) =>
    sourceButton({ kind: 'script', id: ownerId(owner) }, label);
  const elements = (nodes: readonly DeepReadonly<Element>[]) => (
    <ul>
      {nodes.map(node => (
        <li key={node.id}>
          {scriptButton(node, `${node.kind}: ${node.name}`)}
          {node.kind === 'group' && elements(node.members)}
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <nav aria-label="Project code">
        <ul>
          <li>
            {scriptButton(project, `Project: ${project.name}`)}
            <ul>
              {project.pages.map(page => (
                <li key={page.id}>
                  {scriptButton(page, `Page: ${page.name}`)}
                  {elements(page.elements)}
                </li>
              ))}
            </ul>
          </li>
        </ul>
        <h3>Libraries</h3>
        <ul>
          {project.libraries.map(library => (
            <li key={library.id}>
              {sourceButton({ kind: 'library', id: library.id! }, library.name)}
            </li>
          ))}
        </ul>
        <h3>Tests</h3>
        <ul>
          {project.testScripts.map(script => (
            <li key={script.id}>
              {sourceButton({ kind: 'test', id: script.id! }, script.name)}
            </li>
          ))}
        </ul>
      </nav>
      <div className="library-actions">
        <button
          disabled={props.readOnly}
          onClick={() => props.onNew('library')}
          type="button"
        >
          New Library
        </button>
        <button
          disabled={props.readOnly}
          onClick={() => props.onNew('test')}
          type="button"
        >
          New Test Script
        </button>
        <button
          disabled={props.readOnly || !props.named}
          onClick={props.onDelete}
          type="button"
        >
          Delete {LABELS[props.named?.kind ?? 'library']}
        </button>
        <button
          disabled={!project.testScripts.length || props.tests === 'running'}
          onClick={props.onRunTests}
          type="button"
        >
          Run Tests
        </button>
      </div>
      <SourceName key={sourceKey(selected)} {...props} />
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
  render(<Outline {...props} />, parent);
};

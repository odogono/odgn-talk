// The browser's outline follows the authored hierarchy, independently of
// the canvas selection. The source editor remains a CodeMirror view.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { DeepReadonly } from './readonly';
import type { Element, Project, ProjectLibrary } from './model';
import { ownerId, type ScriptOwner } from './script-manifest';

export type CodeSelection = { id: number; kind: 'script' | 'library' };
export const sourceKey = (source: CodeSelection): string =>
  `${source.kind}:${source.id}`;

type Props = {
  library?: DeepReadonly<ProjectLibrary>;
  onDelete(): void;
  onNew(): void;
  onRename(name: string): string | undefined;
  onSelect(source: CodeSelection): void;
  project: DeepReadonly<Project>;
  readOnly: boolean;
  selected: CodeSelection;
};

const LibraryName = ({
  library,
  onRename,
  readOnly,
}: Pick<Props, 'library' | 'onRename' | 'readOnly'>) => {
  const [name, setName] = useState(library?.name ?? '');
  const [error, setError] = useState('');
  useEffect(() => {
    setName(library?.name ?? '');
    setError('');
  }, [library?.name]);
  if (!library) {
    return null;
  }
  const rename = () => setError(onRename(name.trim()) ?? '');
  return (
    <div className="library-name">
      <label>
        Library name
        <input
          aria-label="Library name"
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
      </nav>
      <div className="library-actions">
        <button disabled={props.readOnly} onClick={props.onNew} type="button">
          New Library
        </button>
        <button
          disabled={props.readOnly || !props.library}
          onClick={props.onDelete}
          type="button"
        >
          Delete Library
        </button>
      </div>
      <LibraryName key={props.library?.id} {...props} />
    </>
  );
};

export const renderCodeOutline = (parent: HTMLElement, props: Props): void => {
  render(<Outline {...props} />, parent);
};

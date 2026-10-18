import type { EditorView } from '@codemirror/view';
import type { Immutable } from 'immer';
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Project } from './model';
import {
  recipeEdit,
  recipePlacement,
  recipeSource,
  recipeTargets,
  SOUND_RECIPE_KINDS,
  type RecipeKind,
  type RecipePlacement,
  type RecipeTarget,
} from './recipes';
import type { ScriptOwner } from './script-manifest';
import { scriptNameProblems } from './script-names';

const ACTIONS = [
  'navigate',
  'show',
  'hide',
  'text',
  'playSound',
  'loopSound',
  'stopSound',
] as const;

const ACTION_NAMES: Record<(typeof ACTIONS)[number], string> = {
  navigate: 'Go to a Page',
  show: 'Show an Element',
  hide: 'Hide an Element',
  text: 'Change text',
  playSound: 'Play a sound',
  loopSound: 'Loop a sound',
  stopSound: 'Stop a sound',
};

type Position = 'new' | 'start' | 'end' | 'cursor';

/** What the chosen action offers, read from the Script when it was chosen. */
type Setup = {
  action: RecipeKind;
  locked: boolean;
  placement: RecipePlacement['kind'];
  position: Position;
  target: string;
  targets: RecipeTarget[];
};

/** A previewed insertion, valid only for the source and targets it was made from. */
type Prepared = {
  from: number;
  insert: string;
  signature: string;
  source: string;
};

type PickerProps = {
  close: () => void;
  owner: ScriptOwner;
  project: Immutable<Project>;
  readOnly: () => boolean;
  view: EditorView;
};

const signatureOf = (
  project: Immutable<Project>,
  owner: ScriptOwner,
  action: RecipeKind,
) => JSON.stringify(recipeTargets(project, owner, action));

const RecipePicker = ({
  close,
  owner,
  project,
  readOnly,
  view,
}: PickerProps) => {
  const actions = ACTIONS.filter(
    value =>
      owner !== project ||
      value === 'navigate' ||
      SOUND_RECIPE_KINDS.includes(value),
  );
  // Choosing an action re-reads its targets and the Script's placement, and
  // resets the target, position and status, but keeps the typed text.
  const configure = (action: RecipeKind) => {
    const targets = recipeTargets(project, owner, action);
    const placement = recipePlacement(view.state.doc.toString()).kind;
    const target = Math.max(
      0,
      targets.findIndex(item => item.reference === 'me'),
    );
    return {
      setup: {
        action,
        locked: readOnly(),
        placement,
        position:
          placement === 'simple'
            ? action === 'navigate'
              ? 'end'
              : 'start'
            : placement,
        target: String(target),
        targets,
      } satisfies Setup,
      status: targets.length
        ? ''
        : SOUND_RECIPE_KINDS.includes(action)
          ? 'No sounds in this Project yet. Add one with Add sound… in Info when no Element is selected.'
          : 'There are no matching Elements on this Page.',
    };
  };
  const [initial] = useState(() => configure(actions[0]!));
  const [setup, setSetup] = useState<Setup>(initial.setup);
  const [status, setStatus] = useState(initial.status);
  const [text, setText] = useState('');
  const [prepared, setPrepared] = useState<Prepared>();
  const kind = useRef<HTMLSelectElement>(null);
  useLayoutEffect(() => kind.current?.focus(), []);

  const reconfigure = (action: RecipeKind) => {
    const next = configure(action);
    setPrepared(undefined);
    setSetup(next.setup);
    setStatus(next.status);
  };
  // Any input change invalidates the preview; the status is left as it was.
  const change = (patch: Partial<Pick<Setup, 'position' | 'target'>>) => {
    setPrepared(undefined);
    setSetup(current => ({ ...current, ...patch }));
  };

  const previewInsertion = () => {
    setPrepared(undefined);
    if (readOnly()) {
      return;
    }
    const chosen = recipeTargets(project, owner, setup.action)[
      Number(setup.target)
    ];
    if (!chosen) {
      reconfigure(setup.action);
      return;
    }
    try {
      const source = view.state.doc.toString();
      const edit = recipeEdit(
        source,
        recipeSource(setup.action, chosen, text),
        setup.position,
        view.state.selection.main.head,
      );
      setPrepared({
        source,
        ...edit,
        signature: signatureOf(project, owner, setup.action),
      });
      setStatus('Highlighted source will be inserted as one undoable edit.');
    } catch (error) {
      setStatus(String(error));
    }
  };

  const apply = () => {
    if (readOnly()) {
      return;
    }
    if (
      !prepared ||
      prepared.source !== view.state.doc.toString() ||
      prepared.signature !== signatureOf(project, owner, setup.action)
    ) {
      reconfigure(setup.action);
      setStatus(
        'The Script or targets changed. Choose a position and preview again.',
      );
      return;
    }
    const { from, insert } = prepared;
    close();
    view.dispatch({
      changes: { from, insert },
      selection: { anchor: from, head: from + insert.length },
      scrollIntoView: true,
    });
    view.focus();
  };

  const { action, placement } = setup;
  const guidance = [
    !('kind' in owner)
      ? 'This handler receives clicks passed up the Element → Page → Project Message Path.'
      : '',
    action === 'text'
      ? 'Replacing a text Element’s contents clears mixed formatting.'
      : '',
    SOUND_RECIPE_KINDS.includes(action)
      ? 'Sounds a Page or Element Script starts stop when the reader leaves that Page; sounds the Project Script starts keep playing.'
      : '',
    'Navigation stops the outgoing Page’s Scripts, so action order matters.',
    placement === 'simple'
      ? 'Choose a position, then preview the insertion.'
      : placement === 'cursor'
        ? 'This Script needs explicit placement. Put the cursor where the action belongs in a click handler, then choose Use current cursor and preview. No handler will be added.'
        : 'A new click handler will be created.',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="recipe-picker">
      <strong>When clicked…</strong>
      <label>
        Action
        <select
          aria-label="Action"
          onChange={event =>
            reconfigure(event.currentTarget.value as RecipeKind)
          }
          ref={kind}
          value={action}
        >
          {actions.map(value => (
            <option key={value} value={value}>
              {ACTION_NAMES[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target
        <select
          aria-label="Target"
          onChange={event => change({ target: event.currentTarget.value })}
          onInput={event => change({ target: event.currentTarget.value })}
          value={setup.target}
        >
          {setup.targets.map((item, index) => (
            <option key={index} value={String(index)}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label hidden={action !== 'text'}>
        New text
        <textarea
          aria-label="New text"
          onChange={() => setPrepared(undefined)}
          onInput={event => {
            setPrepared(undefined);
            setText(event.currentTarget.value);
          }}
          rows={2}
          value={text}
        />
      </label>
      <p className="muted">{guidance}</p>
      <label hidden={placement === 'new'}>
        Insert at
        <select
          aria-label="Insertion position"
          onChange={event =>
            change({ position: event.currentTarget.value as Position })
          }
          onInput={event =>
            change({ position: event.currentTarget.value as Position })
          }
          value={setup.position}
        >
          {placement === 'simple' ? (
            <>
              <option value="start">Start of handler</option>
              <option value="end">End of handler</option>
            </>
          ) : (
            <option value={placement}>
              {placement === 'new' ? 'New click handler' : 'Current cursor'}
            </option>
          )}
        </select>
      </label>
      <div className="row">
        <button
          disabled={!setup.targets.length || setup.locked}
          onClick={previewInsertion}
          type="button"
        >
          {placement === 'cursor'
            ? 'Use current cursor and preview'
            : 'Preview insertion'}
        </button>
        <button disabled={!prepared} onClick={apply} type="button">
          Insert action
        </button>
        <button onClick={close} type="button">
          Cancel
        </button>
      </div>
      <p role="status">{status}</p>
      <pre aria-label="Source preview" className="recipe-preview">
        {prepared && (
          <>
            {prepared.source.slice(0, prepared.from)}
            <mark>{prepared.insert}</mark>
            {prepared.source.slice(prepared.from)}
          </>
        )}
      </pre>
    </div>
  );
};

/** Closes any picker open in `parent`. */
export const closeRecipePicker = (parent: HTMLElement): void => {
  render(null, parent);
};

/** A disposable picker: no Recipe metadata is saved in the Project. */
export const openRecipePicker = (
  parent: HTMLElement,
  view: EditorView,
  project: Immutable<Project>,
  owner: ScriptOwner,
  readOnly: () => boolean,
): void => {
  // Each opening starts afresh rather than reconciling the last picker's state.
  closeRecipePicker(parent);
  const problems = scriptNameProblems(project);
  render(
    problems.length ? (
      <p role="status">{problems.map(p => p.message).join(' ')}</p>
    ) : (
      <RecipePicker
        close={() => closeRecipePicker(parent)}
        owner={owner}
        project={project}
        readOnly={readOnly}
        view={view}
      />
    ),
    parent,
  );
};

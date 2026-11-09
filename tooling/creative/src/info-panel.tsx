import { scriptMessages } from './script-messages';
import type { ReadonlySignal } from '@preact/signals';
import { Fragment, render } from 'preact';
import { useState } from 'preact/hooks';
import {
  labelSuggestion,
  MIN_PAGE_HEIGHT,
  MIN_PAGE_WIDTH,
  type NameCheck,
  type StackEditor,
} from './editing';
import {
  PAGE_ALIGNS_X,
  PAGE_ALIGNS_Y,
  pageCount,
  type Element,
  type Project,
} from './model';
import type { DeepReadonly } from './readonly';
import { bindableFields, bindingChoices, bindingProblem } from './bindings';
import { checkbox, color, field, input } from './elements/controls';
import { kindOf } from './elements/registry';
import { kindInfo } from './elements/views';

/** A refused name: what the author typed, and why it was refused. */
export type NameRefusal = {
  attempted: string;
  check: NameCheck & { ok: false };
};

type InfoProps = {
  editor: StackEditor;
  refusal: ReadonlySignal<NameRefusal | undefined>;
};

// Names commit on change, unlike the other live fields. Keep the typed draft
// through unrelated panel updates until the accepted name or refusal changes.
const NameField = ({
  current,
  disabled,
  offer,
  refused,
}: {
  current: string;
  disabled: boolean;
  offer?: string;
  refused: NameRefusal | undefined;
}) => {
  const shown = refused?.attempted ?? current;
  const [name, setName] = useState({ shown, draft: shown });
  if (name.shown !== shown) {
    setName({ shown, draft: shown });
  }
  const suggestion = refused?.check.suggestion ?? offer;
  return (
    <>
      {field(
        'Name',
        <input
          aria-describedby={refused ? 'name-problem' : undefined}
          aria-invalid={refused ? 'true' : undefined}
          autoComplete="off"
          data-field="name"
          disabled={disabled}
          onChange={event => {
            setName({ shown, draft: event.currentTarget.value.trim() });
          }}
          onInput={event => {
            setName({ shown, draft: event.currentTarget.value });
          }}
          spellcheck={false}
          type="text"
          value={name.shown === shown ? name.draft : shown}
        />,
      )}
      {refused && (
        <p className="problem" id="name-problem" role="alert">
          {refused.check.message}
        </p>
      )}
      {suggestion && (
        <p className="suggestion">
          {refused ? 'Try ' : 'Suggested from the label: '}
          <button data-rename={suggestion} disabled={disabled} type="button">
            {suggestion}
          </button>
        </p>
      )}
    </>
  );
};

/**
 * A control's binding menus (#1904): each field it lets bind, to tempo or
 * an Instrument parameter of its shape, or a meter to an output; with why a
 * binding can't apply, such as an Instrument that has gone.
 */
const BindingFields = ({
  disabled,
  element,
  project,
}: {
  disabled: boolean;
  element: DeepReadonly<Element>;
  project: DeepReadonly<Project>;
}) => {
  const { fields, output } = bindableFields(element);
  return (
    <>
      {fields.map(name => {
        const current = element.bindings?.[name];
        const choices = bindingChoices(project, element, name);
        const problem =
          current === undefined
            ? undefined
            : bindingProblem(project, element, name, current);
        return (
          <Fragment key={name}>
            {field(
              output
                ? 'Shows'
                : fields.length > 1
                  ? `Bind ${name} to`
                  : 'Bind to',
              <select
                data-binding={name}
                disabled={disabled}
                value={current ?? ''}
              >
                <option value="">Nothing</option>
                {current !== undefined &&
                  !choices.some(c => c.value === current) && (
                    <option value={current}>{current}</option>
                  )}
                {choices.map(choice => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>,
            )}
            {problem && <p className="muted">{problem}</p>}
          </Fragment>
        );
      })}
    </>
  );
};

// The messages the Script answers, by Handler Clause head (#2059).
const ScriptMessages = ({ source }: { source: string | undefined }) => {
  const heads = scriptMessages(source);
  return heads.length ? (
    <details className="script-messages">
      <summary>Messages ({heads.length})</summary>
      <ul>
        {heads.map((h, i) => (
          <li key={i}>
            <code>{h}</code>
          </li>
        ))}
      </ul>
    </details>
  ) : null;
};

const InfoPanel = ({ editor, refusal }: InfoProps) => {
  const { project, pageIndex } = editor.state.value;
  const page = editor.currentPage.value.page;
  const selected = editor.selectedElements.value;
  const disabled = editor.readOnly;
  const refused = refusal.value;
  const scriptButtons = (
    owner: 'page' | 'project' | 'element',
    label: string,
    source?: string,
  ) => (
    <>
      <ScriptMessages source={source} />
      <button data-script={owner} data-view-only="" type="button">
        {label}
      </button>
      <button
        data-recipe=""
        data-script={owner}
        disabled={disabled}
        type="button"
      >
        Add action…
      </button>
    </>
  );
  if (selected.length > 1) {
    return (
      <>
        <h2>{selected.length} Elements</h2>
        <p>{selected.map(element => element.name).join(', ')}</p>
        <p className="muted">Drag any of them to move them all.</p>
      </>
    );
  }
  const [element] = selected;
  if (element) {
    return (
      <Fragment key={element.id}>
        <h2>
          {kindOf(element).label} “{element.name}”
        </h2>
        {scriptButtons('element', 'Edit Script', element.script)}
        <NameField
          current={element.name}
          disabled={disabled}
          offer={labelSuggestion(page, element, project)}
          refused={refused}
        />
        <div className="grid">
          {(['left', 'top', 'width', 'height'] as const).map(key => (
            <Fragment key={key}>
              {field(
                key[0]!.toUpperCase() + key.slice(1),
                input(
                  key,
                  element[key],
                  disabled || !kindOf(element).properties[key]!.set,
                  'number',
                ),
              )}
            </Fragment>
          ))}
        </div>
        {kindInfo(element, disabled)}
        <BindingFields
          disabled={disabled}
          element={element}
          project={project}
        />
        {checkbox('visible', 'Visible', element.visible, disabled)}
      </Fragment>
    );
  }
  if (page.palette) {
    const first = pageCount(project);
    return (
      <Fragment key={page.id}>
        <h2>Palette “{page.name}”</h2>
        <NameField current={page.name} disabled={disabled} refused={refused} />
        {scriptButtons('page', 'Edit Palette Script', page.script)}
        {field(
          'Title',
          input('paletteTitle', page.palette.title ?? '', disabled, 'text', {
            placeholder: page.name,
          }),
        )}
        <div className="row">
          {field(
            'Width',
            input('paletteWidth', page.palette.width, disabled, 'number', {
              min: MIN_PAGE_WIDTH,
            }),
          )}
          {field(
            'Height',
            input('pageHeight', page.height, disabled, 'number', {
              min: MIN_PAGE_HEIGHT,
            }),
          )}
        </div>
        {field('Background', color('background', page.background, disabled))}
        {checkbox(
          'openOnPlay',
          'Open when Play starts',
          page.palette.openOnPlay,
          disabled,
        )}
        <div className="row">
          <button
            data-move-page={-1}
            disabled={disabled || pageIndex === first}
            type="button"
          >
            ← Earlier
          </button>
          <button
            data-move-page={1}
            disabled={disabled || pageIndex === project.pages.length - 1}
            type="button"
          >
            Later →
          </button>
        </div>
      </Fragment>
    );
  }
  return (
    <Fragment key={page.id}>
      <h2>
        Page {pageIndex + 1} of {pageCount(project)}
      </h2>
      <NameField current={page.name} disabled={disabled} refused={refused} />
      {scriptButtons('page', 'Edit Page Script', page.script)}
      <div className="row">
        {field(
          'Height',
          input('pageHeight', page.height, disabled, 'number', {
            min: MIN_PAGE_HEIGHT,
          }),
        )}
        {field('Background', color('background', page.background, disabled))}
      </div>
      <div className="row">
        {field(
          'Align across',
          <select
            data-field="alignX"
            disabled={disabled}
            value={page.alignX ?? 'center'}
          >
            {PAGE_ALIGNS_X.map(align => (
              <option key={align} value={align}>
                {align[0]!.toUpperCase() + align.slice(1)}
              </option>
            ))}
          </select>,
        )}
        {field(
          'Align down',
          <select
            data-field="alignY"
            disabled={disabled}
            value={page.alignY ?? 'center'}
          >
            {PAGE_ALIGNS_Y.map(align => (
              <option key={align} value={align}>
                {align[0]!.toUpperCase() + align.slice(1)}
              </option>
            ))}
          </select>,
        )}
      </div>
      <div className="row">
        <button
          data-move-page={-1}
          disabled={disabled || pageIndex === 0}
          type="button"
        >
          ← Earlier
        </button>
        <button
          data-move-page={1}
          disabled={disabled || pageIndex === pageCount(project) - 1}
          type="button"
        >
          Later →
        </button>
      </div>
      <h2>Project</h2>
      {scriptButtons('project', 'Edit Project Script', project.script)}
      {field('Title', input('projectName', project.name, disabled))}
      {field(
        'Design width',
        input('designWidth', project.designWidth, disabled, 'number', {
          min: MIN_PAGE_WIDTH,
        }),
      )}
      <p className="muted">
        Click an Element to select it; Shift-click selects several.
      </p>
    </Fragment>
  );
};

/** Mount once; Preact reconciles controls as editor and transient signals change. */
export const mountInfoPanel = (
  container: HTMLElement,
  props: InfoProps,
): (() => void) => {
  render(<InfoPanel {...props} />, container);
  return () => render(null, container);
};

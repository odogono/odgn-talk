import { KIT_SOUND_KEYS } from './kits/kits';
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
import { isSoundAsset } from './sounds';
import type { ParameterDefinition } from './instruments/kind';
import { INSTRUMENT_KINDS, instrumentKindNames } from './instruments/registry';
import { pageAddOns } from './add-ons/page';

/** `envelopePeriod` as `Envelope period`. */
const parameterLabel = (name: string): string => {
  const words = name.replaceAll(/([A-Z])/gu, ' $1').toLowerCase();
  return words[0]!.toUpperCase() + words.slice(1);
};

const parameterControl = (
  name: string,
  definition: ParameterDefinition,
  value: number | string | boolean | undefined,
  disabled: boolean,
) => {
  const common = {
    'data-parameter': name,
    disabled,
    title: definition.description,
  };
  switch (definition.shape) {
    case 'number':
      return field(
        parameterLabel(name),
        <input
          {...common}
          max={definition.max}
          min={definition.min}
          step={definition.whole ? 1 : 'any'}
          type="number"
          value={Number(value ?? definition.default)}
        />,
      );
    case 'text':
      return field(
        parameterLabel(name),
        <select {...common} value={String(value ?? definition.default)}>
          {definition.choices.map(choice => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>,
      );
    case 'boolean':
      return (
        <label className="check" title={definition.description}>
          <input
            {...common}
            checked={Boolean(value ?? definition.default)}
            type="checkbox"
          />
          {parameterLabel(name)}
        </label>
      );
  }
};

/** The Project's Instruments, each editable, and a way to add one (ADR 0158). */
const InstrumentsSection = ({
  editor,
  disabled,
}: {
  disabled: boolean;
  editor: StackEditor;
}) => {
  const { project } = editor.state.value;
  return (
    <>
      <h2>Instruments</h2>
      {project.instruments.length ? (
        project.instruments.map(instrument => {
          const kind = INSTRUMENT_KINDS.get(instrument.kind);
          return (
            <fieldset
              className="instrument"
              data-instrument={instrument.id}
              key={instrument.id}
            >
              <legend>
                {instrumentKindNames(instrument.kind).label}
                {kind ? '' : ' (Add-on not loaded)'} “{instrument.name}”
              </legend>
              {field(
                'Name',
                <input
                  autoComplete="off"
                  data-instrument-field="name"
                  disabled={disabled}
                  spellcheck={false}
                  type="text"
                  value={instrument.name}
                />,
              )}
              {kind && (
                <>
                  {field(
                    'Voices',
                    <input
                      data-instrument-field="voices"
                      disabled={disabled}
                      max={kind.maxVoices}
                      min={1}
                      step={1}
                      type="number"
                      value={instrument.voices}
                    />,
                  )}
                  {Object.entries(kind.parameters).map(([name, definition]) => (
                    <Fragment key={name}>
                      {parameterControl(
                        name,
                        definition,
                        instrument.parameters[name],
                        disabled,
                      )}
                    </Fragment>
                  ))}
                </>
              )}
              <button
                data-remove-instrument={instrument.id}
                disabled={disabled}
                type="button"
              >
                Remove {instrument.name}
              </button>
            </fieldset>
          );
        })
      ) : (
        <p className="muted">No Instruments yet.</p>
      )}
      <div className="row">
        <select
          aria-label="Instrument kind"
          data-new-instrument=""
          disabled={disabled}
        >
          {[
            ...[...INSTRUMENT_KINDS.keys()].map(kind => ({
              kind,
              label: instrumentKindNames(kind).label,
            })),
            // A built-in Add-on's kinds load when one is added (#1901).
            ...pageAddOns.catalogue.flatMap(entry =>
              (entry.instruments ?? [])
                .map(i => ({ kind: `${entry.id}#${i.name}`, label: i.label }))
                .filter(({ kind }) => !INSTRUMENT_KINDS.has(kind)),
            ),
          ].map(({ kind, label }) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
        <button data-add-instrument="" disabled={disabled} type="button">
          Add Instrument
        </button>
      </div>
      <p className="muted">
        Scripts play an Instrument by its name, like tell drums to play
        &quot;kick&quot;, and set its parameters, like set the cutoff of synth
        to 800.
      </p>
    </>
  );
};

/** A refused name: what the author typed, and why it was refused. */
export type NameRefusal = {
  attempted: string;
  check: NameCheck & { ok: false };
};

type InfoProps = {
  editor: StackEditor;
  previewName: ReadonlySignal<string | undefined>;
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

const InfoPanel = ({ editor, refusal, previewName }: InfoProps) => {
  const { project, pageIndex } = editor.state.value;
  const page = editor.currentPage.value.page;
  const selected = editor.selectedElements.value;
  const disabled = editor.readOnly;
  const refused = refusal.value;
  const preview = previewName.value;
  const scriptButtons = (
    owner: 'page' | 'project' | 'element',
    label: string,
  ) => (
    <>
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
        {scriptButtons('element', 'Edit Script')}
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
  const sounds = project.assets.filter(isSoundAsset);
  if (page.palette) {
    const first = pageCount(project);
    return (
      <Fragment key={page.id}>
        <h2>Palette “{page.name}”</h2>
        <NameField current={page.name} disabled={disabled} refused={refused} />
        {scriptButtons('page', 'Edit Palette Script')}
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
      {scriptButtons('page', 'Edit Page Script')}
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
      {scriptButtons('project', 'Edit Project Script')}
      {field('Title', input('projectName', project.name, disabled))}
      {field(
        'Design width',
        input('designWidth', project.designWidth, disabled, 'number', {
          min: MIN_PAGE_WIDTH,
        }),
      )}
      <h2>Sounds</h2>
      {sounds.length ? (
        sounds.map(asset => (
          <div className="row" key={asset.name}>
            <span>
              {asset.name} ({asset.fileName})
            </span>
            <button
              data-preview-sound={asset.name}
              data-view-only=""
              type="button"
            >
              {preview === asset.name ? 'Stop' : 'Preview'}
            </button>
          </div>
        ))
      ) : (
        <p className="muted">No sounds yet.</p>
      )}
      <button data-add-sound="" disabled={disabled} type="button">
        Add sound…
      </button>
      <select
        aria-label="Add Music Sound"
        data-add-music-sound=""
        disabled={disabled}
        value=""
      >
        <option value="">Add Music Sound…</option>
        {KIT_SOUND_KEYS.filter(
          key => !project.assets.some(a => a.name === key),
        ).map(key => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>
      <p className="muted">
        Scripts play a sound by its name, like tell sound to play
        &quot;waves&quot;. Add action… can write that for you.
      </p>
      <InstrumentsSection disabled={disabled} editor={editor} />
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

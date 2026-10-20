import type { DeepReadonly } from './readonly';
import type { ReadonlySignal } from '@preact/signals';
import { Fragment, render, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import {
  labelSuggestion,
  MIN_PAGE_HEIGHT,
  MIN_PAGE_WIDTH,
  type NameCheck,
  type StackEditor,
} from './editing';
import {
  BUTTON_STYLES,
  plainTextOf,
  TEXT_ALIGNS,
  textAlignOf,
  type Element,
  type ElementKind,
  type ButtonStyle,
  type TextAlign,
} from './model';
import { isSoundAsset } from './sounds';

export const KIND_NAMES: Record<ElementKind, string> = {
  text: 'Text',
  image: 'Image',
  button: 'Button',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  canvas: 'Canvas',
  group: 'Group',
};
const ALIGN_LABELS: Record<TextAlign, string> = {
  left: 'Left',
  center: 'Centre',
  right: 'Right',
  justify: 'Justified',
};
const FONTS = [
  'system-ui, sans-serif',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
];
const BUTTON_STYLE_LABELS: Record<ButtonStyle, string> = {
  rounded: 'Rounded',
  rectangle: 'Rectangle',
  shadowed: 'Shadowed',
  transparent: 'Transparent (invisible)',
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

const field = (label: string, control: ComponentChildren) => (
  <label className="field">
    <span>{label}</span>
    {control}
  </label>
);

const fontField = (font: string, disabled: boolean) =>
  field(
    'Font',
    <select data-field="font" disabled={disabled} value={font}>
      {(FONTS.includes(font) ? FONTS : [font, ...FONTS]).map(value => (
        <option key={value} value={value}>
          {value}
        </option>
      ))}
    </select>,
  );

const input = (
  name: string,
  value: string | number,
  disabled: boolean,
  type: 'text' | 'number' | 'color' = 'text',
  extra: { min?: number } = {},
) => {
  const props = { 'data-field': name, value, disabled, ...extra };
  // Preact's accessible input types require a literal input type per branch.
  switch (type) {
    case 'number':
      return <input type="number" {...props} />;
    case 'color':
      return <input type="color" {...props} />;
    default:
      return <input type="text" {...props} />;
  }
};

const color = (name: string, value: string, disabled: boolean) =>
  input(
    name,
    /^#[0-9a-f]{6}$/iu.test(value) ? value : '#000000',
    disabled,
    'color',
  );

const checkbox = (
  name: string,
  label: string,
  checked: boolean,
  disabled: boolean,
) => (
  <label className="check">
    <input
      checked={checked}
      data-field={name}
      disabled={disabled}
      type="checkbox"
    />
    {label}
  </label>
);

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
  const kindInfo = (element: DeepReadonly<Element>) => {
    switch (element.kind) {
      case 'text':
        return (
          <>
            <button
              data-edit-text={element.name}
              disabled={disabled}
              type="button"
            >
              Edit formatted text
            </button>
            {field(
              'Plain text (replaces formatting)',
              <textarea
                data-field="text"
                disabled={disabled}
                rows={4}
                value={plainTextOf(element.richText)}
              />,
            )}
            {fontField(element.font, disabled)}
            {field(
              'Alignment (all paragraphs)',
              <select
                data-field="textAlign"
                disabled={disabled}
                value={textAlignOf(element)}
              >
                {TEXT_ALIGNS.map(align => (
                  <option key={align} value={align}>
                    {ALIGN_LABELS[align]}
                  </option>
                ))}
              </select>,
            )}
            <div className="row">
              {field(
                'Size',
                input('textSize', element.textSize, disabled, 'number', {
                  min: 1,
                }),
              )}
              {field('Colour', color('textColor', element.textColor, disabled))}
            </div>
            {checkbox(
              'editable',
              'Reader can edit',
              element.editable,
              disabled,
            )}
          </>
        );
      case 'image':
        return (
          <button
            data-replace-image={element.name}
            disabled={disabled}
            type="button"
          >
            Replace image…
          </button>
        );
      case 'button':
        return (
          <>
            {field('Label', input('label', element.label, disabled))}
            {field(
              'Style',
              <select
                data-field="style"
                disabled={disabled}
                value={element.style}
              >
                {BUTTON_STYLES.map(style => (
                  <option key={style} value={style}>
                    {BUTTON_STYLE_LABELS[style]}
                  </option>
                ))}
              </select>,
            )}
            {fontField(element.font, disabled)}
            {field(
              'Size',
              input('textSize', element.textSize, disabled, 'number', {
                min: 1,
              }),
            )}
            <div className="row">
              {field('Fill', color('fill', element.fill, disabled))}
              {field('Text', color('textColor', element.textColor, disabled))}
            </div>
          </>
        );
      case 'rectangle':
      case 'ellipse':
        return (
          <>
            <div className="row">
              {field('Fill', color('fill', element.fill, disabled))}
              {field('Stroke', color('stroke', element.stroke, disabled))}
            </div>
            {field(
              'Thickness',
              input('thickness', element.thickness, disabled, 'number', {
                min: 0,
              }),
            )}
          </>
        );
      case 'canvas':
        return (
          <>
            {field('Fill', color('fill', element.fill, disabled))}
            <p className="muted">
              Drawing: {element.drawing.length}{' '}
              {element.drawing.length === 1 ? 'command' : 'commands'}
            </p>
            <button
              data-clear-drawing={element.name}
              disabled={disabled || !element.drawing.length}
              type="button"
            >
              Clear drawing
            </button>
          </>
        );
      case 'line':
        return (
          <div className="row">
            {field('Stroke', color('stroke', element.stroke, disabled))}
            {field(
              'Thickness',
              input('thickness', element.thickness, disabled, 'number', {
                min: 1,
              }),
            )}
          </div>
        );
    }
  };

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
          {KIND_NAMES[element.kind]} “{element.name}”
        </h2>
        {scriptButtons('element', 'Edit Script')}
        <NameField
          current={element.name}
          disabled={disabled}
          offer={
            element.kind === 'button'
              ? labelSuggestion(page, element, project)
              : undefined
          }
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
                  disabled ||
                    (element.kind === 'group' &&
                      (key === 'width' || key === 'height')),
                  'number',
                ),
              )}
            </Fragment>
          ))}
        </div>
        {kindInfo(element)}
        {checkbox('visible', 'Visible', element.visible, disabled)}
      </Fragment>
    );
  }
  const sounds = project.assets.filter(isSoundAsset);
  return (
    <Fragment key={page.id}>
      <h2>
        Page {pageIndex + 1} of {project.pages.length}
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
        <button
          data-move-page={-1}
          disabled={disabled || pageIndex === 0}
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
      <p className="muted">
        Scripts play a sound by its name, like tell sound to play
        &quot;waves&quot;. Add action… can write that for you.
      </p>
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

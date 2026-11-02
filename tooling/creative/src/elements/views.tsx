/** @jsxImportSource preact */
// The page-side half of each Element kind's definition: what it draws in its
// box and its controls in Info. Kept apart from the data half so the CLI and
// the Play worker, which never draw, load no JSX.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { paintCanvas } from '../canvas-view';
import {
  BUTTON_STYLES,
  plainTextOf,
  TEXT_ALIGNS,
  textAlignOf,
  type ButtonStyle,
  type CanvasElement,
  type Element,
  type ElementKind,
  type LineElement,
  type TextAlign,
} from '../model';
import type { DeepReadonly } from '../readonly';
import { controls, type InfoControls } from './controls';

type Of<K extends ElementKind> = DeepReadonly<Extract<Element, { kind: K }>>;

/** What a kind's Info section is given. */
export type InfoContext = { controls: InfoControls; disabled: boolean };

export type ElementKindView<K extends ElementKind = ElementKind> = {
  /** What it draws inside its box. */
  Contents?(props: {
    element: Of<K>;
    imageUrl?: string;
    reader: boolean;
  }): ComponentChildren;
  /** Its own controls in Info, after the box. */
  info?(element: Of<K>, context: InfoContext): ComponentChildren;
};

const ALIGN_LABELS: Record<TextAlign, string> = {
  left: 'Left',
  center: 'Centre',
  right: 'Right',
  justify: 'Justified',
};

const STYLE_LABELS: Record<ButtonStyle, string> = {
  rounded: 'Rounded',
  rectangle: 'Rectangle',
  shadowed: 'Shadowed',
  transparent: 'Transparent (invisible)',
};

const CanvasPixels = ({ element }: { element: Of<'canvas'> }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The painter keeps what it drew, so each render paints only additions.
  useLayoutEffect(() => {
    paintCanvas(canvas.current!, element as DeepReadonly<CanvasElement>);
  });
  return <canvas ref={canvas} />;
};

const Line = ({ element }: { element: DeepReadonly<LineElement> }) => {
  const { thickness, stroke } = element;
  // The first, wider line is transparent: it makes a thin line easy to grab.
  return (
    <svg height="1" width="1">
      {[Math.max(12, thickness), thickness].map((width, index) => (
        <line
          className={index === 0 ? 'hit' : undefined}
          key={index}
          stroke={stroke}
          strokeWidth={String(width)}
          x1="0"
          x2={String(element.width)}
          y1="0"
          y2={String(element.height)}
        />
      ))}
    </svg>
  );
};

const shapeView: ElementKindView<'rectangle' | 'ellipse'> = {
  info: (element, { controls: { field, input, color }, disabled }) => (
    <>
      <div className="row">
        {field('Fill', color('fill', element.fill, disabled))}
        {field('Stroke', color('stroke', element.stroke, disabled))}
      </div>
      {field(
        'Thickness',
        input('thickness', element.thickness, disabled, 'number', { min: 0 }),
      )}
    </>
  ),
};

const VIEWS: { readonly [K in ElementKind]: ElementKindView<K> } = {
  text: {
    info: (
      element,
      {
        controls: { field, fontField, input, color, checkbox, select },
        disabled,
      },
    ) => (
      <>
        <button data-edit-text={element.name} disabled={disabled} type="button">
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
          select(
            'textAlign',
            textAlignOf(element),
            disabled,
            TEXT_ALIGNS,
            ALIGN_LABELS,
          ),
        )}
        <div className="row">
          {field(
            'Size',
            input('textSize', element.textSize, disabled, 'number', { min: 1 }),
          )}
          {field('Colour', color('textColor', element.textColor, disabled))}
        </div>
        {checkbox('editable', 'Reader can edit', element.editable, disabled)}
      </>
    ),
  },
  image: {
    Contents: ({ element, imageUrl, reader }) => {
      if (imageUrl) {
        return <img alt={element.image} draggable={false} src={imageUrl} />;
      }
      return (
        <>
          <span>
            {element.image ? `Missing image: ${element.image}` : 'Image'}
          </span>
          {!reader && (
            <button data-replace-image={element.name} type="button">
              Replace…
            </button>
          )}
        </>
      );
    },
    info: (element, { disabled }) => (
      <button
        data-replace-image={element.name}
        disabled={disabled}
        type="button"
      >
        Replace image…
      </button>
    ),
  },
  button: {
    Contents: ({ element }) => (
      <span className="button-label">{element.label}</span>
    ),
    info: (
      element,
      { controls: { field, fontField, input, color, select }, disabled },
    ) => (
      <>
        {field('Label', input('label', element.label, disabled))}
        {field(
          'Style',
          select('style', element.style, disabled, BUTTON_STYLES, STYLE_LABELS),
        )}
        {fontField(element.font, disabled)}
        {field(
          'Size',
          input('textSize', element.textSize, disabled, 'number', { min: 1 }),
        )}
        <div className="row">
          {field('Fill', color('fill', element.fill, disabled))}
          {field('Text', color('textColor', element.textColor, disabled))}
        </div>
      </>
    ),
  },
  rectangle: shapeView,
  ellipse: shapeView,
  line: {
    Contents: Line,
    info: (element, { controls: { field, input, color }, disabled }) => (
      <div className="row">
        {field('Stroke', color('stroke', element.stroke, disabled))}
        {field(
          'Thickness',
          input('thickness', element.thickness, disabled, 'number', { min: 1 }),
        )}
      </div>
    ),
  },
  canvas: {
    Contents: CanvasPixels,
    info: (element, { controls: { field, color }, disabled }) => (
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
    ),
  },
  group: {},
};

/** The view half of `element`'s kind; its functions take that Element. */
export const viewOf = (element: DeepReadonly<Element>): ElementKindView =>
  VIEWS[element.kind] as ElementKindView;

/** `element`'s Info section. */
export const kindInfo = (
  element: DeepReadonly<Element>,
  disabled: boolean,
): ComponentChildren => viewOf(element).info?.(element, { controls, disabled });

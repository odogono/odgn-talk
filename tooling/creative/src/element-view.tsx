// An Element as the reader sees it (ADR 0146). Edit's desk, the Page strip
// and Play share it, and Preact keeps each node across renders, so a frame
// writes only what changed and a press and its release land on one node.
// Rich text and Canvas pixels stay direct DOM: `contenteditable` and the
// incremental painter own those children.
import {
  render,
  type CSSProperties,
  type HTMLAttributes,
  type JSX,
} from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { paintCanvas } from './canvas-view';
import type { CanvasElement, Element } from './model';
import type { DeepReadonly } from './readonly';
import { renderRichText } from './rich-text-dom';

type ElementViewProps = {
  /** Attributes and listeners the caller adds, such as Play's. */
  attributes?: HTMLAttributes<HTMLDivElement>;
  /** Extra classes, such as `selected` or `text-editing`. */
  className?: string;
  /** True while an in-place editor owns a text Element's children. */
  editing?: boolean;
  element: DeepReadonly<Element>;
  /** Hidden by its own flag or a hidden Group; its own flag by default. */
  hidden?: boolean;
  imageUrl?: string;
  /** A playing Page drops Edit's Replace button from a missing image. */
  reader?: boolean;
};

const box = (element: DeepReadonly<Element>): CSSProperties => ({
  left: `${element.left}px`,
  top: `${element.top}px`,
  width: `${element.width}px`,
  height: `${element.height}px`,
});

const kindStyle = (element: DeepReadonly<Element>): CSSProperties => {
  switch (element.kind) {
    case 'text':
      return {
        color: element.textColor,
        fontFamily: element.font,
        fontSize: `${element.textSize}px`,
      };
    case 'button':
      return {
        background:
          element.style === 'transparent' ? 'transparent' : element.fill,
        color: element.textColor,
        fontFamily: element.font,
        fontSize: `${element.textSize}px`,
      };
    case 'rectangle':
    case 'ellipse':
      return {
        background: element.fill,
        borderColor: element.stroke,
        borderWidth: `${element.thickness}px`,
      };
    case 'canvas':
      return { background: element.fill };
    default:
      return {};
  }
};

const kindClass = (element: DeepReadonly<Element>) =>
  element.kind === 'button'
    ? ` button-${element.style}`
    : element.kind === 'group' && !element.members.length
      ? ' empty-group'
      : '';

const CanvasPixels = ({
  element,
}: {
  element: DeepReadonly<CanvasElement>;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The painter keeps what it drew, so each render paints only additions.
  useLayoutEffect(() => {
    paintCanvas(canvas.current!, element);
  });
  return <canvas ref={canvas} />;
};

const Line = ({ element }: { element: DeepReadonly<Element> }) => {
  const thickness = 'thickness' in element ? element.thickness : 1;
  const stroke = 'stroke' in element ? element.stroke : '';
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

const Contents = ({
  element,
  imageUrl,
  reader,
}: Pick<ElementViewProps, 'element' | 'imageUrl' | 'reader'>) => {
  switch (element.kind) {
    case 'image':
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
    case 'button':
      return <span className="button-label">{element.label}</span>;
    case 'canvas':
      return <CanvasPixels element={element} />;
    case 'line':
      return <Line element={element} />;
    default:
      return null;
  }
};

export const ElementView = ({
  element,
  className = '',
  hidden = !element.visible,
  editing = false,
  reader = false,
  imageUrl,
  attributes,
}: ElementViewProps) => {
  const node = useRef<HTMLDivElement>(null);
  const text = element.kind === 'text' ? element.richText : undefined;
  // Paints rich text unless an editor owns it or it is already showing.
  useLayoutEffect(() => {
    const root = node.current;
    if (!root || !text || editing) {
      return;
    }
    const json = JSON.stringify(text);
    if (root.dataset.renderedRichText !== json) {
      renderRichText(root, text);
      root.setAttribute('data-rendered-rich-text', json);
    }
  });
  return (
    <div
      {...attributes}
      className={`el ${element.kind}${hidden ? ' hidden' : ''}${kindClass(element)}${className ? ` ${className}` : ''}`}
      data-element={element.name}
      onContextMenu={
        element.kind === 'image' && imageUrl
          ? event => event.preventDefault()
          : attributes?.onContextMenu
      }
      ref={node}
      style={{ ...box(element), ...kindStyle(element) }}
      title={element.kind === 'group' ? element.name : undefined}
    >
      {element.kind === 'text' ? null : (
        <Contents element={element} imageUrl={imageUrl} reader={reader} />
      )}
    </div>
  );
};

/**
 * Renders a Page's Elements into `into`'s Elements layer, which Preact owns;
 * `into` may hold other nodes, such as Edit's selection handles, after it.
 */
export const renderElements = (
  into: HTMLElement,
  views: JSX.Element[],
): void => {
  let layer = into.querySelector<HTMLElement>(':scope > .elements');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'elements';
    into.prepend(layer);
  }
  render(<>{views}</>, layer);
};

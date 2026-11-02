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
import { kindOf } from './elements/registry';
import { viewOf } from './elements/views';
import type { Element } from './model';
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
  const kind = kindOf(element);
  const Contents = viewOf(element).Contents;
  // Rich text is painted directly, so the in-place editor can own it.
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
      className={`el ${element.kind}${hidden ? ' hidden' : ''}${kind.className?.(element) ?? ''}${className ? ` ${className}` : ''}`}
      data-element={element.name}
      onContextMenu={
        kind.asset && imageUrl
          ? event => event.preventDefault()
          : attributes?.onContextMenu
      }
      ref={node}
      style={{ ...box(element), ...kind.style?.(element) }}
      title={kind.container ? element.name : undefined}
    >
      {Contents && (
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

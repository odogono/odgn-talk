/** @jsxImportSource preact */
// The pragma lets code run outside Folio's tsconfig, such as `bun test`
// from the repo root, compile this file: model.ts reaches every kind.
// The canvas Element: pixels Scripts draw through the `canvas` Grant. Its
// Drawing travels to the page as `DrawingView`s, never with the Element.
import { useLayoutEffect, useRef } from 'preact/hooks';
import { paintCanvas } from '../canvas-view';
import { drawingProblem } from '../drawing';
import type { CanvasElement } from '../model';
import type { DeepReadonly } from '../readonly';
import { commonProperties, defineElementKind, property } from './definition';

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

export const canvasKind = defineElementKind({
  kind: 'canvas',
  label: 'Canvas',
  icon: '▦',
  creatable: true,
  // Scripts draw through the `canvas` Grant and never read the Drawing.
  properties: { ...commonProperties, fill: property('fill', 'text') },
  create: base => ({ ...base, kind: 'canvas', fill: '#ffffff', drawing: [] }),
  check: (c, e, path, { base }) => {
    const problem = drawingProblem(e.drawing);
    if (problem) {
      c.fail(`${path}.drawing`, problem);
    }
    return {
      ...base(),
      kind: 'canvas',
      fill: c.str(e.fill, `${path}.fill`) ?? '',
      drawing: problem ? [] : (e.drawing as CanvasElement['drawing']),
    };
  },
  forPage: element => ({ ...element, drawing: [] }) as CanvasElement,
  style: element => ({ background: element.fill }),
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
});

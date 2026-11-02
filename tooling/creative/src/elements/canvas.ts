// The canvas Element: pixels Scripts draw through the `canvas` Grant. Its
// Drawing travels to the page as `DrawingView`s, never with the Element.
import { drawingProblem } from '../drawing';
import type { CanvasElement } from '../model';
import { commonProperties, defineElementKind, property } from './definition';

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
});

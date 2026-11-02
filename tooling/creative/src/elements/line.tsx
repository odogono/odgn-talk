/** @jsxImportSource preact */
// The pragma lets code run outside Folio's tsconfig, such as `bun test`
// from the repo root, compile this file: model.ts reaches every kind.
// The line Element: a stroke from its box's top left to its bottom right.
import type { LineElement } from '../model';
import type { DeepReadonly } from '../readonly';
import { commonProperties, defineElementKind, property } from './definition';

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

export const lineKind = defineElementKind({
  kind: 'line',
  label: 'Line',
  icon: '╱',
  creatable: true,
  flat: true,
  properties: {
    ...commonProperties,
    stroke: property('stroke', 'text'),
    thickness: property('thickness', 'number'),
  },
  create: base => ({
    ...base,
    kind: 'line',
    height: 0,
    stroke: '#1d1d1f',
    thickness: 2,
  }),
  check: (c, e, path, { base }) => ({
    ...base(),
    kind: 'line',
    stroke: c.str(e.stroke, `${path}.stroke`) ?? '',
    thickness: c.num(e.thickness, `${path}.thickness`, 'positive') ?? 1,
  }),
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
});

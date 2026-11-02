// The line Element: a stroke from its box's top left to its bottom right.
import { commonProperties, defineElementKind, property } from './definition';

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
});

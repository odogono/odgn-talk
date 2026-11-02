/** @jsxImportSource preact */
// The pragma lets code run outside Folio's tsconfig, such as `bun test`
// from the repo root, compile this file: model.ts reaches every kind.
// Rectangle and ellipse Elements: filled shapes with a border of any width.
import {
  commonProperties,
  defineElementKind,
  property,
  type ElementKindDefinition,
} from './definition';

type Shape = 'rectangle' | 'ellipse';

const shape = <K extends Shape>(
  kind: K,
  label: string,
  icon: string,
  fill: string,
): ElementKindDefinition<K> =>
  // Both shapes have the same properties, so one definition serves either.
  defineElementKind<Shape>({
    kind,
    label,
    icon,
    creatable: true,
    properties: {
      ...commonProperties,
      fill: property('fill', 'text'),
      stroke: property('stroke', 'text'),
      thickness: {
        ...property('thickness', 'number'),
        infoMin: 0,
        validate: (_owner, value) =>
          Number(value) < 0 ? 'thickness must be zero or above' : undefined,
      },
    },
    create: base => ({ ...base, kind, fill, stroke: '#1d1d1f', thickness: 2 }),
    check: (c, e, path, { base }) => ({
      ...base(),
      kind,
      fill: c.str(e.fill, `${path}.fill`) ?? '',
      stroke: c.str(e.stroke, `${path}.stroke`) ?? '',
      // Older format-1 Projects used a fixed 2px border.
      thickness:
        e.thickness === undefined
          ? 2
          : (c.num(e.thickness, `${path}.thickness`, 'nonNegative') ?? 2),
    }),
    style: element => ({
      background: element.fill,
      borderColor: element.stroke,
      borderWidth: `${element.thickness}px`,
    }),
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
  }) as ElementKindDefinition as ElementKindDefinition<K>;

export const rectangleKind = shape('rectangle', 'Rectangle', '■', '#f0a020');
export const ellipseKind = shape('ellipse', 'Ellipse', '●', '#7ee08a');

import {
  hasBorder,
  BUTTON_STYLES_PROSE,
  isButtonStyle,
  isPageAlignX,
  isPageAlignY,
  isTextAlign,
  setTextAlign,
  textAlignOf,
  textOf,
  type Element,
  type ElementKind,
  type Page,
  type Project,
  type TextAlign,
  type TextElement,
} from '../model';
import type { DeepReadonly, Mutable } from '../readonly';
import { GEOMETRY_FUEL, PROPERTY_FUEL, type Box } from './rules';

type PropertyOwner = DeepReadonly<Project | Page | Element>;
type PropertyValue = string | number | boolean;
type PropertyKind = 'project' | 'page' | ElementKind;

/** Tree-owned publication keeps validation/staging separate from live writes. */
type PropertyWriter = {
  field(field: string, value: unknown, knownDifferent?: boolean): void;
  geometry(changes: Partial<Box>): void;
  text(value: string): void;
};
type PropertyDescriptor = {
  get(owner: PropertyOwner): PropertyValue;
  /** Authoring-only fields are never part of a Script's Host interface. */
  script?: false;
  set?(
    owner: PropertyOwner,
    value: PropertyValue,
    writer: PropertyWriter,
  ): void;
  setCost?: { fuel: number };
  shape: 'text' | 'number' | 'boolean';
  validate?(owner: PropertyOwner, value: PropertyValue): string | undefined;
};

const scalar = (
  field: string,
  shape: PropertyDescriptor['shape'],
): PropertyDescriptor => ({
  shape,
  get: owner => (owner as Record<string, PropertyValue>)[field]!,
  set: (_owner, value, writer) => writer.field(field, value),
});
/** Element writes cost Fuel; Project and Page writes are authoring-only. */
const element = (
  field: string,
  shape: PropertyDescriptor['shape'],
): PropertyDescriptor => ({
  ...scalar(field, shape),
  setCost: { fuel: PROPERTY_FUEL },
});
const readOnly = ({
  set: _set,
  setCost: _setCost,
  ...descriptor
}: PropertyDescriptor): PropertyDescriptor => descriptor;
const geometry = (field: keyof Box): PropertyDescriptor => ({
  ...scalar(field, 'number'),
  setCost: { fuel: GEOMETRY_FUEL },
  set: (_owner, value, writer) => writer.geometry({ [field]: Number(value) }),
});
const name = readOnly(scalar('name', 'text'));
const common = {
  name,
  left: geometry('left'),
  top: geometry('top'),
  width: geometry('width'),
  height: geometry('height'),
  visible: element('visible', 'boolean'),
};
const textColor = element('textColor', 'text');
const fill = element('fill', 'text');
const stroke = element('stroke', 'text');
const thickness: PropertyDescriptor = {
  ...element('thickness', 'number'),
  validate: (owner, value) =>
    'kind' in owner && hasBorder(owner) && Number(value) < 0
      ? 'thickness must be zero or above'
      : undefined,
};

/** Authoring-only Page placement; absent reads as center. */
const pageAlign = (
  field: 'alignX' | 'alignY',
  valid: (value: unknown) => boolean,
  prose: string,
): PropertyDescriptor => ({
  shape: 'text',
  script: false,
  get: owner => (owner as DeepReadonly<Page>)[field] ?? 'center',
  validate: (_owner, value) =>
    valid(value) ? undefined : `${field} must be ${prose}`,
  set: (_owner, value, writer) =>
    writer.field(field, value === 'center' ? undefined : value),
});

const fields: Record<PropertyKind, Record<string, PropertyDescriptor>> = {
  project: {
    name,
    designWidth: { ...scalar('designWidth', 'number'), script: false },
  },
  page: {
    name,
    background: scalar('background', 'text'),
    height: scalar('height', 'number'),
    alignX: pageAlign('alignX', isPageAlignX, 'left, center or right'),
    alignY: pageAlign('alignY', isPageAlignY, 'top, center or bottom'),
  },
  text: {
    ...common,
    text: {
      shape: 'text',
      setCost: { fuel: PROPERTY_FUEL },
      get: owner => textOf(owner as DeepReadonly<TextElement>),
      set: (_owner, value, writer) => writer.text(String(value)),
    },
    textColor,
    textSize: element('textSize', 'number'),
    textAlign: {
      shape: 'text',
      setCost: { fuel: PROPERTY_FUEL },
      get: owner => textAlignOf(owner as DeepReadonly<TextElement>),
      validate: (_owner, value) =>
        isTextAlign(value)
          ? undefined
          : 'textAlign must be left, center, right or justify',
      set: (owner, value, writer) => {
        const staged = { ...(owner as Mutable<TextElement>) };
        setTextAlign(staged, value as TextAlign);
        writer.field('richText', staged.richText, true);
      },
    },
    font: element('font', 'text'),
    editable: element('editable', 'boolean'),
  },
  image: { ...common, image: element('image', 'text') },
  button: {
    ...common,
    label: element('label', 'text'),
    fill,
    textColor,
    font: element('font', 'text'),
    textSize: {
      ...element('textSize', 'number'),
      validate: (_owner, value) =>
        Number(value) > 0 ? undefined : 'textSize must be above zero',
    },
    style: {
      ...element('style', 'text'),
      validate: (_owner, value) =>
        isButtonStyle(value)
          ? undefined
          : `style must be ${BUTTON_STYLES_PROSE}`,
    },
  },
  rectangle: { ...common, fill, stroke, thickness },
  ellipse: { ...common, fill, stroke, thickness },
  line: { ...common, stroke, thickness },
  // Scripts draw through the `canvas` Grant and never read the Drawing.
  canvas: { ...common, fill },
  group: {
    ...common,
    width: readOnly(common.width),
    height: readOnly(common.height),
  },
};

const byKind = new Map(
  Object.entries(fields).map(([kind, properties]) => [
    kind,
    new Map(Object.entries(properties)),
  ]),
);

/** Shared by tree mutation, Play reads and the Script manifest. */
export const propertiesForKind = (
  kind: string,
): ReadonlyMap<string, PropertyDescriptor> => byKind.get(kind)!;
export const propertiesOf = (
  owner: PropertyOwner,
): ReadonlyMap<string, PropertyDescriptor> =>
  propertiesForKind(
    'kind' in owner ? owner.kind : 'pages' in owner ? 'project' : 'page',
  );

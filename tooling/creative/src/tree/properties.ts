import {
  isPageAlignX,
  isPageAlignY,
  type Page,
  type PaletteSettings,
} from '../model';
import type { DeepReadonly } from '../readonly';
import {
  nameProperty,
  scalar,
  type PropertyDescriptor,
  type PropertyOwner,
} from '../elements/definition';
import { placeholderKind, PLACEHOLDER_OBJECT_KIND } from '../elements/add-on';
import { addOnKinds, ELEMENT_KINDS, kindOf } from '../elements/registry';

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

/**
 * A Palette's window settings (#1903), authoring-only. Each writes the
 * whole `palette` object, so undo restores it in one step; a Page has none.
 */
const paletteSetting = <K extends keyof PaletteSettings>(
  key: K,
  shape: PropertyDescriptor['shape'],
  absent: PaletteSettings[K],
): PropertyDescriptor => ({
  shape,
  script: false,
  get: owner =>
    ((owner as DeepReadonly<Page>).palette?.[key] ?? absent) as never,
  validate: owner =>
    (owner as DeepReadonly<Page>).palette
      ? undefined
      : 'Only a Palette has this',
  set: (owner, value, writer) => {
    const next = { ...(owner as DeepReadonly<Page>).palette! } as Record<
      string,
      unknown
    >;
    if ((key === 'title' && value === '') || (key === 'float' && !value)) {
      delete next[key];
    } else {
      next[key] = value;
    }
    writer.field('palette', next);
  },
});

const fields: Record<string, Readonly<Record<string, PropertyDescriptor>>> = {
  project: {
    name: nameProperty,
    designWidth: { ...scalar('designWidth', 'number'), script: false },
  },
  page: {
    name: nameProperty,
    background: scalar('background', 'text'),
    height: scalar('height', 'number'),
    alignX: pageAlign('alignX', isPageAlignX, 'left, center or right'),
    alignY: pageAlign('alignY', isPageAlignY, 'top, center or bottom'),
    paletteTitle: paletteSetting('title', 'text', ''),
    paletteWidth: paletteSetting('width', 'number', 0),
    openOnPlay: paletteSetting('openOnPlay', 'boolean', false),
    floatInPerform: paletteSetting('float', 'boolean', false),
  },
  // Each Element kind's properties are in its definition.
  ...Object.fromEntries(
    ELEMENT_KINDS.map(kind => [kind, kindOf(kind).properties]),
  ),
  [PLACEHOLDER_OBJECT_KIND]: placeholderKind.properties,
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
): ReadonlyMap<string, PropertyDescriptor> => {
  const known = byKind.get(kind);
  if (known) {
    return known;
  }
  // A loaded Add-on kind, by its kind or its Object Kind's name.
  const entry = addOnKinds().find(
    e => e.kind === kind || e.objectKind === kind,
  );
  if (!entry) {
    return byKind.get(PLACEHOLDER_OBJECT_KIND)!;
  }
  const properties = new Map(Object.entries(entry.definition.properties));
  byKind.set(entry.kind, properties);
  byKind.set(entry.objectKind, properties);
  return properties;
};
export const propertiesOf = (
  owner: PropertyOwner,
): ReadonlyMap<string, PropertyDescriptor> =>
  propertiesForKind(
    'kind' in owner ? owner.kind : 'pages' in owner ? 'project' : 'page',
  );

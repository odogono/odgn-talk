import { isPageAlignX, isPageAlignY, type Page } from '../model';
import type { DeepReadonly } from '../readonly';
import {
  nameProperty,
  scalar,
  type PropertyDescriptor,
  type PropertyOwner,
} from '../elements/definition';
import { placeholderKind, PLACEHOLDER_OBJECT_KIND } from '../elements/add-on';
import { ELEMENT_KINDS, kindOf } from '../elements/registry';

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
): ReadonlyMap<string, PropertyDescriptor> =>
  byKind.get(kind) ?? byKind.get(PLACEHOLDER_OBJECT_KIND)!;
export const propertiesOf = (
  owner: PropertyOwner,
): ReadonlyMap<string, PropertyDescriptor> =>
  propertiesForKind(
    'kind' in owner ? owner.kind : 'pages' in owner ? 'project' : 'page',
  );

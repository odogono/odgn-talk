// The Element kind registry (#1900). Built-in kinds register here and stay
// in Folio; code elsewhere asks `kindOf` instead of branching on `kind`.
//
// Kind branches that remain outside `elements/`, and why:
// - Group members (`tree/rules.ts`, `editing.ts`, `play.ts`, `model.ts`,
//   `stack.ts`, `code-browser-panel.tsx`): the ownership tree walks them,
//   so these narrow to `GroupElement` to reach `members`.
// - Rich text editing (`editing.ts`, `stack.ts`, `play-view.ts`,
//   `play-host.ts`, `element-view.tsx`, `test-runner.ts`, `play-harness.ts`):
//   the in-place editor and its history are the text kind's own machinery.
// - Drawings (`play.ts`, `play-mirror.ts`, `play-host.ts`, `stack.ts`,
//   `play-harness.ts`): the `canvas` Grant owns a canvas's commands, which
//   travel as `DrawingView`s rather than with the Element.
// - Button activation (`play-view.ts`): Enter and Space click a focused
//   button, and a click returns the keys to the Page, as in a browser.
import type {
  AddOnKind,
  BuiltInKind,
  Element,
  ElementBase,
  ElementKind,
} from '../model';
import type { DeepReadonly } from '../readonly';
import {
  isAddOnKind,
  placeholderKind,
  PLACEHOLDER_OBJECT_KIND,
} from './add-on';
import { buttonKind } from './button';
import { canvasKind } from './canvas';
import type { ElementKindDefinition } from './definition';
import { groupKind } from './group';
import { imageKind } from './image';
import { lineKind } from './line';
import { ellipseKind, rectangleKind } from './shapes';
import { textKind } from './text';

const DEFINITIONS: { readonly [K in BuiltInKind]: ElementKindDefinition<K> } = {
  text: textKind,
  image: imageKind,
  button: buttonKind,
  rectangle: rectangleKind,
  ellipse: ellipseKind,
  line: lineKind,
  canvas: canvasKind,
  group: groupKind,
};

/** Every built-in kind, in Tools window order. */
export const ELEMENT_KINDS = Object.keys(DEFINITIONS) as readonly BuiltInKind[];

export const isBuiltInKind = (kind: unknown): kind is BuiltInKind =>
  typeof kind === 'string' && Object.hasOwn(DEFINITIONS, kind);

/** A built-in kind or an Add-on's. */
export const isElementKind = (kind: unknown): kind is ElementKind =>
  isBuiltInKind(kind) || (typeof kind === 'string' && isAddOnKind(kind));

/** A kind an Add-on registered, and the Object Kind Scripts see it as. */
export type AddOnKindEntry = {
  definition: ElementKindDefinition;
  kind: AddOnKind;
  objectKind: string;
};

// Kinds registered by loaded Add-ons (#1901), by kind.
const ADD_ON_KINDS = new Map<string, AddOnKindEntry>();

/** Every kind a loaded Add-on registered, in the order they were. */
export const addOnKinds = (): readonly AddOnKindEntry[] => [
  ...ADD_ON_KINDS.values(),
];

/**
 * Registers an Add-on's kind. Scripts see it as an Object Kind named by
 * the kind's name, which must not be taken by a built-in kind or another
 * Add-on's; the problem, when it is, else undefined.
 */
export const registerAddOnKind = (
  kind: AddOnKind,
  definition: ElementKindDefinition,
  objectKind: string,
): string | undefined => {
  if (ADD_ON_KINDS.has(kind)) {
    return undefined;
  }
  if (
    isBuiltInKind(objectKind) ||
    RESERVED_OBJECT_KINDS.has(objectKind) ||
    [...ADD_ON_KINDS.values()].some(e => e.objectKind === objectKind)
  ) {
    return `another kind is already named ${objectKind}`;
  }
  ADD_ON_KINDS.set(kind, { kind, definition, objectKind });
  return undefined;
};

/** Forgets every Add-on kind; for tests. */
export const resetAddOnKinds = (): void => ADD_ON_KINDS.clear();

const RESERVED_OBJECT_KINDS = new Set([
  PLACEHOLDER_OBJECT_KIND,
  'project',
  'page',
]);

/** Whether Elements of `kind` are placeholders: an Add-on's, not loaded. */
export const isPlaceholderKind = (kind: ElementKind): kind is AddOnKind =>
  !isBuiltInKind(kind) && !ADD_ON_KINDS.has(kind);

/** The Object Kind a Script sees an Element of `kind` as. */
export const scriptKindOf = (kind: ElementKind): string =>
  isBuiltInKind(kind)
    ? kind
    : (ADD_ON_KINDS.get(kind)?.objectKind ?? PLACEHOLDER_OBJECT_KIND);

/** The kinds a Script or the Tools window may create. */
export const CREATABLE_KINDS = ELEMENT_KINDS.filter(
  kind => DEFINITIONS[kind].creatable,
);

/**
 * The definition of `kind`, or of an Element's kind. Its functions take any
 * Element; callers pass only Elements of that kind.
 */
export const kindOf = (
  of: ElementKind | DeepReadonly<Element>,
): ElementKindDefinition => {
  const kind = typeof of === 'string' ? of : of.kind;
  return (
    isBuiltInKind(kind)
      ? DEFINITIONS[kind]
      : (ADD_ON_KINDS.get(kind)?.definition ?? placeholderKind)
  ) as ElementKindDefinition;
};

const base = (name: string): ElementBase => ({
  name,
  left: 40,
  top: 40,
  width: 200,
  height: 100,
  visible: true,
});

/** A new Element of `kind` with that kind's default properties. */
export const createElement = <K extends BuiltInKind>(
  kind: K,
  name: string,
): Extract<Element, { kind: K }> =>
  DEFINITIONS[kind].create(base(name)) as Extract<Element, { kind: K }>;

/** A new Element of a built-in or loaded Add-on kind, with its defaults. */
export const createAnyElement = (kind: ElementKind, name: string): Element =>
  kindOf(kind).create(base(name));

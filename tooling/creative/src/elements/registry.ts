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
import type { BuiltInKind, Element, ElementBase, ElementKind } from '../model';
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

/** The Object Kind a Script sees an Element of `kind` as. */
export const scriptKindOf = (kind: ElementKind): string =>
  isBuiltInKind(kind) ? kind : PLACEHOLDER_OBJECT_KIND;

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
    isBuiltInKind(kind) ? DEFINITIONS[kind] : placeholderKind
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

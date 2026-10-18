// Folio's ownership tree. Coordinates are always Page-relative; group boxes
// and collection order are derived views, never a second ownership graph.
import type { DeepReadonly } from '../readonly';
import type { Element, GroupElement, Page, Project } from '../model';

export type ChildrenKey = 'pages' | 'elements' | 'members';
type Owner = Project | Page | Element;

export const isGroupElement = (
  element: DeepReadonly<Element>,
): element is DeepReadonly<GroupElement> => element.kind === 'group';

/** The ownership field, absent for leaf Elements. */
export const childrenKey = (
  owner: DeepReadonly<Owner>,
): ChildrenKey | undefined =>
  'pages' in owner
    ? 'pages'
    : 'elements' in owner
      ? 'elements'
      : isGroupElement(owner)
        ? 'members'
        : undefined;

export const children = (owner: Owner): Owner[] => {
  const key = childrenKey(owner);
  return key ? (owner as unknown as Record<string, Owner[]>)[key]! : [];
};

/** Stage geometry without copying leaf content such as rich text. */
export const geometryCopy = (node: Element): Element =>
  isGroupElement(node)
    ? { ...node, members: node.members.map(geometryCopy) }
    : { ...node };

export const MAX_GROUP_ELEMENTS = 1024;
export const MAX_GROUP_DEPTH = 32;
// Covers a bounded geometry preflight, descendant updates and ancestor bounds,
// at 8 Fuel per node visited.
export const GEOMETRY_FUEL = MAX_GROUP_ELEMENTS * 8;
export const PROPERTY_FUEL = MAX_GROUP_DEPTH * 8;
export type Box = Pick<Element, 'left' | 'top' | 'width' | 'height'>;
export const BOX_FIELDS = ['left', 'top', 'width', 'height'] as const;

/** Postorder: back-to-front siblings, each group after its members. */
export function allElements(elements: readonly Element[]): Element[];
export function allElements(
  elements: readonly DeepReadonly<Element>[],
): DeepReadonly<Element>[];
export function allElements(
  elements: readonly DeepReadonly<Element>[],
): DeepReadonly<Element>[] {
  return elements.flatMap(e => [
    ...(e.kind === 'group' ? allElements(e.members) : []),
    e,
  ]);
}
export function findElement(
  elements: readonly Element[],
  name: string,
): Element | undefined;
export function findElement(
  elements: readonly DeepReadonly<Element>[],
  name: string,
): DeepReadonly<Element> | undefined;
export function findElement(
  elements: readonly DeepReadonly<Element>[],
  name: string,
): DeepReadonly<Element> | undefined {
  for (const e of elements) {
    if (e.name === name) {
      return e;
    }
    if (e.kind === 'group') {
      const found = findElement(e.members, name);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** Reject cycles/shared ownership and limits before traversing an intake tree. */
export const checkHierarchy = (
  elements: readonly DeepReadonly<Element>[],
): void => {
  const seen = new Set<DeepReadonly<Element>>();
  const visit = (e: DeepReadonly<Element>, depth: number): number => {
    if (seen.has(e)) {
      throw new Error('An Element must have exactly one parent');
    }
    seen.add(e);
    if (e.kind !== 'group') {
      return 1;
    }
    if (depth >= MAX_GROUP_DEPTH) {
      throw new Error(`Groups may nest at most ${MAX_GROUP_DEPTH} levels`);
    }
    let size = 1;
    for (const member of e.members) {
      size += visit(member, depth + 1);
      if (size > MAX_GROUP_ELEMENTS) {
        throw new Error(
          `A group may contain at most ${MAX_GROUP_ELEMENTS} Elements including itself`,
        );
      }
    }
    return size;
  };
  for (const e of elements) {
    visit(e, 0);
  }
};

const union = (members: readonly Box[]): Box => {
  const left = Math.min(
    ...members.map(e => Math.min(e.left, e.left + e.width)),
  );
  const top = Math.min(...members.map(e => Math.min(e.top, e.top + e.height)));
  return {
    left,
    top,
    width:
      Math.max(...members.map(e => Math.max(e.left, e.left + e.width))) - left,
    height:
      Math.max(...members.map(e => Math.max(e.top, e.top + e.height))) - top,
  };
};
const finiteBox = (box: Box): void => {
  if (
    ![
      box.left,
      box.top,
      box.width,
      box.height,
      box.left + box.width,
      box.top + box.height,
    ].every(Number.isFinite)
  ) {
    throw new Error('Element coordinates and bounds must be finite');
  }
};

/** Recompute one group's box from its direct members' current boxes. */
export const refreshBox = (group: GroupElement): void => {
  const box = group.members.length
    ? union(group.members)
    : { left: group.left, top: group.top, width: 0, height: 0 };
  finiteBox(box);
  Object.assign(group, box);
};

export const refreshBounds = (elements: Element[]): void => {
  for (const e of elements) {
    if (e.kind === 'group') {
      refreshBounds(e.members);
      refreshBox(e);
    }
  }
};

/** Stage only geometry, then publish once every descendant/ancestor is valid. */
export const updateGeometry = (
  root: Element,
  target: Element,
  changes: Partial<Box>,
): void => {
  if (
    target.kind === 'group' &&
    (changes.width !== undefined || changes.height !== undefined)
  ) {
    throw new Error('Group width and height are read-only');
  }
  const nodes = allElements([root]);
  const moved = new Set<Element>(
    target.kind === 'group' ? allElements([target]) : [target],
  );
  const dx = (changes.left ?? target.left) - target.left;
  const dy = (changes.top ?? target.top) - target.top;
  const boxes = new Map<Element, Box>();
  for (const e of nodes) {
    let box: Box = {
      left: e.left,
      top: e.top,
      width: e.width,
      height: e.height,
    };
    if (e.kind === 'group' && e.members.length) {
      box = union(e.members.map(m => boxes.get(m)!));
    } else if (moved.has(e)) {
      box =
        target.kind === 'group'
          ? { ...box, left: box.left + dx, top: box.top + dy }
          : { ...box, ...changes };
    }
    finiteBox(box);
    boxes.set(e, box);
  }
  for (const [e, box] of boxes) {
    Object.assign(e, box);
  }
};

export const outerElement = <T extends DeepReadonly<Element>>(
  elements: readonly T[],
  name: string,
): T | undefined =>
  elements.find(
    e =>
      e.name === name || (e.kind === 'group' && findElement(e.members, name)),
  );

export const groupElement = (
  name: string,
  members: Element[],
): GroupElement => {
  const group: GroupElement = {
    kind: 'group',
    name,
    members,
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    visible: true,
  };
  checkHierarchy([group]);
  refreshBounds([group]);
  return group;
};

/** Effective visibility for a rendered Page, without altering own flags. */
export const elementVisibility = (
  elements: readonly DeepReadonly<Element>[],
): Map<string, boolean> => {
  const result = new Map<string, boolean>();
  const visit = (e: DeepReadonly<Element>, parent: boolean) => {
    const visible = parent && e.visible;
    result.set(e.name, visible);
    if (e.kind === 'group') {
      for (const member of e.members) {
        visit(member, visible);
      }
    }
  };
  for (const e of elements) {
    visit(e, true);
  }
  return result;
};

/** Innermost first, for authoring Message Path links. */
export const containingGroups = (
  elements: readonly DeepReadonly<Element>[],
  name: string,
): DeepReadonly<GroupElement>[] => {
  for (const e of elements) {
    if (e.name === name) {
      return [];
    }
    if (e.kind === 'group' && findElement(e.members, name)) {
      return [...containingGroups(e.members, name), e];
    }
  }
  return [];
};

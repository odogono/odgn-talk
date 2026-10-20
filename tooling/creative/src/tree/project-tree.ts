import type { DeepReadonly, Mutable } from '../readonly';
import {
  createElement,
  createPage,
  duplicateElement,
  duplicatePage,
  freshName,
  isIdentifierName,
  replacePlainText,
  type Asset,
  type CanvasElement,
  type Element,
  type ElementKind,
  type GroupElement,
  type Page,
  type Project,
  type ProjectLibrary,
  type RichText,
  type TextElement,
} from '../model';
import { libraryNameProblem, reservedScriptNames } from '../script-names';
import {
  allElements,
  checkHierarchy,
  children,
  childrenKey,
  geometryChanges,
  geometryCopy,
  isGroupElement,
  refreshBounds,
  BOX_FIELDS,
  refreshBox,
  updateGeometry,
  MAX_GROUP_ELEMENTS,
  type Box,
  type ChildrenKey,
} from './rules';
import { propertiesOf } from './properties';

export class TreeError extends Error {}
const domain = <T>(action: () => T): T => {
  try {
    return action();
  } catch (error) {
    throw new TreeError(String(error));
  }
};

export type TreeOwner = DeepReadonly<Project | Page | Element>;
export type TreeParent = DeepReadonly<Page | GroupElement>;
type Owner = Project | Page | Element;
type Parent = Page | GroupElement;
type SavedNode = {
  children?: SavedNode[];
  field?: ChildrenKey;
  key: number;
  value: Record<string, unknown>;
};
export type TreeChange = DeepReadonly<
  | {
      after: unknown;
      before: unknown;
      field: string;
      kind: 'field';
      owner: number;
    }
  | {
      after: number[];
      before: number[];
      field: ChildrenKey;
      kind: 'children';
      nodes: SavedNode[];
      owner: number;
    }
>;
export type TreeJournal = readonly TreeChange[];
export type TreeChangeSet = {
  readonly assets: boolean;
  /** Synchronous live payloads. Retaining consumers must detach their history. */
  readonly changes: TreeJournal;
  readonly designWidth: boolean;
  readonly owners: readonly TreeOwner[];
  readonly pages: readonly DeepReadonly<Page>[];
  readonly structure: boolean;
};
export type TreeHooks = {
  /** Must authorize before any size-dependent copying or staging. */
  authorize?: (fuel: number) => void;
  /** The root is not indexed/published yet. Install parents before children. */
  install?: (root: DeepReadonly<Element>, parent: TreeParent) => void;
};
export type CloneResult = {
  readonly pairs: readonly (readonly [
    DeepReadonly<Element>,
    DeepReadonly<Element>,
  ])[];
  readonly root: DeepReadonly<Element>;
};

export const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return true;
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return (
    keys.length ===
      Object.keys(right).filter(key => right[key] !== undefined).length &&
    keys.every(key => equal(left[key], right[key]))
  );
};
export const detached = <T>(value: T): T =>
  value !== null && typeof value === 'object' ? structuredClone(value) : value;
/** Freeze detached plain-data snapshots and history, never live owners. */
export const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
};
const ownSize = (value: unknown): number =>
  typeof value === 'number' || typeof value === 'boolean'
    ? 64
    : (JSON.stringify(value)?.length ?? 0);

/**
 * The sole writer of a live Project. Views preserve node identity, not array
 * identity across structural changes. This module has no Core runtime or UI.
 */
export class ProjectTree {
  #project: Project;
  #trackWork: boolean;
  #allocateId: (() => number) | undefined;
  #keys = new WeakMap<object, number>();
  #nodes = new Map<number, Owner>();
  #ids = new Map<number, Owner>();
  #nextKey = 0;
  #names = new Map<Page, Map<string, Element>>();
  #nameMembers = new Map<Page, Map<string, Set<Element>>>();
  #ordered = new Map<Page, Element[]>();
  #parents = new Map<DeepReadonly<Element>, Parent>();
  #pages = new Map<DeepReadonly<Element>, Page>();
  #outer = new Map<DeepReadonly<Element>, Element>();
  #memberNames = new Map<GroupElement, Map<string, Element>>();
  #fields = new WeakMap<Element, Map<string, number>>();
  #ownWork = new WeakMap<Element, number>();
  #work = new WeakMap<Element, number>();
  #size = new WeakMap<Element, number>();
  #listeners = new Set<(change: TreeChangeSet) => void>();
  #journal: TreeChange[] | undefined;
  #rollback: (() => void)[] | undefined;
  #changedOwners = new Set<Owner>();
  #changedPages = new Set<Page>();
  #assetsChanged = false;
  #widthChanged = false;
  #structureChanged = false;
  #inHook = false;

  /**
   * Copy intake once. Edit supplies its monotonic owner-id allocator. Only
   * Play tracks copy work for Fuel authorization. Events are synchronous;
   * durable history belongs to the retaining consumer.
   */
  constructor(
    project: DeepReadonly<Project>,
    allocateId?: () => number,
    { trackWork = false }: { trackWork?: boolean } = {},
  ) {
    this.#trackWork = trackWork;
    checkHierarchy(project.pages.flatMap(page => page.elements));
    this.#project = detached(project) as Project;
    this.#allocateId = allocateId;
    for (const library of this.#project.libraries) {
      library.id ??= this.#allocateId?.();
    }
    for (const page of this.#project.pages) {
      refreshBounds(page.elements);
    }
    this.#register(this.#project, undefined, true);
    for (const page of this.#project.pages) {
      this.#indexPage(page);
    }
  }

  get project(): DeepReadonly<Project> {
    return this.#project;
  }
  snapshot(): DeepReadonly<Project> {
    return freeze(detached(this.#project));
  }
  subscribe(listener: (change: TreeChangeSet) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  owner(id: number): TreeOwner | undefined {
    return id === 0 ? this.#project : this.#ids.get(id);
  }
  /** O(nodes), without serializing content; used once at the start of an edit. */
  historyKeys(): ReadonlySet<number> {
    return new Set(this.#nodes.keys());
  }
  contains(owner: TreeOwner): boolean {
    const key = this.#keys.get(owner);
    return key !== undefined && this.#nodes.get(key) === owner;
  }
  /** Only the tree may turn an owned live view back into writable data. */
  #mutable<T extends TreeOwner>(owner: T): Mutable<T> {
    if (!this.contains(owner)) {
      throw new TreeError('Unknown Project owner');
    }
    return owner as Mutable<T>;
  }
  parentOf(element: DeepReadonly<Element>): TreeParent | undefined {
    return this.#parents.get(element);
  }
  pageOf(element: DeepReadonly<Element>): DeepReadonly<Page> | undefined {
    return this.#pages.get(element);
  }
  outerOf(element: DeepReadonly<Element>): DeepReadonly<Element> | undefined {
    return this.#outer.get(element);
  }
  elementsOf(page: DeepReadonly<Page>): readonly DeepReadonly<Element>[] {
    return this.#ordered.get(this.#mutable(page))!;
  }
  membersOf(parent: TreeParent): readonly DeepReadonly<Element>[] {
    const node = this.#mutable(parent);
    return 'kind' in node ? node.members : this.#ordered.get(node)!;
  }
  find(parent: TreeParent, name: string): DeepReadonly<Element> | undefined {
    const node = this.#mutable(parent);
    return (
      'kind' in node ? this.#memberNames.get(node) : this.#names.get(node)
    )?.get(name);
  }
  isVisible(element: DeepReadonly<Element>): boolean {
    if (!this.pageOf(element)) {
      return false;
    }
    let node: DeepReadonly<Element | Page> = element;
    while ('kind' in node) {
      if (!node.visible) {
        return false;
      }
      node = this.parentOf(node)!;
    }
    return true;
  }

  #register(owner: Owner, savedKey?: number, recursive = false): void {
    let key = this.#keys.get(owner);
    if (key === undefined) {
      key = savedKey ?? this.#nextKey++;
      this.#keys.set(owner, key);
    }
    this.#nodes.set(key, owner);
    if (
      owner !== this.#project &&
      this.#allocateId &&
      !('id' in owner && owner.id !== undefined)
    ) {
      (owner as Page | Element).id = this.#allocateId();
    }
    if ('id' in owner && owner.id !== undefined) {
      this.#ids.set(owner.id, owner);
    }
    if (recursive) {
      for (const child of children(owner)) {
        this.#register(child, undefined, true);
      }
    }
  }
  #initWork(element: Element): void {
    if (!this.#trackWork || this.#fields.has(element)) {
      return;
    }
    const fields = new Map(
      Object.entries(element)
        .filter(([key]) => key !== 'members')
        .map(([key, value]) => [key, ownSize(value)]),
    );
    this.#fields.set(element, fields);
    this.#ownWork.set(
      element,
      128 + [...fields.values()].reduce((sum, n) => sum + n, 0),
    );
  }
  #indexPage(page: Page): void {
    const ordered = allElements(page.elements);
    this.#ordered.set(page, ordered);
    // Invalid imported names remain repairable in Edit. Play validates names
    // before constructing a tree; its collection keys are therefore unique.
    this.#names.set(page, new Map(ordered.map(node => [node.name, node])));
    this.#nameMembers.set(page, new Map());
    for (const node of ordered) {
      this.#addName(page, node);
    }
    const visit = (node: Element, parent: Parent, outer: Element): void => {
      this.#register(node);
      this.#parents.set(node, parent);
      this.#pages.set(node, page);
      this.#outer.set(node, outer);
      if (isGroupElement(node)) {
        this.#indexMembers(node);
        for (const member of node.members) {
          visit(member, node, outer);
        }
      }
      this.#totals(node);
    };
    for (const element of page.elements) {
      visit(element, page, element);
    }
  }
  #touch(owner: Owner): void {
    this.#changedOwners.add(owner);
    if ('elements' in owner) {
      this.#changedPages.add(owner);
    } else if ('kind' in owner) {
      const page = this.#pages.get(owner);
      if (page) {
        this.#changedPages.add(page);
      }
    }
  }
  #syncName(page: Page, name: string): void {
    const members = this.#nameMembers.get(page)!.get(name);
    const names = this.#names.get(page)!;
    if (!members?.size) {
      this.#nameMembers.get(page)!.delete(name);
      names.delete(name);
    } else if (members.size === 1) {
      names.set(name, members.values().next().value!);
    } else {
      // Conflicting imported names remain repairable. Match the last node in
      // postorder, as a full index does; valid Projects never take this path.
      const ordered = this.#ordered.get(page)!;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const node = ordered[i]!;
        if (members.has(node)) {
          names.set(name, node);
          break;
        }
      }
    }
  }
  #addName(page: Page, node: Element): void {
    const names = this.#nameMembers.get(page)!;
    const members = names.get(node.name) ?? new Set<Element>();
    members.add(node);
    names.set(node.name, members);
  }
  #renameIndex(node: Element, before: string, after: string): void {
    const page = this.#pages.get(node)!;
    this.#nameMembers.get(page)!.get(before)?.delete(node);
    this.#addName(page, node);
    this.#syncName(page, before);
    this.#syncName(page, after);
    const parent = this.#parents.get(node)!;
    if ('kind' in parent) {
      this.#indexMembers(parent);
    }
  }
  /** Duplicate member names resolve to the last member, as a full index does. */
  #indexMembers(group: GroupElement): void {
    this.#memberNames.set(
      group,
      new Map(group.members.map(member => [member.name, member])),
    );
  }
  #elementNames(page: Page): Set<string> {
    return new Set([
      ...reservedScriptNames,
      ...this.#project.pages.map(page => page.name),
      ...this.#names.get(page)!.keys(),
    ]);
  }
  #pageNames(): Set<string> {
    const names = new Set([
      ...reservedScriptNames,
      ...this.#project.pages.map(page => page.name),
    ]);
    for (const page of this.#project.pages) {
      for (const name of this.#names.get(page)!.keys()) {
        names.add(name);
      }
    }
    return names;
  }
  #unregister(node: Element): void {
    this.#nodes.delete(this.#keys.get(node)!);
    if (node.id !== undefined) {
      this.#ids.delete(node.id);
    }
    this.#memberNames.delete(node as GroupElement);
    this.#parents.delete(node);
    this.#pages.delete(node);
    this.#outer.delete(node);
  }
  #totals(node: Element): void {
    this.#initWork(node);
    let size = 1;
    let work = this.#ownWork.get(node) ?? 0;
    if (isGroupElement(node)) {
      for (const member of node.members) {
        size += this.#size.get(member)!;
        work += this.#work.get(member) ?? 0;
      }
    }
    this.#size.set(node, size);
    if (this.#trackWork) {
      this.#work.set(node, work);
    }
  }
  #updateWork(element: Element, field: string): void {
    if (!this.#trackWork) {
      return;
    }
    this.#initWork(element);
    const fields = this.#fields.get(element)!;
    const size = ownSize(
      (element as unknown as Record<string, unknown>)[field],
    );
    const delta = size - (fields.get(field) ?? 0);
    fields.set(field, size);
    if (delta === 0) {
      return;
    }
    this.#ownWork.set(element, this.#ownWork.get(element)! + delta);
    let node = element;
    while (true) {
      this.#work.set(
        node,
        (this.#work.get(node) ?? this.#ownWork.get(node)!) + delta,
      );
      const parent = this.#parents.get(node);
      if (!parent || !('kind' in parent)) {
        break;
      }
      node = parent;
    }
  }
  #record(change: TreeChange): void {
    this.#journal!.push(change);
  }
  #field(owner: Owner, field: string, next: unknown, replace = false): void {
    const record = owner as unknown as Record<string, unknown>;
    if (!replace && equal(record[field], next)) {
      return;
    }
    const value = detached(next);
    this.#record({
      kind: 'field',
      owner: this.#keys.get(owner)!,
      field,
      before: record[field],
      after: value,
    });
    // Immediate rollback restores the exact live references.
    const previous = record[field];
    const present = Object.hasOwn(record, field);
    this.#rollback!.push(() => {
      if (present) {
        record[field] = previous;
      } else {
        delete record[field];
      }
      if ('kind' in owner) {
        this.#updateWork(owner, field);
      }
      if (field === 'name' && 'kind' in owner) {
        this.#renameIndex(owner, next as string, previous as string);
      }
    });
    if (next === undefined) {
      delete record[field];
    } else {
      record[field] = value;
    }
    if ('kind' in owner) {
      this.#updateWork(owner, field);
    }
    if (owner === this.#project && field === 'assets') {
      this.#assetsChanged = true;
    }
    if (owner === this.#project && field === 'designWidth') {
      this.#widthChanged = true;
    }
    this.#touch(owner);
    if (field === 'name' && 'kind' in owner) {
      this.#renameIndex(owner, previous as string, next as string);
    }
  }
  #saveNode(owner: Owner): SavedNode {
    const field = childrenKey(owner);
    const value = Object.fromEntries(
      Object.entries(owner).filter(([key]) => key !== field),
    );
    return {
      key: this.#keys.get(owner)!,
      value,
      ...(field
        ? { field, children: children(owner).map(node => this.#saveNode(node)) }
        : {}),
    };
  }
  #restore(saved: DeepReadonly<SavedNode>): Owner {
    const existing = this.#nodes.get(saved.key);
    if (existing) {
      return existing;
    }
    const owner = detached(saved.value) as unknown as Owner;
    const field = saved.field;
    if (field) {
      (owner as unknown as Record<string, Owner[]>)[field] = [];
    }
    this.#register(owner, saved.key);
    if (field) {
      (owner as unknown as Record<string, Owner[]>)[field] = (
        saved.children ?? []
      ).map(child => this.#restore(child));
    }
    return owner;
  }
  #children(owner: Owner, next: Owner[]): void {
    const field = childrenKey(owner)!;
    const previous = children(owner);
    if (
      previous.length === next.length &&
      previous.every((node, i) => node === next[i])
    ) {
      return;
    }
    const previousSet = new Set(previous);
    next
      .filter(node => !previousSet.has(node))
      .forEach(node => this.#register(node, undefined, true));
    const before = previous.map(node => this.#keys.get(node)!);
    const after = next.map(node => this.#keys.get(node)!);
    const nextSet = new Set(next);
    const changed = [
      ...previous.filter(node => !nextSet.has(node)),
      ...next.filter(node => !previousSet.has(node)),
    ];
    const mark = (node: Owner): void => {
      this.#touch(node);
      for (const child of children(node)) {
        mark(child);
      }
    };
    changed.forEach(mark);
    const nodes = changed.map(node => this.#saveNode(node));
    this.#record({
      kind: 'children',
      owner: this.#keys.get(owner)!,
      field,
      before,
      after,
      nodes,
    });
    this.#rollback!.push(() => this.#writeChildren(owner, previous));
    this.#writeChildren(owner, [...next]);
    this.#touch(owner);
    this.#structureChanged = true;
  }
  #writeChildren(owner: Owner, next: Owner[]): void {
    const previous = children(owner);
    (owner as unknown as Record<string, Owner[]>)[childrenKey(owner)!] = next;
    if ('pages' in owner) {
      const retained = new Set(next);
      const existing = new Set(previous);
      for (const page of previous as Page[]) {
        if (!retained.has(page)) {
          for (const element of this.#ordered.get(page) ?? []) {
            this.#unregister(element);
          }
          this.#nodes.delete(this.#keys.get(page)!);
          if (page.id !== undefined) {
            this.#ids.delete(page.id);
          }
          this.#ordered.delete(page);
          this.#names.delete(page);
          this.#nameMembers.delete(page);
        }
      }
      for (const page of next as Page[]) {
        if (!existing.has(page)) {
          this.#register(page);
          this.#indexPage(page);
        }
      }
    } else {
      const parent = owner as Parent;
      const page = 'elements' in parent ? parent : this.#pages.get(parent)!;
      const ordered = this.#ordered.get(page)!;
      let start = 0;
      while (
        start < previous.length &&
        start < next.length &&
        previous[start] === next[start]
      ) {
        start++;
      }
      let oldEnd = previous.length;
      let newEnd = next.length;
      while (
        oldEnd > start &&
        newEnd > start &&
        previous[oldEnd - 1] === next[newEnd - 1]
      ) {
        oldEnd--;
        newEnd--;
      }
      const removed = allElements(previous.slice(start, oldEnd) as Element[]);
      const roots = next.slice(start, newEnd) as Element[];
      const added = allElements(roots);
      // A group's postorder slot immediately follows its descendants. At a
      // Page boundary the insertion point is the end of its ordered view.
      const offset = removed.length
        ? ordered.indexOf(removed[0]!)
        : start > 0
          ? ordered.indexOf(previous[start - 1] as Element) + 1
          : 'kind' in parent
            ? ordered.indexOf(parent) - (this.#size.get(parent)! - 1)
            : 0;
      if (added.length <= MAX_GROUP_ELEMENTS) {
        ordered.splice(offset, removed.length, ...added);
      } else {
        // Pages have no node limit; avoid a function-argument limit when a
        // large Page's order changes.
        this.#ordered.set(page, [
          ...ordered.slice(0, offset),
          ...added,
          ...ordered.slice(offset + removed.length),
        ]);
      }
      const retained = new Set(added);
      const affectedNames = new Set<string>();
      for (const node of removed) {
        affectedNames.add(node.name);
        if (!retained.has(node)) {
          this.#nameMembers.get(page)!.get(node.name)?.delete(node);
          this.#unregister(node);
        }
      }
      const visit = (node: Element, parent: Parent, outer: Element): void => {
        this.#register(node);
        this.#parents.set(node, parent);
        this.#pages.set(node, page);
        this.#outer.set(node, outer);
        this.#addName(page, node);
        affectedNames.add(node.name);
        if (isGroupElement(node)) {
          this.#indexMembers(node);
          for (const member of node.members) {
            visit(member, node, outer);
          }
        }
        this.#totals(node);
      };
      for (const node of roots) {
        const outer = 'kind' in parent ? this.#outer.get(parent)! : node;
        if (
          this.#parents.get(node) !== parent ||
          this.#outer.get(node) !== outer
        ) {
          visit(node, parent, outer);
        }
      }
      for (const name of affectedNames) {
        this.#syncName(page, name);
      }
      if ('kind' in parent) {
        this.#indexMembers(parent);
      }
      let ancestor: Parent | undefined = parent;
      while (ancestor && 'kind' in ancestor) {
        this.#totals(ancestor);
        ancestor = this.#parents.get(ancestor);
      }
    }
  }
  #apply(change: TreeChange, forward: boolean): void {
    const owner = this.#nodes.get(change.owner);
    if (!owner) {
      throw new TreeError('History refers to an absent owner');
    }
    if (change.kind === 'field') {
      this.#field(
        owner,
        change.field,
        forward ? change.after : change.before,
        true,
      );
    } else {
      const saved = new Map<number, DeepReadonly<SavedNode>>();
      const visit = (node: DeepReadonly<SavedNode>) => {
        saved.set(node.key, node);
        node.children?.forEach(visit);
      };
      change.nodes.forEach(visit);
      const keys = forward ? change.after : change.before;
      const nodes = keys.map(
        key => this.#nodes.get(key) ?? this.#restore(saved.get(key)!),
      );
      this.#children(owner, nodes);
    }
  }

  transaction<T>(update: () => T): T {
    if (this.#inHook) {
      throw new TreeError('Tree mutations cannot reenter an installation hook');
    }
    if (this.#journal) {
      return update();
    }
    this.#journal = [];
    this.#rollback = [];
    this.#changedOwners = new Set();
    this.#changedPages = new Set();
    this.#assetsChanged = false;
    this.#widthChanged = false;
    this.#structureChanged = false;
    let result: T;
    try {
      result = update();
    } catch (error) {
      try {
        for (const restore of [...this.#rollback].reverse()) {
          restore();
        }
      } finally {
        this.#journal = undefined;
        this.#rollback = undefined;
      }
      throw error;
    }
    const changes = this.#journal;
    this.#journal = undefined;
    this.#rollback = undefined;
    if (changes.length) {
      const event: TreeChangeSet = {
        changes,
        owners: [...this.#changedOwners],
        pages: [...this.#changedPages],
        assets: this.#assetsChanged,
        designWidth: this.#widthChanged,
        structure: this.#structureChanged,
      };
      for (const listener of this.#listeners) {
        listener(event);
      }
    }
    return result;
  }
  replay(journal: TreeJournal, forward: boolean): void {
    this.transaction(() => {
      for (const change of forward ? journal : [...journal].reverse()) {
        this.#apply(change, forward);
      }
    });
  }
  isNetZero(journal: TreeJournal, startingKeys: ReadonlySet<number>): boolean {
    const fields = new Map<
      string,
      { after: unknown; before: unknown; owner: number }
    >();
    for (const change of journal) {
      const key = `${change.owner}:${change.field}`;
      const previous = fields.get(key);
      fields.set(key, {
        owner: change.owner,
        before: previous ? previous.before : change.before,
        after: change.after,
      });
    }
    return [...fields.values()].every(
      change =>
        (!startingKeys.has(change.owner) && !this.#nodes.has(change.owner)) ||
        equal(change.before, change.after),
    );
  }

  setProperty(
    owner: TreeOwner,
    field: string,
    value: string | number | boolean,
  ): void {
    this.transaction(() => {
      const node = this.#mutable(owner);
      const descriptor = propertiesOf(node).get(field);
      if (!descriptor?.set) {
        throw new TreeError(
          'Use the dedicated tree operation for this property',
        );
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new TreeError('Property must be finite');
      }
      const error = descriptor.validate?.(node, value);
      if (error) {
        throw new TreeError(error);
      }
      descriptor.set(node, value, {
        field: (key, next, knownDifferent) =>
          this.#field(node, key, next, knownDifferent),
        geometry: changes => this.setGeometry(node as Element, changes),
        text: next => this.replaceText(node as TextElement, next),
      });
    });
  }
  addLibrary(name: string, source = ''): DeepReadonly<ProjectLibrary> {
    return this.transaction(() => {
      this.#checkLibraryName(name);
      const id =
        this.#allocateId?.() ??
        Math.max(0, ...this.#project.libraries.map(l => l.id ?? 0)) + 1;
      this.#field(this.#project, 'libraries', [
        ...this.#project.libraries,
        { id, name, source },
      ]);
      return this.#project.libraries.at(-1)!;
    });
  }
  #checkLibraryName(name: string, id?: number): void {
    const problem = libraryNameProblem(name);
    if (
      problem ||
      this.#project.libraries.some(
        l => l.name === name && (id === undefined || l.id !== id),
      )
    ) {
      throw new TreeError(problem ?? 'Another Library already has that name.');
    }
  }
  #changeLibrary(
    id: number,
    change: Partial<Pick<ProjectLibrary, 'name' | 'source'>> | undefined,
  ): void {
    this.transaction(() => {
      if (!this.#project.libraries.some(l => l.id === id)) {
        throw new TreeError('Unknown Library');
      }
      if (change?.name !== undefined) {
        this.#checkLibraryName(change.name, id);
      }
      this.#field(
        this.#project,
        'libraries',
        this.#project.libraries.flatMap(l =>
          l.id !== id ? [l] : change ? [{ ...l, ...change }] : [],
        ),
      );
    });
  }
  setLibrarySource(id: number, source: string): void {
    this.#changeLibrary(id, { source });
  }
  renameLibrary(id: number, name: string): void {
    this.#changeLibrary(id, { name });
  }
  removeLibrary(id: number): void {
    this.#changeLibrary(id, undefined);
  }
  setProjectName(name: string): void {
    this.transaction(() => this.#field(this.#project, 'name', name));
  }
  setScript(owner: TreeOwner, source: string): void {
    this.transaction(() => this.#field(this.#mutable(owner), 'script', source));
  }
  replaceRichText(
    element: DeepReadonly<TextElement>,
    value: DeepReadonly<RichText>,
  ): void {
    this.transaction(() =>
      this.#field(this.#mutable(element), 'richText', value),
    );
  }
  replaceText(element: DeepReadonly<TextElement>, value: string): void {
    this.transaction(() => {
      const node = this.#mutable(element);
      const staged = { ...node };
      replacePlainText(staged, value);
      this.#field(node, 'richText', staged.richText, true);
    });
  }
  /** Replaces a Canvas Element's Drawing, as committing Play does. */
  setDrawing(
    element: DeepReadonly<CanvasElement>,
    drawing: DeepReadonly<CanvasElement['drawing']>,
  ): void {
    this.transaction(() =>
      this.#field(this.#mutable(element), 'drawing', drawing),
    );
  }
  setGeometry(element: DeepReadonly<Element>, changes: Partial<Box>): void {
    this.transaction(() => {
      const node = this.#mutable(element);
      const boxes = domain(() =>
        geometryChanges(node, changes, element => {
          const parent = this.#parents.get(element);
          return parent && 'kind' in parent ? parent : undefined;
        }),
      );
      for (const [original, box] of boxes) {
        for (const field of BOX_FIELDS) {
          this.#field(original, field, box[field]);
        }
      }
    });
  }
  #refreshAncestors(element: Element): void {
    this.#refreshGroups(this.#parents.get(element));
  }
  /** Refresh `group`'s bounds, then each enclosing group's. */
  #refreshGroups(group: Parent | undefined): void {
    while (group && 'kind' in group) {
      const staged = { ...group };
      refreshBox(staged);
      for (const field of BOX_FIELDS) {
        this.#field(group, field, staged[field]);
      }
      group = this.#parents.get(group);
    }
  }
  #hook(action: (() => unknown) | undefined): void {
    if (!action) {
      return;
    }
    this.#inHook = true;
    try {
      const result = action();
      if (result && typeof result === 'object' && 'then' in result) {
        throw new TreeError('Tree hooks must complete synchronously');
      }
    } finally {
      this.#inHook = false;
    }
  }
  #publish(
    parent: Parent,
    element: Element,
    hooks: TreeHooks,
  ): DeepReadonly<Element> {
    const page = 'elements' in parent ? parent : this.#pages.get(parent)!;
    const outer = 'elements' in parent ? undefined : this.#outer.get(parent)!;
    if (outer && 'kind' in parent) {
      const staged = detached(outer);
      const stagedParent = allElements([staged])[
        allElements([outer]).indexOf(parent)
      ]! as GroupElement;
      stagedParent.members.push(element);
      domain(() => {
        checkHierarchy([staged]);
        refreshBounds([staged]);
      });
    } else {
      domain(() => {
        checkHierarchy([element]);
        refreshBounds([element]);
      });
    }
    this.#hook(
      hooks.install ? () => hooks.install!(element, parent) : undefined,
    );
    this.#children(parent, [
      ...('elements' in parent ? parent.elements : parent.members),
      element,
    ]);
    this.#refreshAncestors(element);
    this.#touch(page);
    return element;
  }
  create(
    kind: ElementKind,
    parent: TreeParent,
    name?: string,
    hooks: TreeHooks = {},
  ): DeepReadonly<Element> {
    return this.transaction(() => {
      const owner = this.#mutable(parent);
      const page = 'elements' in owner ? owner : this.#pages.get(owner)!;
      const taken = this.#elementNames(page);
      const nextName = name ?? freshName(`${kind}1`, taken);
      if (!isIdentifierName(nextName) || taken.has(nextName)) {
        throw new TreeError('Element name is unavailable');
      }
      this.#hook(
        hooks.authorize
          ? () => hooks.authorize!(this.#ordered.get(page)!.length * 8)
          : undefined,
      );
      return this.#publish(owner, createElement(kind, nextName), hooks);
    });
  }
  insert(
    parent: TreeParent,
    element: DeepReadonly<Element>,
  ): DeepReadonly<Element> {
    return this.transaction(() => {
      const owner = this.#mutable(parent);
      const page = 'elements' in owner ? owner : this.#pages.get(owner)!;
      checkHierarchy([element]);
      const taken = this.#elementNames(page);
      for (const member of allElements([element])) {
        if (!isIdentifierName(member.name) || taken.has(member.name)) {
          throw new TreeError('Element name is unavailable');
        }
        taken.add(member.name);
      }
      const copy = detached(element) as Element;
      for (const member of allElements([copy])) {
        delete member.id;
      }
      return this.#publish(owner, copy, {});
    });
  }
  clone(element: DeepReadonly<Element>, hooks: TreeHooks = {}): CloneResult {
    return this.transaction(() => {
      const node = this.#mutable(element);
      const parent = this.#parents.get(node)!;
      const page = this.#pages.get(node)!;
      const outer = this.#outer.get(node)!;
      if (
        'kind' in parent &&
        this.#size.get(outer)! + this.#size.get(node)! > MAX_GROUP_ELEMENTS
      ) {
        throw new TreeError('Cloning would exceed the group Element limit');
      }
      const cost =
        (this.#work.get(node) ?? 0) +
        (this.#work.get(outer) ?? 0) +
        this.#ordered.get(page)!.length * 8;
      this.#hook(hooks.authorize ? () => hooks.authorize!(cost) : undefined);
      const copy = duplicateElement(node, this.#elementNames(page));
      domain(() =>
        updateGeometry(copy, copy, {
          left: copy.left + 20,
          top: copy.top + 20,
        }),
      );
      this.#publish(parent, copy, hooks);
      const originals = allElements([node]);
      return {
        root: copy,
        pairs: allElements([copy]).map(
          (member, i) => [originals[i]!, member] as const,
        ),
      };
    });
  }
  remove(
    element: DeepReadonly<Element>,
    hooks: Pick<TreeHooks, 'authorize'> = {},
  ): readonly DeepReadonly<Element>[] {
    return this.transaction(() => {
      const node = this.#mutable(element);
      const page = this.#pages.get(node)!;
      const parent = this.#parents.get(node)!;
      const removed = allElements([node]);
      this.#hook(
        hooks.authorize
          ? () =>
              hooks.authorize!(
                this.#ordered.get(page)!.length * 8 + removed.length * 8,
              )
          : undefined,
      );
      this.#children(
        parent,
        children(parent).filter(child => child !== node),
      );
      this.#refreshGroups(parent);
      return removed;
    });
  }
  reorder(parent: TreeParent, order: readonly DeepReadonly<Element>[]): void {
    this.transaction(() => {
      const owner = this.#mutable(parent);
      const previous = children(owner);
      const siblings = new Set(previous);
      if (
        order.length !== previous.length ||
        new Set(order).size !== order.length ||
        order.some(node => !siblings.has(node as Element))
      ) {
        throw new TreeError('Order must be an exact permutation of siblings');
      }
      this.#children(owner, [...order] as Element[]);
    });
  }
  rename(owner: DeepReadonly<Page | Element>, name: string): void {
    this.transaction(() => {
      const node = this.#mutable(owner);
      const isPage = 'elements' in node;
      const pageConflict = this.#project.pages.some(
        page => page.name === name && (isPage ? page.name !== node.name : true),
      );
      const elementConflict = isPage
        ? this.#project.pages.some(page => this.#names.get(page)!.has(name))
        : name !== node.name &&
          this.#names.get(this.#pages.get(node)!)!.has(name);
      if (
        !isIdentifierName(name) ||
        reservedScriptNames.has(name) ||
        pageConflict ||
        elementConflict
      ) {
        throw new TreeError('Name is unavailable');
      }
      this.#field(node, 'name', name);
    });
  }
  group(
    parent: TreeParent,
    members: readonly DeepReadonly<Element>[],
  ): DeepReadonly<GroupElement> {
    return this.transaction(() => {
      const owner = this.#mutable(parent);
      const siblings = children(owner) as Element[];
      const selected = new Set(members);
      if (
        selected.size < 2 ||
        members.some(member => !siblings.includes(member as Element))
      ) {
        throw new TreeError('Grouping requires two or more siblings');
      }
      const page = 'elements' in owner ? owner : this.#pages.get(owner)!;
      const chosen = siblings.filter(node => selected.has(node));
      const position = siblings
        .slice(0, siblings.lastIndexOf(chosen.at(-1)!) + 1)
        .filter(node => !selected.has(node)).length;
      const group = createElement(
        'group',
        freshName('group1', this.#elementNames(page)),
      ) as GroupElement;
      group.members = chosen;
      refreshBounds([group]);
      if ('kind' in owner) {
        const outer = this.#outer.get(owner)!;
        const originals = allElements([outer]);
        const staged = geometryCopy(outer);
        const copies = allElements([staged]);
        const stagedParent = copies[originals.indexOf(owner)]! as GroupElement;
        stagedParent.members = [
          ...owner.members
            .filter(member => !chosen.includes(member))
            .map(member => copies[originals.indexOf(member)]!),
          {
            ...group,
            members: chosen.map(member => copies[originals.indexOf(member)]!),
          },
        ];
        domain(() => {
          checkHierarchy([staged]);
          refreshBounds([staged]);
        });
      } else {
        domain(() => checkHierarchy([group]));
      }
      const next = siblings.filter(node => !selected.has(node));
      next.splice(position, 0, group);
      this.#children(owner, next);
      this.#refreshAncestors(group);
      return group;
    });
  }
  ungroup(
    element: DeepReadonly<GroupElement>,
  ): readonly DeepReadonly<Element>[] {
    return this.transaction(() => {
      const node = this.#mutable(element);
      const parent = this.#parents.get(node)!;
      if (!node.visible) {
        for (const member of node.members) {
          this.#field(member, 'visible', false);
        }
      }
      const next = children(parent).flatMap(child =>
        child === node ? node.members : [child],
      );
      const members = [...node.members];
      this.#children(parent, next);
      this.#refreshGroups(parent);
      return members;
    });
  }
  addPage(after: number): DeepReadonly<Page> {
    return this.transaction(() => {
      const page = createPage(
        freshName(`page${this.#project.pages.length + 1}`, this.#pageNames()),
      );
      const next = [...this.#project.pages];
      next.splice(after + 1, 0, page);
      this.#children(this.#project, next);
      return page;
    });
  }
  duplicatePage(page: DeepReadonly<Page>, after: number): DeepReadonly<Page> {
    return this.transaction(() => {
      const copy = duplicatePage(this.#mutable(page), this.#pageNames());
      const next = [...this.#project.pages];
      next.splice(after + 1, 0, copy);
      this.#children(this.#project, next);
      return copy;
    });
  }
  removePage(page: DeepReadonly<Page>): void {
    this.transaction(() => {
      this.#mutable(page);
      if (this.#project.pages.length === 1) {
        throw new TreeError('A Project must keep at least one Page');
      }
      this.#children(
        this.#project,
        this.#project.pages.filter(node => node !== page),
      );
    });
  }
  movePage(from: number, to: number): void {
    this.transaction(() => {
      const next = [...this.#project.pages];
      const [page] = next.splice(from, 1);
      if (!page || to < 0 || to > next.length) {
        throw new TreeError('Unknown Page position');
      }
      next.splice(to, 0, page);
      this.#children(this.#project, next);
    });
  }
  addAsset(imported: DeepReadonly<Asset>): DeepReadonly<Asset> {
    return this.transaction(() => {
      const existing = this.#project.assets.find(
        asset => asset.hash === imported.hash,
      );
      if (existing) {
        return existing;
      }
      const asset = {
        ...imported,
        name: freshName(
          imported.name,
          new Set(this.#project.assets.map(node => node.name)),
        ),
      };
      this.#field(this.#project, 'assets', [...this.#project.assets, asset]);
      return this.#project.assets.at(-1)!;
    });
  }
  /** Adopt detached Play results by authored id; unchanged owners stay live. */
  adopt(project: DeepReadonly<Project>): void {
    checkHierarchy(project.pages.flatMap(page => page.elements));
    this.transaction(() => {
      const reconcile = (target: Owner, source: TreeOwner): void => {
        const key = childrenKey(target);
        const sourceRecord = source as unknown as Record<string, unknown>;
        for (const field of new Set([
          ...Object.keys(target),
          ...Object.keys(source),
        ])) {
          if (field !== 'id' && field !== key) {
            this.#field(target, field, sourceRecord[field]);
          }
        }
        if (!key) {
          return;
        }
        const previous = children(target);
        const byId = new Map(
          previous
            .filter(node => 'id' in node && node.id !== undefined)
            .map(node => [(node as Page | Element).id!, node]),
        );
        const incoming = (sourceRecord[key] as TreeOwner[]) ?? [];
        const next = incoming.map(node => {
          const existing =
            'id' in node && node.id !== undefined
              ? byId.get(node.id)
              : undefined;
          if (existing) {
            reconcile(existing, node);
            return existing;
          }
          return detached(node) as Owner;
        });
        this.#children(target, next);
      };
      reconcile(this.#project, project);
    });
  }
}

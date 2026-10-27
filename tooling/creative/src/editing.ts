import type { DeepReadonly } from './readonly';
import { allElements, findElement, outerElement } from './tree/rules';
// The Stack editor's state and edits (#749): which Page is showing, which
// Elements are selected, and the moves, resizes, renames and Page edits the
// shell makes. Pure TS over the Project model, so it is tested without a DOM.
import {
  batch,
  computed,
  signal,
  type ReadonlySignal,
} from '@preact/signals-core';
import { equal, ProjectTree, type TreeJournal } from './tree/project-tree';
import { TreeHistory } from './tree/history';
import {
  elementNamesTaken,
  pageNamesTaken,
  reservedScriptNames,
} from './script-names';
import {
  freshName,
  isIdentifierName,
  suggestName,
  type Asset,
  type ButtonElement,
  type CanvasElement,
  type Element,
  type ElementKind,
  type GroupElement,
  type Page,
  type Project,
  type RichText,
  type TextElement,
} from './model';
import { renormalizeRichText, type TextHistory } from './rich-text';

/** The outcome of checking a proposed Page or Element name. */
export type NameCheck =
  { ok: true } | { message: string; ok: false; suggestion: string };

const checkName = (
  name: string,
  taken: ReadonlySet<string>,
  noun: string,
  current?: string,
): NameCheck => {
  if (!isIdentifierName(name)) {
    return {
      ok: false,
      message: `“${name}” isn't a name Scripts can use: start with a letter, then use only letters, digits and _.`,
      suggestion: freshName(suggestName(name), taken),
    };
  }
  if (reservedScriptNames.has(name) || taken.has(name)) {
    return {
      ok: false,
      message: reservedScriptNames.has(name)
        ? `“${name}” is reserved for Scripts.`
        : `Another ${noun} is already named “${name}”.`,
      // Past the current name too, which the author is moving away from.
      suggestion: freshName(name, new Set([...taken, current ?? ''])),
    };
  }
  return { ok: true };
};

const namesExcept = (
  items: readonly { name: string }[],
  except?: string,
): Set<string> =>
  new Set(items.map(i => i.name).filter(name => name !== except));

// Without a Project, only the Page's own Elements and reserved names are known.
const elementNamesNear = (
  page: DeepReadonly<Page>,
  current?: string,
  project?: DeepReadonly<Project>,
) =>
  project
    ? elementNamesTaken(project, page, current)
    : new Set([
        ...reservedScriptNames,
        ...namesExcept(allElements(page.elements), current),
      ]);

/**
 * Checks `name` for an Element on `page`: an identifier, unique within the
 * Page. `current` is the Element's own name, which it may keep.
 */
export const checkElementName = (
  page: DeepReadonly<Page>,
  name: string,
  current?: string,
  project?: DeepReadonly<Project>,
): NameCheck =>
  checkName(
    name,
    elementNamesNear(page, current, project),
    'Element on this Page',
    current,
  );

/** Checks `name` for a Page: an identifier, unique within the Project. */
export const checkPageName = (
  project: DeepReadonly<Project>,
  name: string,
  current?: string,
): NameCheck =>
  checkName(name, pageNamesTaken(project, current), 'Page or Element', current);

/**
 * The name suggested from a button's label, or `undefined` when the button
 * already has it.
 */
export const labelSuggestion = (
  page: DeepReadonly<Page>,
  button: DeepReadonly<ButtonElement>,
  project?: DeepReadonly<Project>,
): string | undefined => {
  const suggestion = freshName(
    suggestName(button.label),
    elementNamesNear(page, button.name, project),
  );
  return suggestion === button.name ? undefined : suggestion;
};

/** A box handle: a corner or the middle of an edge. */
export type Handle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export const HANDLES: readonly Handle[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

export type PageHandle = 'w' | 'e' | 'sw' | 's' | 'se';
export const PAGE_HANDLES: readonly PageHandle[] = ['w', 'e', 'sw', 's', 'se'];
export const MIN_PAGE_WIDTH = 240;
export const MIN_PAGE_HEIGHT = 160;

type Box = Pick<Element, 'height' | 'left' | 'top' | 'width'>;

/** The smallest size a resize leaves; a line may be flat in either direction. */
const minimumSize = (element: DeepReadonly<Element>) =>
  element.kind === 'line' ? 0 : 8;

/**
 * `box` resized by dragging `handle` by (dx, dy) design pixels. The opposite
 * edge stays put, and the size never drops below `minimum`.
 */
export const resizeBox = (
  box: Box,
  handle: Handle,
  dx: number,
  dy: number,
  minimum = 0,
): Box => {
  let { left, top, width, height } = box;
  if (handle.includes('e')) {
    width = Math.max(minimum, box.width + dx);
  }
  if (handle.includes('w')) {
    width = Math.max(minimum, box.width - dx);
    left = box.left + box.width - width;
  }
  if (handle.includes('s')) {
    height = Math.max(minimum, box.height + dy);
  }
  if (handle.includes('n')) {
    height = Math.max(minimum, box.height - dy);
    top = box.top + box.height - height;
  }
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
};

/** A drag in progress. `to` takes the offset from where the drag began. */
export type Gesture = { finish(): void; to(dx: number, dy: number): void };

/** Several live updates that become one undoable edit on `finish`. */
export type Edit = {
  change(update: (edit: EditorTransaction) => void): void;
  finish(): void;
};
type EditorPosition = {
  pageIndex: number;
  pageSelected: boolean;
  scope: number[];
  selection: string[];
};
export type EditorState = EditorPosition & {
  project: DeepReadonly<Project>;
  revision: number;
};
type EditorTransaction = EditorPosition & {
  readonly project: DeepReadonly<Project>;
  readonly tree: ProjectTree;
};
type Root = DeepReadonly<EditorState>;
type PositionView = DeepReadonly<EditorPosition & { project: Project }>;
type HistoryEntry = {
  after: EditorPosition;
  afterContent: number;
  before: EditorPosition;
  beforeContent: number;
  changes: TreeJournal;
};
type PendingEdit = {
  before: EditorPosition;
  beforeContent: number;
  history: TreeHistory;
  keys: ReadonlySet<number>;
};
const copyPosition = (state: DeepReadonly<EditorPosition>): EditorPosition => ({
  pageIndex: state.pageIndex,
  pageSelected: state.pageSelected,
  scope: [...state.scope],
  selection: [...state.selection],
});
export const pageOf = (state: PositionView) =>
  state.project.pages[state.pageIndex]!;
const scopeElements = (
  state: PositionView,
): readonly DeepReadonly<Element>[] => {
  let elements = pageOf(state).elements;
  for (const id of state.scope) {
    const group = elements.find(e => e.id === id);
    if (group?.kind !== 'group') {
      break;
    }
    elements = group.members;
  }
  return elements;
};
const scopeParent = (
  state: PositionView,
): DeepReadonly<Page | GroupElement> => {
  let owner: DeepReadonly<Page | GroupElement> = pageOf(state);
  for (const id of state.scope) {
    const group: DeepReadonly<Element> | undefined = (
      'elements' in owner ? owner.elements : owner.members
    ).find(element => element.id === id);
    if (group?.kind !== 'group') {
      break;
    }
    owner = group;
  }
  return owner;
};
export const selectedOf = (state: PositionView) =>
  scopeElements(state).filter(e => state.selection.includes(e.name));
const elementOf = (state: PositionView, name: string) =>
  findElement(pageOf(state).elements, name);
export type LayerOrder = 'forward' | 'backward' | 'front' | 'back';
const CASCADE = 20;

/** One mutable document authority; signals contain live views and explicit revisions. */
export class StackEditor {
  #tree: ProjectTree;
  #unsubscribe: (() => void) | undefined;
  #position: EditorPosition = {
    pageIndex: 0,
    pageSelected: false,
    scope: [],
    selection: [],
  };
  #state;
  readonly state: ReadonlySignal<Root>;
  #past = signal<HistoryEntry[]>([]);
  #future = signal<HistoryEntry[]>([]);
  #pending = signal<PendingEdit | undefined>(undefined);
  #readOnly = signal(false);
  #sequence = 0;
  #nextContent = 0;
  #content = 0;
  #pageRevisions = new Map<number, number>();
  #assetsRevision = 0;
  #applying = false;
  #replaying = false;
  #noticePending = false;
  readonly currentPage;
  readonly selectedElements;
  readonly undoAvailable;
  readonly redoAvailable;
  onChange: (() => void) | undefined;
  generation = 0;
  #nextId = 0;

  constructor(project: DeepReadonly<Project>) {
    this.#reserveIds(project);
    this.#tree = new ProjectTree(project, () => ++this.#nextId);
    this.#state = signal<Root>(this.#view());
    this.state = this.#state;
    // Include revision in these values: a live node reference alone cannot
    // notify dependants when one of its fields changes.
    this.currentPage = computed(() => ({
      page: pageOf(this.state.value),
      revision: this.state.value.revision,
    }));
    this.selectedElements = computed(() => selectedOf(this.state.value));
    this.undoAvailable = computed(
      () =>
        !this.readOnly && (this.#past.value.length > 0 || this.#pendingChanged),
    );
    this.redoAvailable = computed(
      () =>
        !this.readOnly &&
        this.#future.value.length > 0 &&
        !this.#pendingChanged,
    );
    this.#observeTree();
  }
  #reserveIds(project: DeepReadonly<Project>): void {
    for (const owner of [...project.libraries, ...project.testScripts]) {
      this.#nextId = Math.max(this.#nextId, owner.id ?? 0);
    }
    for (const page of project.pages) {
      this.#nextId = Math.max(this.#nextId, page.id ?? 0);
      for (const element of allElements(page.elements)) {
        this.#nextId = Math.max(this.#nextId, element.id ?? 0);
      }
    }
  }
  #view(): Root {
    return Object.freeze({
      ...this.#position,
      scope: Object.freeze([...this.#position.scope]),
      selection: Object.freeze([...this.#position.selection]),
      project: this.#tree.project,
      revision: this.#sequence,
    });
  }
  #publish(): void {
    const previous = this.#state.peek();
    const next = this.#view();
    if (
      previous.revision !== next.revision ||
      previous.project !== next.project ||
      previous.pageIndex !== next.pageIndex ||
      previous.pageSelected !== next.pageSelected ||
      !equal(previous.scope, next.scope) ||
      !equal(previous.selection, next.selection)
    ) {
      this.#state.value = next;
    }
    if (this.#noticePending) {
      this.#noticePending = false;
      if (!this.readOnly) {
        this.onChange?.();
      }
    }
  }
  #observeTree(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = this.#tree.subscribe(event => {
      this.#sequence++;
      this.#content = ++this.#nextContent;
      for (const page of event.pages) {
        if (page.id !== undefined) {
          this.#pageRevisions.set(
            page.id,
            (this.#pageRevisions.get(page.id) ?? 0) + 1,
          );
        }
      }
      if (event.assets) {
        this.#assetsRevision++;
      }
      const pending = this.#pending.peek();
      if (pending && !this.#replaying) {
        pending.history.append(event.changes);
        this.#pending.value = { ...pending };
      }
      this.#noticePending = true;
      if (!this.#applying) {
        this.#publish();
      }
    });
  }
  get project(): DeepReadonly<Project> {
    return this.#tree.project;
  }
  snapshot(): DeepReadonly<Project> {
    return this.#tree.snapshot();
  }
  stamp(): { generation: number; revision: number } {
    return { generation: this.generation, revision: this.revision };
  }
  isCurrent(stamp: { generation: number; revision: number }): boolean {
    return (
      this.generation === stamp.generation && this.revision === stamp.revision
    );
  }
  capture(): {
    contentState: number;
    generation: number;
    project: DeepReadonly<Project>;
    revision: number;
  } {
    return {
      ...this.stamp(),
      contentState: this.contentState,
      project: this.snapshot(),
    };
  }
  get revision(): number {
    return this.#sequence;
  }
  get contentState(): number {
    return this.#content;
  }
  pageRevision(id: number): number {
    void this.state.value;
    return this.#pageRevisions.get(id) ?? 0;
  }
  get assetsRevision(): number {
    void this.state.value;
    return this.#assetsRevision;
  }
  get readOnly(): boolean {
    return this.#readOnly.value;
  }
  set readOnly(value: boolean) {
    this.#readOnly.value = value;
    if (value) {
      this.#finish();
    }
  }

  #update(change: (edit: EditorTransaction) => void): void {
    this.#change(change);
  }
  #change(change: (edit: EditorTransaction) => void): void {
    const before = this.#position;
    const position: EditorTransaction = {
      ...copyPosition(before),
      project: this.project,
      tree: this.#tree,
    };
    this.#applying = true;
    try {
      this.#tree.transaction(() => {
        change(position);
        let elements = pageOf(position).elements;
        position.scope = position.scope.filter(id => {
          const group = elements.find(e => e.id === id);
          if (group?.kind !== 'group') {
            return false;
          }
          elements = group.members;
          return true;
        });
        this.#position = copyPosition(position);
      });
    } catch (error) {
      this.#position = before;
      throw error;
    } finally {
      this.#applying = false;
    }
    this.#publish();
  }
  replaceProject(project: DeepReadonly<Project>): void {
    batch(() => {
      this.generation++;
      this.#sequence++;
      this.#content = ++this.#nextContent;
      this.#pending.value = undefined;
      this.#past.value = [];
      this.#future.value = [];
      this.#position = {
        pageIndex: 0,
        pageSelected: false,
        scope: [],
        selection: [],
      };
      this.#reserveIds(project);
      this.#tree = new ProjectTree(project, () => ++this.#nextId);
      this.#pageRevisions.clear();
      this.#assetsRevision++;
      this.#noticePending = false;
      this.#observeTree();
      this.#publish();
    });
  }
  finishPendingEdit(): void {
    this.#finish();
  }
  get #pendingChanged(): boolean {
    const pending = this.#pending.value;
    return (
      !!pending && !this.#tree.isNetZero(pending.history.changes, pending.keys)
    );
  }
  #finish(): void {
    batch(() => {
      const pending = this.#pending.peek();
      if (!pending) {
        return;
      }
      const changed = !this.#tree.isNetZero(
        pending.history.changes,
        pending.keys,
      );
      if (changed && this.readOnly) {
        this.#replaying = true;
        this.#applying = true;
        try {
          this.#tree.replay(pending.history.changes, false);
        } finally {
          this.#replaying = false;
          this.#applying = false;
        }
        this.#position = copyPosition(pending.before);
        this.#content = pending.beforeContent;
      } else if (changed) {
        this.#past.value = [
          ...this.#past.peek(),
          {
            before: pending.before,
            after: copyPosition(this.#position),
            beforeContent: pending.beforeContent,
            afterContent: this.#content,
            changes: pending.history.snapshot(),
          },
        ];
        this.#future.value = [];
      } else {
        this.#content = pending.beforeContent;
      }
      this.#pending.value = undefined;
      this.#publish();
    });
  }
  get canUndo(): boolean {
    return this.undoAvailable.value;
  }
  get canRedo(): boolean {
    return this.redoAvailable.value;
  }
  edit<T>(change: (edit: EditorTransaction) => T): T {
    const edit = this.startEdit();
    let result!: T;
    batch(() => {
      try {
        edit.change(context => {
          result = change(context);
        });
      } finally {
        edit.finish();
      }
    });
    return result;
  }
  startEdit(): Edit {
    return this.#startEdit();
  }
  #startEdit(): Edit {
    this.#finish();
    const pending: PendingEdit = {
      before: copyPosition(this.#position),
      beforeContent: this.#content,
      keys: this.#tree.historyKeys(),
      history: new TreeHistory(),
    };
    this.#pending.value = pending;
    return {
      change: update => {
        if (this.#pending.peek()?.keys === pending.keys && !this.readOnly) {
          batch(() => this.#change(update));
        }
      },
      finish: () => {
        if (this.#pending.peek()?.keys === pending.keys) {
          this.#finish();
        }
      },
    };
  }
  #restore(entry: HistoryEntry, forward: boolean): void {
    this.#applying = true;
    this.#replaying = true;
    try {
      this.#tree.replay(entry.changes, forward);
    } finally {
      this.#applying = false;
      this.#replaying = false;
    }
    this.#position = copyPosition(forward ? entry.after : entry.before);
    this.#content = forward ? entry.afterContent : entry.beforeContent;
    this.#publish();
  }
  undo(): void {
    batch(() => {
      this.#finish();
      const entry = this.readOnly ? undefined : this.#past.peek().at(-1);
      if (entry) {
        this.#restore(entry, false);
        this.#past.value = this.#past.peek().slice(0, -1);
        this.#future.value = [...this.#future.peek(), entry];
      }
    });
  }
  redo(): void {
    batch(() => {
      this.#finish();
      const entry = this.readOnly ? undefined : this.#future.peek().at(-1);
      if (entry) {
        this.#restore(entry, true);
        this.#future.value = this.#future.peek().slice(0, -1);
        this.#past.value = [...this.#past.peek(), entry];
      }
    });
  }
  get pageIndex(): number {
    return this.state.value.pageIndex;
  }
  get page(): DeepReadonly<Page> {
    return this.currentPage.value.page;
  }
  get selection(): readonly string[] {
    return this.state.value.selection;
  }
  get selected(): DeepReadonly<Element[]> {
    return this.selectedElements.value;
  }
  element(name: string): DeepReadonly<Element> | undefined {
    return findElement(this.page.elements, name);
  }

  /** Text edits for a text Element on the showing Page, one undo step each. */
  textHistory(element: DeepReadonly<TextElement>): TextHistory {
    return new EditorTextHistory(this, element);
  }

  /**
   * Selects as a click does. A plain click on an Element selects only it,
   * unless it is already selected, so a group can be dragged. Shift-click
   * adds or removes it. A click on empty space (`undefined`) selects the Page.
   */
  click(name: string | undefined, { shift = false } = {}): void {
    this.#finish();
    this.#update(draft => {
      let resolved = name
        ? outerElement(scopeElements(draft), name)
        : undefined;
      if (name && !resolved) {
        draft.scope = [];
        resolved = outerElement(pageOf(draft).elements, name);
        draft.selection = [];
      }
      name = resolved?.name;
      if (name === undefined) {
        if (!shift) {
          draft.selection = [];
          draft.scope = [];
          draft.pageSelected = true;
        }
        return;
      }
      draft.pageSelected = false;
      if (shift) {
        draft.selection = draft.selection.includes(name)
          ? draft.selection.filter(n => n !== name)
          : [...draft.selection, name];
      } else if (!draft.selection.includes(name)) {
        draft.selection = [name];
      }
    });
  }

  get scope(): readonly number[] {
    return this.state.value.scope;
  }
  get canGroup(): boolean {
    return !this.readOnly && this.selected.length >= 2;
  }
  get canUngroup(): boolean {
    return !this.readOnly && this.selected.some(e => e.kind === 'group');
  }
  selectable(name: string): DeepReadonly<Element> | undefined {
    return outerElement(scopeElements(this.state.value), name);
  }
  enterGroup(name: string): void {
    this.#finish();
    this.#update(draft => {
      const group = scopeElements(draft).find(e => e.name === name);
      if (group?.kind === 'group') {
        draft.scope.push(group.id!);
        draft.selection = [];
        draft.pageSelected = false;
      }
    });
  }
  leaveGroup(): void {
    if (!this.scope.length) {
      this.selectPage();
      return;
    }
    this.#finish();
    this.#update(draft => {
      const id = draft.scope.pop();
      const group = scopeElements(draft).find(e => e.id === id);
      draft.selection = group ? [group.name] : [];
      draft.pageSelected = false;
    });
  }
  groupSelection(): void {
    if (!this.canGroup) {
      return;
    }
    this.edit(edit => {
      const group = edit.tree.group(scopeParent(edit), selectedOf(edit));
      edit.selection = [group.name];
    });
  }
  ungroupSelection(): void {
    if (!this.canUngroup) {
      return;
    }
    this.edit(edit => {
      const names: string[] = [];
      for (const element of selectedOf(edit)) {
        if (element.kind === 'group') {
          names.push(...edit.tree.ungroup(element).map(member => member.name));
        } else {
          names.push(element.name);
        }
      }
      edit.selection = names;
    });
  }

  selectPage(): void {
    this.#finish();
    this.#update(draft => {
      draft.selection = [];
      draft.scope = [];
      draft.pageSelected = true;
    });
  }

  /** Adds an Element of `kind` named like `button1`, and selects it. */
  addElement(kind: ElementKind): DeepReadonly<Element> {
    return this.edit(edit => {
      const page = pageOf(edit);
      const step = (page.elements.length % 10) * CASCADE;
      const element = edit.tree.create(kind, scopeParent(edit));
      edit.tree.setGeometry(element, {
        left: element.left + step,
        top: element.top + step,
      });
      edit.selection = [element.name];
      edit.pageSelected = false;
      return element;
    });
  }

  /** Adds or replaces a picture and its asset name as one undoable edit. */
  setImage(
    imported: Asset,
    replacement?: string,
    position?: { left: number; top: number },
  ): void {
    if (this.readOnly) {
      return;
    }
    const target = replacement ? this.element(replacement) : undefined;
    if (replacement && target?.kind !== 'image') {
      return;
    }
    this.edit(edit => {
      const asset = edit.tree.addAsset(imported);
      if (target?.kind === 'image') {
        edit.tree.setProperty(target, 'image', asset.name);
      } else {
        const element = edit.tree.create('image', scopeParent(edit));
        edit.tree.setProperty(element, 'image', asset.name);
        if (position) {
          edit.tree.setGeometry(element, position);
        }
        edit.selection = [element.name];
        edit.pageSelected = false;
      }
    });
  }
  /** Adds sound metadata without duplicating content-addressed assets. */
  addSound(imported: Asset): string {
    if (this.readOnly) {
      return imported.name;
    }
    return this.edit(edit => edit.tree.addAsset(imported).name);
  }

  /** Starts moving the selected Elements; offsets are in design pixels. */
  startMove(): Gesture {
    const origins = this.selected.map(e => ({
      name: e.name,
      left: e.left,
      top: e.top,
    }));
    const edit = this.#startEdit();
    return {
      finish: edit.finish,
      to(dx, dy) {
        edit.change(draft => {
          for (const { name, left, top } of origins) {
            const e = elementOf(draft, name)!;
            draft.tree.setGeometry(e, {
              left: Math.round(left + dx),
              top: Math.round(top + dy),
            });
          }
        });
      },
    };
  }

  /** Starts resizing the one selected Element by a handle, if exactly one is. */
  startResize(handle: Handle): Gesture | undefined {
    const [element] = this.selected;
    if (!element || element.kind === 'group' || this.selection.length !== 1) {
      return undefined;
    }
    const origin: Box = { ...element };
    const edit = this.#startEdit();
    return {
      finish: edit.finish,
      to(dx, dy) {
        edit.change(draft => {
          draft.tree.setGeometry(
            elementOf(draft, element.name)!,
            resizeBox(origin, handle, dx, dy, minimumSize(element)),
          );
        });
      },
    };
  }

  /**
   * Resize the Page around its horizontal centre, keeping its top fixed.
   * Width is Project-wide; only the showing Page's height changes.
   */
  startPageResize(handle: PageHandle): Gesture | undefined {
    if (this.readOnly) {
      return undefined;
    }
    const page = this.page;
    const width = this.project.designWidth;
    const height = page.height;
    const edit = this.#startEdit();
    return {
      finish: edit.finish,
      to: (dx, dy) => {
        edit.change(draft => {
          if (handle.includes('e') || handle.includes('w')) {
            const change = handle.includes('w') ? -dx : dx;
            draft.tree.setProperty(
              draft.project,
              'designWidth',
              Math.max(MIN_PAGE_WIDTH, Math.round(width + change * 2)),
            );
          }
          if (handle.includes('s')) {
            draft.tree.setProperty(
              pageOf(draft),
              'height',
              Math.max(MIN_PAGE_HEIGHT, Math.round(height + dy)),
            );
          }
        });
      },
    };
  }

  /** Renames an Element on the showing Page, if the name passes the check. */
  renameElement(current: string, name: string): NameCheck {
    const element = this.element(current);
    if (!element) {
      throw new Error(`No Element is named “${current}”`);
    }
    const check = checkElementName(this.page, name, current, this.project);
    if (check.ok) {
      this.edit(draft => {
        draft.tree.rename(elementOf(draft, current)!, name);
        draft.selection = draft.selection.map(n => (n === current ? name : n));
      });
    }
    return check;
  }

  /** Renames the showing Page, if the name passes the check. */
  renamePage(name: string): NameCheck {
    const check = checkPageName(this.project, name, this.page.name);
    if (check.ok) {
      this.edit(draft => {
        draft.tree.rename(pageOf(draft), name);
      });
    }
    return check;
  }

  /** Shows the Page at `index` and selects it. */
  goToPage(index: number): void {
    this.#finish();
    this.#update(draft => {
      if (index < 0 || index >= this.project.pages.length) {
        return;
      }
      draft.pageIndex = index;
      draft.selection = [];
      draft.scope = [];
      draft.pageSelected = true;
    });
  }

  previousPage(): void {
    this.goToPage(this.pageIndex - 1);
  }

  nextPage(): void {
    this.goToPage(this.pageIndex + 1);
  }

  /** Adds a Page after the showing one, and shows it. */
  addPage(): DeepReadonly<Page> {
    return this.edit(edit => {
      const page = edit.tree.addPage(edit.pageIndex);
      edit.pageIndex++;
      edit.scope = [];
      edit.selection = [];
      edit.pageSelected = false;
      return page;
    });
  }
  /** Empties a Canvas's Drawing, back to the default style (ADR 0116). */
  clearDrawing(element: DeepReadonly<CanvasElement>): void {
    this.edit(({ tree }) => tree.setDrawing(element, []));
  }
  movePage(from: number, to: number): void {
    const pages = this.project.pages;
    if (from < 0 || from >= pages.length || to < 0 || to >= pages.length) {
      return;
    }
    this.edit(edit => {
      const showing = pageOf(edit);
      edit.tree.movePage(from, to);
      edit.pageIndex = edit.project.pages.indexOf(showing);
    });
  }
  duplicate(): void {
    this.edit(edit => {
      edit.pageSelected = false;
      if (edit.selection.length) {
        edit.selection = selectedOf(edit).map(
          element => edit.tree.clone(element).root.name,
        );
      } else {
        edit.scope = [];
        edit.tree.duplicatePage(pageOf(edit), edit.pageIndex);
        edit.pageIndex++;
      }
    });
  }

  /** The editor keeps at least one Page in the authored Project. */
  get canDelete(): boolean {
    return (
      this.selection.length > 0 ||
      (this.state.value.pageSelected && this.project.pages.length > 1)
    );
  }

  /** Deletes the selected Elements, or the Page only when it is selected. */
  delete(): void {
    if (!this.canDelete) {
      return;
    }
    this.edit(edit => {
      edit.pageSelected = false;
      if (edit.selection.length) {
        for (const element of selectedOf(edit)) {
          edit.tree.remove(element);
        }
        edit.selection = [];
      } else {
        edit.scope = [];
        edit.tree.removePage(pageOf(edit));
        edit.pageIndex = Math.min(
          edit.pageIndex,
          edit.project.pages.length - 1,
        );
      }
    });
  }

  /** Keeps selected Elements' relative order, including adjacent groups. */
  orderLayers(order: LayerOrder): void {
    this.edit(draft => {
      const elements = [...scopeElements(draft)];
      const selection = new Set(draft.selection);
      const selected = (element: DeepReadonly<Element>) =>
        selection.has(element.name);
      if (order === 'front' || order === 'back') {
        const chosen = elements.filter(selected);
        const others = elements.filter(e => !selected(e));
        elements.splice(
          0,
          elements.length,
          ...(order === 'front'
            ? [...others, ...chosen]
            : [...chosen, ...others]),
        );
      } else if (order === 'forward') {
        for (let i = elements.length - 2; i >= 0; i--) {
          if (selected(elements[i]!) && !selected(elements[i + 1]!)) {
            [elements[i], elements[i + 1]] = [elements[i + 1]!, elements[i]!];
          }
        }
      } else {
        for (let i = 1; i < elements.length; i++) {
          if (selected(elements[i]!) && !selected(elements[i - 1]!)) {
            [elements[i], elements[i - 1]] = [elements[i - 1]!, elements[i]!];
          }
        }
      }
      draft.tree.reorder(scopeParent(draft), elements);
    });
  }
}

class EditorTextHistory implements TextHistory {
  #last: DeepReadonly<TextElement>;
  constructor(
    readonly editor: StackEditor,
    element: DeepReadonly<TextElement>,
  ) {
    const current = editor.element(element.name);
    this.#last = current?.kind === 'text' ? current : element;
  }
  get canUndo(): boolean {
    return this.editor.canUndo;
  }
  get canRedo(): boolean {
    return this.editor.canRedo;
  }
  get element(): DeepReadonly<TextElement> {
    const found = allElements(this.editor.page.elements).find(
      e => e.id === this.#last.id,
    );
    if (found?.kind === 'text') {
      this.#last = found;
    }
    return this.#last;
  }
  set(text: DeepReadonly<RichText>): void {
    const target = this.element;
    const next = renormalizeRichText(text);
    if (!equal(next, renormalizeRichText(target.richText))) {
      this.editor.edit(draft => {
        const element = elementOf(draft, target.name);
        if (element?.kind === 'text') {
          draft.tree.replaceRichText(element, next);
        }
      });
    }
  }
  undo(): void {
    this.editor.undo();
  }
  redo(): void {
    this.editor.redo();
  }
}

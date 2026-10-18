import {
  allElements,
  findElement,
  checkHierarchy,
  refreshBounds,
  groupElement,
  outerElement,
  updateGeometry,
} from './hierarchy';
// The Stack editor's state and edits (#749): which Page is showing, which
// Elements are selected, and the moves, resizes, renames and Page edits the
// shell makes. Pure TS over the Project model, so it is tested without a DOM.
import {
  batch,
  computed,
  effect,
  signal,
  untracked,
  type ReadonlySignal,
} from '@preact/signals-core';
import { castDraft, freeze, produce, type Immutable } from 'immer';
import {
  elementNamesTaken,
  pageNamesTaken,
  reservedScriptNames,
} from './script-names';
import {
  createElement,
  createPage,
  duplicateElement,
  duplicatePage,
  freshName,
  isIdentifierName,
  suggestName,
  type Asset,
  type ButtonElement,
  type Element,
  type ElementKind,
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
  page: Immutable<Page>,
  current?: string,
  project?: Immutable<Project>,
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
  page: Immutable<Page>,
  name: string,
  current?: string,
  project?: Immutable<Project>,
): NameCheck =>
  checkName(
    name,
    elementNamesNear(page, current, project),
    'Element on this Page',
    current,
  );

/** Checks `name` for a Page: an identifier, unique within the Project. */
export const checkPageName = (
  project: Immutable<Project>,
  name: string,
  current?: string,
): NameCheck =>
  checkName(name, pageNamesTaken(project, current), 'Page or Element', current);

/**
 * The name suggested from a button's label, or `undefined` when the button
 * already has it.
 */
export const labelSuggestion = (
  page: Immutable<Page>,
  button: Immutable<ButtonElement>,
  project?: Immutable<Project>,
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
const minimumSize = (element: Immutable<Element>) =>
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
  change(update: (draft: EditorState) => void): void;
  finish(): void;
};

export type EditorState = {
  pageIndex: number;
  pageSelected: boolean;
  project: Project;
  scope: number[];
  selection: string[];
};
type Root = Immutable<EditorState>;
type HistoryEntry = { after: Root; before: Root };
export const pageOf = (state: EditorState) =>
  state.project.pages[state.pageIndex]!;
export function scopeElements(state: EditorState): Element[];
export function scopeElements(
  state: Immutable<EditorState>,
): Immutable<Element[]>;
export function scopeElements(
  state: Immutable<EditorState>,
): Immutable<Element[]> {
  let elements = state.project.pages[state.pageIndex]!.elements;
  for (const id of state.scope) {
    const group = elements.find(e => e.id === id);
    if (group?.kind !== 'group') {
      break;
    }
    elements = group.members;
  }
  return elements;
}
export const selectedOf = (state: EditorState) =>
  scopeElements(state).filter(e => state.selection.includes(e.name));
export const elementOf = (state: EditorState, name: string) =>
  findElement(pageOf(state).elements, name);

export type LayerOrder = 'forward' | 'backward' | 'front' | 'back';

/** Where a new Element goes: down and right of the last one added. */
const CASCADE = 20;

/** Immutable authored state. Every write runs on an Immer draft. */
export class StackEditor {
  #state;
  readonly state: ReadonlySignal<Root>;
  #past = signal<HistoryEntry[]>([]);
  #future = signal<HistoryEntry[]>([]);
  #pending = signal<{ before: Root } | undefined>(undefined);
  #readOnly = signal(false);
  readonly currentPage;
  readonly selectedElements;
  readonly undoAvailable;
  readonly redoAvailable;

  /** Told by an effect when the authored Project changes, including live edits. */
  onChange: (() => void) | undefined;
  /** Incremented when switching Projects or loading a stored version. */
  generation = 0;

  constructor(project: Immutable<Project>) {
    this.#state = signal<Root>(this.#initial(project));
    this.state = this.#state;
    this.currentPage = computed(
      () => this.state.value.project.pages[this.state.value.pageIndex]!,
    );
    this.selectedElements = computed(() =>
      scopeElements(this.state.value).filter(e =>
        this.state.value.selection.includes(e.name),
      ),
    );
    this.undoAvailable = computed(
      () =>
        !this.#readOnly.value &&
        (this.#past.value.length > 0 || this.#pendingChanged),
    );
    this.redoAvailable = computed(
      () =>
        !this.#readOnly.value &&
        this.#future.value.length > 0 &&
        !this.#pendingChanged,
    );
    let previous = this.project;
    let generation = this.generation;
    effect(() => {
      const project = this.state.value.project;
      const changed = previous !== project && generation === this.generation;
      previous = project;
      generation = this.generation;
      if (changed) {
        untracked(() => {
          if (!this.readOnly) {
            this.onChange?.();
          }
        });
      }
    });
  }

  #initial(project: Immutable<Project>): Root {
    const copy = castDraft(structuredClone(project));
    checkHierarchy(copy.pages.flatMap(page => page.elements));
    for (const page of copy.pages) {
      refreshBounds(page.elements);
    }
    this.#assignIds(copy);
    return freeze(
      {
        project: copy,
        pageIndex: 0,
        selection: [],
        pageSelected: false,
        scope: [],
      },
      true,
    );
  }

  /** Gives each Page and Element without a session id a fresh one. */
  #assignIds(project: Project): void {
    for (const page of project.pages) {
      page.id ??= this.#id();
      for (const element of allElements(page.elements)) {
        element.id ??= this.#id();
      }
    }
  }

  #nextId = 0;
  #id(): number {
    return ++this.#nextId;
  }

  get project(): Immutable<Project> {
    return this.state.value.project;
  }
  get readOnly(): boolean {
    return this.#readOnly.value;
  }
  set readOnly(value: boolean) {
    this.#readOnly.value = value;
  }

  #update(change: (draft: EditorState) => void): void {
    this.#state.value = produce(this.#state.peek(), change);
  }

  /** Loads an independent frozen Project, resetting history without an edit notice. */
  replaceProject(project: Immutable<Project>): void {
    batch(() => {
      this.generation++;
      this.#pending.value = undefined;
      this.#past.value = [];
      this.#future.value = [];
      this.#state.value = this.#initial(project);
    });
  }

  finishPendingEdit(): void {
    this.#finish();
  }

  get #pendingChanged(): boolean {
    const pending = this.#pending.value;
    return !!pending && pending.before.project !== this.project;
  }

  #finish(): void {
    batch(() => {
      const pending = this.#pending.peek();
      if (pending && pending.before.project !== this.project) {
        if (this.readOnly) {
          this.#state.value = pending.before;
        } else {
          this.#past.value = [
            ...this.#past.peek(),
            { before: pending.before, after: this.#state.peek() },
          ];
          this.#future.value = [];
        }
      }
      this.#pending.value = undefined;
    });
  }

  get canUndo(): boolean {
    return this.undoAvailable.value;
  }
  get canRedo(): boolean {
    return this.redoAvailable.value;
  }

  /** Records any authored Project change, including Info and future Script edits. */
  edit<T>(change: (draft: EditorState) => T): T {
    const edit = this.startEdit();
    let result!: T;
    batch(() => {
      try {
        edit.change(draft => {
          result = change(draft);
        });
      } finally {
        edit.finish();
      }
    });
    return result;
  }

  /** Starts live immutable updates, recorded as one undo step on finish. */
  startEdit(): Edit {
    return this.#startEdit(false);
  }

  // Gestures use absolute offsets from their starting root. Returning to the
  // origin therefore restores that same root and preserves redo.
  #startEdit(fromStart: boolean): Edit {
    this.#finish();
    const pending = { before: this.#state.peek() };
    this.#pending.value = pending;
    return {
      change: update => {
        if (this.#pending.peek() === pending && !this.readOnly) {
          const base = fromStart ? pending.before : this.#state.peek();
          this.#state.value = produce(base, draft => {
            update(draft);
            checkHierarchy(draft.project.pages.flatMap(page => page.elements));
            for (const page of draft.project.pages) {
              refreshBounds(page.elements);
            }
            this.#assignIds(draft.project);
            let elements = pageOf(draft).elements;
            const validScope = draft.scope.filter(id => {
              const group = elements.find(e => e.id === id);
              if (group?.kind !== 'group') {
                return false;
              }
              elements = group.members;
              return true;
            });
            if (validScope.length !== draft.scope.length) {
              draft.scope = validScope;
            }
          });
        }
      },
      finish: () => {
        if (this.#pending.peek() === pending) {
          this.#finish();
        }
      },
    };
  }

  undo(): void {
    batch(() => {
      this.#finish();
      const entry = this.readOnly ? undefined : this.#past.peek().at(-1);
      if (entry) {
        this.#past.value = this.#past.peek().slice(0, -1);
        this.#future.value = [...this.#future.peek(), entry];
        this.#state.value = entry.before;
      }
    });
  }

  redo(): void {
    batch(() => {
      this.#finish();
      const entry = this.readOnly ? undefined : this.#future.peek().at(-1);
      if (entry) {
        this.#future.value = this.#future.peek().slice(0, -1);
        this.#past.value = [...this.#past.peek(), entry];
        this.#state.value = entry.after;
      }
    });
  }

  get pageIndex(): number {
    return this.state.value.pageIndex;
  }
  get page(): Immutable<Page> {
    return this.currentPage.value;
  }
  get selection(): readonly string[] {
    return this.state.value.selection;
  }
  get selected(): Immutable<Element[]> {
    return this.selectedElements.value;
  }
  element(name: string): Immutable<Element> | undefined {
    return findElement(this.page.elements, name);
  }

  /** Text edits for a text Element on the showing Page, one undo step each. */
  textHistory(element: Immutable<TextElement>): TextHistory {
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
  selectable(name: string): Immutable<Element> | undefined {
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
    this.edit(draft => {
      const elements = scopeElements(draft);
      const members = selectedOf(draft);
      const chosen = new Set(members);
      const last =
        elements.length -
        1 -
        [...elements].reverse().findIndex(e => chosen.has(e));
      const position = elements
        .slice(0, last + 1)
        .filter(e => !chosen.has(e)).length;
      const group = groupElement(
        freshName('group1', elementNamesTaken(draft.project, pageOf(draft))),
        members,
      );
      const others = elements.filter(e => !chosen.has(e));
      others.splice(position, 0, group);
      elements.splice(0, elements.length, ...others);
      draft.selection = [group.name];
    });
  }
  ungroupSelection(): void {
    if (!this.canUngroup) {
      return;
    }
    this.edit(draft => {
      const elements = scopeElements(draft);
      const names: string[] = [];
      const next = elements.flatMap(e => {
        if (draft.selection.includes(e.name) && e.kind === 'group') {
          for (const member of e.members) {
            if (!e.visible) {
              member.visible = false;
            }
            names.push(member.name);
          }
          return e.members;
        }
        if (draft.selection.includes(e.name)) {
          names.push(e.name);
        }
        return [e];
      });
      elements.splice(0, elements.length, ...next);
      draft.selection = names;
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
  addElement(kind: ElementKind): Immutable<Element> {
    return this.edit(draft => {
      const page = pageOf(draft);
      const element = createElement(
        kind,
        freshName(`${kind}1`, elementNamesTaken(draft.project, page)),
      );
      const step = (page.elements.length % 10) * CASCADE;
      element.left += step;
      element.top += step;
      scopeElements(draft).push(element);
      draft.selection = [element.name];
      draft.pageSelected = false;
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
    this.edit(draft => {
      let asset = draft.project.assets.find(a => a.hash === imported.hash);
      if (!asset) {
        asset = {
          ...imported,
          name: freshName(imported.name, namesExcept(draft.project.assets)),
        };
        draft.project.assets.push(asset);
      }
      if (target?.kind === 'image') {
        const image = elementOf(draft, target.name);
        if (image?.kind === 'image') {
          image.image = asset.name;
        }
      } else {
        const element = createElement(
          'image',
          freshName('image1', elementNamesTaken(draft.project, pageOf(draft))),
        );
        if (element.kind !== 'image') {
          return;
        }
        element.image = asset.name;
        if (position) {
          Object.assign(element, position);
        }
        scopeElements(draft).push(element);
        draft.selection = [element.name];
        draft.pageSelected = false;
      }
    });
  }

  /**
   * Adds a sound to the asset table as one undoable edit, returning the name
   * Scripts use for it. Identical bytes keep their existing name.
   */
  addSound(imported: Asset): string {
    if (this.readOnly) {
      return imported.name;
    }
    return this.edit(draft => {
      let asset = draft.project.assets.find(a => a.hash === imported.hash);
      if (!asset) {
        asset = {
          ...imported,
          name: freshName(imported.name, namesExcept(draft.project.assets)),
        };
        draft.project.assets.push(asset);
      }
      return asset.name;
    });
  }

  /** Starts moving the selected Elements; offsets are in design pixels. */
  startMove(): Gesture {
    const origins = this.selected.map(e => ({
      name: e.name,
      left: e.left,
      top: e.top,
    }));
    const edit = this.#startEdit(true);
    return {
      finish: edit.finish,
      to(dx, dy) {
        edit.change(draft => {
          for (const { name, left, top } of origins) {
            const e = elementOf(draft, name)!;
            updateGeometry(outerElement(pageOf(draft).elements, name)!, e, {
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
    const edit = this.#startEdit(true);
    return {
      finish: edit.finish,
      to(dx, dy) {
        edit.change(draft => {
          Object.assign(
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
    const edit = this.#startEdit(true);
    return {
      finish: edit.finish,
      to: (dx, dy) => {
        edit.change(draft => {
          if (handle.includes('e') || handle.includes('w')) {
            const change = handle.includes('w') ? -dx : dx;
            draft.project.designWidth = Math.max(
              MIN_PAGE_WIDTH,
              Math.round(width + change * 2),
            );
          }
          if (handle.includes('s')) {
            pageOf(draft).height = Math.max(
              MIN_PAGE_HEIGHT,
              Math.round(height + dy),
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
        elementOf(draft, current)!.name = name;
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
        pageOf(draft).name = name;
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
  addPage(): Immutable<Page> {
    return this.edit(draft => {
      const page = createPage(
        freshName(
          `page${draft.project.pages.length + 1}`,
          pageNamesTaken(draft.project),
        ),
      );
      draft.project.pages.splice(draft.pageIndex + 1, 0, page);
      draft.pageIndex++;
      draft.scope = [];
      draft.selection = [];
      draft.pageSelected = false;
      return page;
    });
  }

  /** Moves the Page at `from` to `to`; the showing Page stays showing. */
  movePage(from: number, to: number): void {
    const pages = this.project.pages;
    if (from < 0 || from >= pages.length || to < 0 || to >= pages.length) {
      return;
    }
    this.edit(draft => {
      const pages = draft.project.pages;
      const showing = pageOf(draft);
      const [moved] = pages.splice(from, 1);
      pages.splice(to, 0, moved!);
      draft.pageIndex = pages.indexOf(showing);
    });
  }

  /** Copies the selection in layer order, nudges it, and selects the copies. */
  duplicate(): void {
    this.edit(draft => {
      draft.pageSelected = false;
      if (draft.selection.length) {
        const taken = elementNamesTaken(draft.project, pageOf(draft));
        const copies = selectedOf(draft).map(element => {
          const copy = duplicateElement(element, taken);
          for (const member of allElements([copy])) {
            taken.add(member.name);
          }
          updateGeometry(copy, copy, {
            left: copy.left + CASCADE,
            top: copy.top + CASCADE,
          });
          return copy;
        });
        scopeElements(draft).push(...copies);
        draft.selection = copies.map(e => e.name);
      } else {
        draft.scope = [];
        const copy = duplicatePage(
          pageOf(draft),
          pageNamesTaken(draft.project),
        );
        draft.project.pages.splice(++draft.pageIndex, 0, copy);
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
    this.edit(draft => {
      draft.pageSelected = false;
      if (draft.selection.length) {
        const elements = scopeElements(draft);
        const remaining = elements.filter(
          e => !draft.selection.includes(e.name),
        );
        elements.splice(0, elements.length, ...remaining);
        draft.selection = [];
      } else {
        draft.scope = [];
        draft.project.pages.splice(draft.pageIndex, 1);
        draft.pageIndex = Math.min(
          draft.pageIndex,
          draft.project.pages.length - 1,
        );
      }
    });
  }

  /** Keeps selected Elements' relative order, including adjacent groups. */
  orderLayers(order: LayerOrder): void {
    this.edit(draft => {
      const elements = scopeElements(draft);
      const selection = new Set(draft.selection);
      const selected = (element: Immutable<Element>) =>
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
    });
  }
}

class EditorTextHistory implements TextHistory {
  #last: Immutable<TextElement>;
  constructor(
    readonly editor: StackEditor,
    element: Immutable<TextElement>,
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
  get element(): Immutable<TextElement> {
    const found = allElements(this.editor.page.elements).find(
      e => e.id === this.#last.id,
    );
    if (found?.kind === 'text') {
      this.#last = found;
    }
    return this.#last;
  }
  set(text: Immutable<RichText>): void {
    const target = this.element;
    const next = renormalizeRichText(text);
    if (
      JSON.stringify(next) !==
      JSON.stringify(renormalizeRichText(target.richText))
    ) {
      this.editor.edit(draft => {
        const element = elementOf(draft, target.name);
        if (element?.kind === 'text') {
          element.richText = next;
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

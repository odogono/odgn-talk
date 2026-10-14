// The Stack editor's state and edits (#749): which Page is showing, which
// Elements are selected, and the moves, resizes, renames and Page edits the
// shell makes. Pure TS over the Project model, so it is tested without a DOM.
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
const elementNamesNear = (page: Page, current?: string, project?: Project) =>
  project
    ? elementNamesTaken(project, page, current)
    : new Set([...reservedScriptNames, ...namesExcept(page.elements, current)]);

/**
 * Checks `name` for an Element on `page`: an identifier, unique within the
 * Page. `current` is the Element's own name, which it may keep.
 */
export const checkElementName = (
  page: Page,
  name: string,
  current?: string,
  project?: Project,
): NameCheck =>
  checkName(
    name,
    elementNamesNear(page, current, project),
    'Element on this Page',
    current,
  );

/** Checks `name` for a Page: an identifier, unique within the Project. */
export const checkPageName = (
  project: Project,
  name: string,
  current?: string,
): NameCheck =>
  checkName(name, pageNamesTaken(project, current), 'Page or Element', current);

/**
 * The name suggested from a button's label, or `undefined` when the button
 * already has it.
 */
export const labelSuggestion = (
  page: Page,
  button: ButtonElement,
  project?: Project,
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

type Box = Pick<Element, 'height' | 'left' | 'top' | 'width'>;

/** The smallest size a resize leaves; a line may be flat in either direction. */
const minimumSize = (element: Element) => (element.kind === 'line' ? 0 : 8);

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
export type Edit = { change(update: () => void): void; finish(): void };

type Snapshot = {
  identities: { elements: number[]; page: number }[];
  pageIndex: number;
  pageSelected: boolean;
  project: Project;
  selection: string[];
};
type HistoryEntry = { after: Snapshot; before: Snapshot };
export type LayerOrder = 'forward' | 'backward' | 'front' | 'back';

/** Where a new Element goes: down and right of the last one added. */
const CASCADE = 20;

/**
 * The editor's state over one authored Project. Edits change the Project in
 * place; the shell renders after each one.
 */
export class StackEditor {
  #nextIdentity = 0;
  #identities = new WeakMap<object, number>();
  /** Session-local identities survive history, but never enter Project files. */
  identity(owner: object): number {
    let id = this.#identities.get(owner);
    if (id === undefined) {
      id = ++this.#nextIdentity;
      this.#identities.set(owner, id);
    }
    return id;
  }

  #pageIndex = 0;
  #selection: string[] = [];
  // Set only by an explicit Page selection, so Delete never removes a Page
  // just because no Elements are selected.
  #pageSelected = false;
  #past: HistoryEntry[] = [];
  #future: HistoryEntry[] = [];
  // An object, not a bare Snapshot, so stale Edit handles can be detected by
  // identity. `json` caches the serialised Project for change checks.
  #pending: { before: Snapshot; json: string } | undefined;

  /**
   * Told after every authored change to the Project: a finished undoable
   * edit, a live change inside one, and undo and redo. Autosave listens
   * here (#752). Loading a different Project is not a change.
   */
  onChange: (() => void) | undefined;

  /**
   * While set, the Project cannot change: undo and redo do nothing, and
   * any edit is rolled back when it finishes. Selection and the showing
   * Page still change, so a read-only tab can look around.
   */
  readOnly = false;
  /** Incremented when switching Projects or loading a stored version. */
  generation = 0;

  constructor(readonly project: Project) {}

  #snapshot(): Snapshot {
    return structuredClone({
      identities: this.project.pages.map(page => ({
        page: this.identity(page),
        elements: page.elements.map(element => this.identity(element)),
      })),
      project: this.project,
      pageIndex: this.#pageIndex,
      selection: this.#selection,
      pageSelected: this.#pageSelected,
    });
  }

  #restore(snapshot: Snapshot): void {
    const copy = structuredClone(snapshot);
    this.#assignProject(copy.project);
    copy.project.pages.forEach((page, index) => {
      const ids = copy.identities[index]!;
      this.#identities.set(page, ids.page);
      page.elements.forEach((element, i) =>
        this.#identities.set(element, ids.elements[i]!),
      );
    });
    this.#pageIndex = copy.pageIndex;
    this.#selection = copy.selection;
    this.#pageSelected = copy.pageSelected;
  }

  /** Replaces the Project's contents, preserving its object reference. */
  #assignProject(project: Project): void {
    // Preserve the Project reference held by the shell and storage clients.
    for (const key of Object.keys(this.project)) {
      if (!(key in project)) {
        delete (this.project as Partial<Project>)[key as keyof Project];
      }
    }
    Object.assign(this.project, project);
  }

  /**
   * Loads a different Project into this editor: opening one from the
   * Project list, previewing or restoring an earlier version, or following
   * another tab's save. History starts over; this is not an authored edit,
   * so `onChange` is not told.
   */
  replaceProject(project: Project): void {
    this.generation++;
    this.#pending = undefined;
    this.#assignProject(structuredClone(project));
    this.#past = [];
    this.#future = [];
    this.#pageIndex = 0;
    this.#selection = [];
    this.#pageSelected = false;
  }

  /** Finishes any live edit, recording it as one undo step. */
  finishPendingEdit(): void {
    this.#finish();
  }

  get #pendingChanged(): boolean {
    return (
      !!this.#pending && this.#pending.json !== JSON.stringify(this.project)
    );
  }

  #finish(): void {
    const pending = this.#pending;
    const changed = this.#pendingChanged;
    this.#pending = undefined;
    if (pending && changed && this.readOnly) {
      this.#restore(pending.before);
    } else if (pending && changed) {
      this.#past.push({ before: pending.before, after: this.#snapshot() });
      this.#future = [];
      this.onChange?.();
    }
  }

  get canUndo(): boolean {
    return !this.readOnly && (this.#past.length > 0 || this.#pendingChanged);
  }

  get canRedo(): boolean {
    return !this.readOnly && this.#future.length > 0 && !this.#pendingChanged;
  }

  /** Records any authored Project change, including Info and future Script edits. */
  edit<T>(change: () => T): T {
    const edit = this.startEdit();
    let result!: T;
    edit.change(() => {
      result = change();
    });
    edit.finish();
    return result;
  }

  /** Starts a live edit. Starting another edit also finishes this one. */
  startEdit(): Edit {
    this.#finish();
    const before = this.#snapshot();
    const pending = { before, json: JSON.stringify(before.project) };
    this.#pending = pending;
    let changed = false;
    return {
      change: update => {
        if (this.#pending === pending) {
          update();
          // A live notice once the Project really changed, so autosave
          // can cap how long a continuous drag goes unsaved.
          changed ||= pending.json !== JSON.stringify(this.project);
          if (changed && !this.readOnly) {
            this.onChange?.();
          }
        }
      },
      finish: () => {
        if (this.#pending === pending) {
          this.#finish();
        }
      },
    };
  }

  undo(): void {
    this.#finish();
    const entry = this.readOnly ? undefined : this.#past.pop();
    if (entry) {
      this.#restore(entry.before);
      this.#future.push(entry);
      this.onChange?.();
    }
  }

  redo(): void {
    this.#finish();
    const entry = this.readOnly ? undefined : this.#future.pop();
    if (entry) {
      this.#restore(entry.after);
      this.#past.push(entry);
      this.onChange?.();
    }
  }

  get pageIndex(): number {
    return this.#pageIndex;
  }

  /** The Page showing on the desk. */
  get page(): Page {
    return this.project.pages[this.#pageIndex]!;
  }

  /** The selected Elements' names, in the order they were selected. Empty means the Page is selected. */
  get selection(): readonly string[] {
    return this.#selection;
  }

  /** The selected Elements, in layer order. */
  get selected(): Element[] {
    return this.page.elements.filter(e => this.#selection.includes(e.name));
  }

  element(name: string): Element | undefined {
    return this.page.elements.find(e => e.name === name);
  }

  /** Text edits for a text Element on the showing Page, one undo step each. */
  textHistory(element: TextElement): TextHistory {
    return new EditorTextHistory(this, element);
  }

  /**
   * Selects as a click does. A plain click on an Element selects only it,
   * unless it is already selected, so a group can be dragged. Shift-click
   * adds or removes it. A click on empty space (`undefined`) selects the Page.
   */
  click(name: string | undefined, { shift = false } = {}): void {
    this.#finish();
    if (name === undefined || !this.element(name)) {
      if (!shift) {
        this.#selection = [];
        this.#pageSelected = true;
      }
      return;
    }
    this.#pageSelected = false;
    if (shift) {
      this.#selection = this.#selection.includes(name)
        ? this.#selection.filter(n => n !== name)
        : [...this.#selection, name];
    } else if (!this.#selection.includes(name)) {
      this.#selection = [name];
    }
  }

  selectPage(): void {
    this.#finish();
    this.#selection = [];
    this.#pageSelected = true;
  }

  /** Adds an Element of `kind` named like `button1`, and selects it. */
  addElement(kind: ElementKind): Element {
    return this.edit(() => {
      const page = this.page;
      const element = createElement(
        kind,
        freshName(`${kind}1`, elementNamesTaken(this.project, page)),
      );
      const step = (page.elements.length % 10) * CASCADE;
      element.left += step;
      element.top += step;
      page.elements.push(element);
      this.#selection = [element.name];
      this.#pageSelected = false;
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
    this.edit(() => {
      let asset = this.project.assets.find(a => a.hash === imported.hash);
      if (!asset) {
        asset = {
          ...imported,
          name: freshName(imported.name, namesExcept(this.project.assets)),
        };
        this.project.assets.push(asset);
      }
      if (target?.kind === 'image') {
        target.image = asset.name;
      } else {
        const element = createElement(
          'image',
          freshName('image1', elementNamesTaken(this.project, this.page)),
        );
        if (element.kind !== 'image') {
          return;
        }
        element.image = asset.name;
        if (position) {
          Object.assign(element, position);
        }
        this.page.elements.push(element);
        this.#selection = [element.name];
        this.#pageSelected = false;
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
    return this.edit(() => {
      let asset = this.project.assets.find(a => a.hash === imported.hash);
      if (!asset) {
        asset = {
          ...imported,
          name: freshName(imported.name, namesExcept(this.project.assets)),
        };
        this.project.assets.push(asset);
      }
      return asset.name;
    });
  }

  /** Starts moving the selected Elements; offsets are in design pixels. */
  startMove(): Gesture {
    const origins = this.selected.map(e => ({ e, left: e.left, top: e.top }));
    const edit = this.startEdit();
    return {
      finish: edit.finish,
      to(dx, dy) {
        edit.change(() => {
          for (const { e, left, top } of origins) {
            e.left = Math.round(left + dx);
            e.top = Math.round(top + dy);
          }
        });
      },
    };
  }

  /** Starts resizing the one selected Element by a handle, if exactly one is. */
  startResize(handle: Handle): Gesture | undefined {
    const [element] = this.selected;
    if (!element || this.#selection.length !== 1) {
      return undefined;
    }
    const origin: Box = { ...element };
    const edit = this.startEdit();
    return {
      finish: edit.finish,
      to(dx, dy) {
        edit.change(() => {
          Object.assign(
            element,
            resizeBox(origin, handle, dx, dy, minimumSize(element)),
          );
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
      this.edit(() => {
        element.name = name;
        this.#selection = this.#selection.map(n => (n === current ? name : n));
      });
    }
    return check;
  }

  /** Renames the showing Page, if the name passes the check. */
  renamePage(name: string): NameCheck {
    const check = checkPageName(this.project, name, this.page.name);
    if (check.ok) {
      this.edit(() => {
        this.page.name = name;
      });
    }
    return check;
  }

  /** Shows the Page at `index` and selects it. */
  goToPage(index: number): void {
    this.#finish();
    if (index < 0 || index >= this.project.pages.length) {
      return;
    }
    this.#pageIndex = index;
    this.#selection = [];
    this.#pageSelected = true;
  }

  previousPage(): void {
    this.goToPage(this.#pageIndex - 1);
  }

  nextPage(): void {
    this.goToPage(this.#pageIndex + 1);
  }

  /** Adds a Page after the showing one, and shows it. */
  addPage(): Page {
    return this.edit(() => {
      const page = createPage(
        freshName(
          `page${this.project.pages.length + 1}`,
          pageNamesTaken(this.project),
        ),
      );
      this.project.pages.splice(this.#pageIndex + 1, 0, page);
      this.#pageIndex++;
      this.#selection = [];
      this.#pageSelected = false;
      return page;
    });
  }

  /** Moves the Page at `from` to `to`; the showing Page stays showing. */
  movePage(from: number, to: number): void {
    const pages = this.project.pages;
    if (from < 0 || from >= pages.length || to < 0 || to >= pages.length) {
      return;
    }
    this.edit(() => {
      const showing = this.page;
      const [moved] = pages.splice(from, 1);
      pages.splice(to, 0, moved!);
      this.#pageIndex = pages.indexOf(showing);
    });
  }

  /** Copies the selection in layer order, nudges it, and selects the copies. */
  duplicate(): void {
    this.edit(() => {
      this.#pageSelected = false;
      if (this.#selection.length) {
        const taken = elementNamesTaken(this.project, this.page);
        const copies = this.selected.map(element => {
          const copy = duplicateElement(element, taken);
          taken.add(copy.name);
          copy.left += CASCADE;
          copy.top += CASCADE;
          return copy;
        });
        this.page.elements.push(...copies);
        this.#selection = copies.map(e => e.name);
      } else {
        const copy = duplicatePage(this.page, pageNamesTaken(this.project));
        this.project.pages.splice(++this.#pageIndex, 0, copy);
      }
    });
  }

  /** The editor keeps at least one Page in the authored Project. */
  get canDelete(): boolean {
    return (
      this.#selection.length > 0 ||
      (this.#pageSelected && this.project.pages.length > 1)
    );
  }

  /** Deletes the selected Elements, or the Page only when it is selected. */
  delete(): void {
    if (!this.canDelete) {
      return;
    }
    this.edit(() => {
      this.#pageSelected = false;
      if (this.#selection.length) {
        this.page.elements = this.page.elements.filter(
          e => !this.#selection.includes(e.name),
        );
        this.#selection = [];
      } else {
        this.project.pages.splice(this.#pageIndex, 1);
        this.#pageIndex = Math.min(
          this.#pageIndex,
          this.project.pages.length - 1,
        );
      }
    });
  }

  /** Keeps selected Elements' relative order, including adjacent groups. */
  orderLayers(order: LayerOrder): void {
    this.edit(() => {
      const elements = this.page.elements;
      const selection = new Set(this.#selection);
      const selected = (element: Element) => selection.has(element.name);
      if (order === 'front' || order === 'back') {
        const chosen = elements.filter(selected);
        const others = elements.filter(e => !selected(e));
        this.page.elements =
          order === 'front' ? [...others, ...chosen] : [...chosen, ...others];
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
  #last: TextElement;
  constructor(
    readonly editor: StackEditor,
    element: TextElement,
  ) {
    this.#last = element;
  }
  get canUndo(): boolean {
    return this.editor.canUndo;
  }
  get canRedo(): boolean {
    return this.editor.canRedo;
  }
  get element(): TextElement {
    const found = this.editor.element(this.#last.name);
    if (found?.kind === 'text') {
      this.#last = found;
    }
    return this.#last;
  }
  set(text: RichText): void {
    const target = this.element;
    const next = renormalizeRichText(text);
    if (
      JSON.stringify(next) !==
      JSON.stringify(renormalizeRichText(target.richText))
    ) {
      this.editor.edit(() => {
        target.richText = next;
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

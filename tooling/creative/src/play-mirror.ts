// The page's copy of Play State (#1225): what the Play worker last said the
// showing Page looks like. The page draws from it and answers key handling
// from it without waiting for the worker. Each Element keeps one object per
// name, and only fields whose value changed are replaced, so reader history
// and drawn nodes keyed by Element survive the worker echoing an edit.
// Drawings arrive apart from their Elements as `ReceivedDrawing`s, which
// extend the same array on an addition, so the renderer paints only the new
// commands.
import type { CanvasCommand } from '@northtalk/tooling/canvas';
import type { DeepReadonly } from './readonly';
import { ReceivedDrawing } from './drawing';
import { type StackEditor } from './editing';
import { type Element, type RichText, type TextElement } from './model';
import { ownerById, ownerId, type ScriptOwner } from './script-manifest';
import {
  type PlayView,
  type PromptView,
  type StoppedRun,
} from './play-protocol';
import { type ReaderTextPlay } from './play-text';

export type MirrorPage = PlayView['page'] & { index: number };

export class PlayMirror implements ReaderTextPlay {
  /** Replaced whenever the worker shows another Page. */
  page: MirrorPage = { name: '', height: 0, background: '', index: -1 };
  messageTargets: NonNullable<PlayView['messageTargets']> = [];
  designWidth = 0;
  navigating = false;
  paused = false;
  /** The Run a Breakpoint stopped, while the session is paused there. */
  stoppedRun: StoppedRun | undefined;
  stopped = false;
  wantsFrames = false;
  prompt: PromptView | undefined;
  pageHandles = { keyDown: false, keyUp: false };
  heldElements = new Set<string>();
  #shown = new Set<Element>();
  #order: Element[] = [];

  /** `edited` posts a reader's text edit to the worker. */
  constructor(
    private readonly edited: (
      element: TextElement,
      next: RichText,
      pageIndex: number,
      edit: number,
    ) => void,
  ) {}

  // Each Page's Elements keep their objects, so returning to a Page keeps
  // its reader history.
  #pages = new Map<number, Map<string, Element>>();
  // Each Element's latest reader edit, numbered across the session.
  #edits = new WeakMap<Element, number>();
  #edit = 0;
  // Every Drawing the worker has sent, by Page and name, and each authored
  // Canvas's by its place in `scriptOwners(project)`.
  #drawings = new Map<string, ReceivedDrawing>();
  #authoredDrawings = new Map<number, CanvasCommand[]>();
  get authoredDrawings(): ReadonlyMap<number, readonly CanvasCommand[]> {
    return this.#authoredDrawings;
  }
  get #byName(): Map<string, Element> {
    let names = this.#pages.get(this.page.index);
    if (!names) {
      names = new Map();
      this.#pages.set(this.page.index, names);
    }
    return names;
  }

  apply(view: PlayView): void {
    if (view.pageIndex !== this.page.index) {
      this.#shown.clear();
      this.page = { ...view.page, index: view.pageIndex };
    } else if (
      view.page.height !== this.page.height ||
      view.page.background !== this.page.background
    ) {
      Object.assign(this.page, view.page);
    }
    if (view.messageTargets) {
      this.messageTargets = view.messageTargets;
    }
    this.designWidth = view.designWidth;
    this.navigating = view.navigating;
    this.paused = view.paused;
    this.stoppedRun = view.stoppedRun;
    this.stopped = view.stopped;
    this.wantsFrames = view.wantsFrames;
    this.prompt = view.prompt;
    this.pageHandles = view.pageHandles;
    this.heldElements = new Set(view.heldElements);
    for (const { element, shown, edit = 0 } of view.elements) {
      let mirrored = this.#byName.get(element.name);
      if (!mirrored || mirrored.kind !== element.kind) {
        mirrored = element;
        if (mirrored.kind === 'canvas') {
          mirrored.drawing =
            this.#drawings.get(`${view.pageIndex}/${mirrored.name}`)
              ?.commands ?? [];
        }
        this.#byName.set(element.name, mirrored);
      } else {
        const target = mirrored as Record<string, unknown>;
        // Text from before the reader's latest edit would undo it here.
        const stale = (this.#edits.get(mirrored) ?? 0) > edit;
        for (const key of Object.keys(target)) {
          if (key !== 'drawing' && !(key in element)) {
            delete target[key];
          }
        }
        for (const [key, value] of Object.entries(element)) {
          if ((stale && key === 'richText') || key === 'drawing') {
            continue;
          }
          if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
            target[key] = value;
          }
        }
      }
      if (shown) {
        this.#shown.add(mirrored);
      } else {
        this.#shown.delete(mirrored);
      }
    }
    for (const drawing of view.drawings) {
      const key = `${drawing.pageIndex}/${drawing.name}`;
      let received = this.#drawings.get(key);
      if (!received) {
        received = new ReceivedDrawing();
        this.#drawings.set(key, received);
      }
      received.apply(drawing);
      const commands = received.commands;
      if (drawing.owner !== undefined) {
        this.#authoredDrawings.set(drawing.owner, commands);
      }
      const mirrored =
        drawing.pageIndex === this.page.index
          ? this.#byName.get(drawing.name)
          : undefined;
      if (mirrored?.kind === 'canvas') {
        mirrored.drawing = commands;
      }
    }
    if (view.order) {
      const order = view.order.map(name => this.#byName.get(name)!);
      const kept = new Set(order);
      for (const [name, element] of this.#byName) {
        if (!kept.has(element)) {
          this.#byName.delete(name);
          this.#shown.delete(element);
        }
      }
      this.#order = order;
    }
  }

  elementsOf(): readonly Element[] {
    return this.#order;
  }

  isVisible(element: DeepReadonly<Element>): boolean {
    return this.#shown.has(element as Element);
  }

  /** Applies the edit here at once; the worker's next view confirms it. */
  editText(element: TextElement, next: RichText): void {
    element.richText = next;
    this.#edits.set(element, ++this.#edit);
    this.edited(element, next, this.page.index, this.#edit);
  }
}

/**
 * On return to Edit, writes each authored Canvas's Drawing as the page last
 * showed it into the Project, as one undoable edit (ADR 0116). `owners` is
 * `scriptOwners` of the Project Play started from.
 */
export const commitDrawings = (
  editor: StackEditor,
  owners: readonly ScriptOwner[],
  mirror: PlayMirror,
): void => {
  if (!mirror.authoredDrawings.size || editor.readOnly) {
    return;
  }
  editor.edit(({ tree }) => {
    for (const [index, commands] of mirror.authoredDrawings) {
      const authored = owners[index];
      const owner = authored && ownerById(editor.project, ownerId(authored));
      if (owner && 'kind' in owner && owner.kind === 'canvas') {
        tree.setDrawing(owner, commands);
      }
    }
  });
};

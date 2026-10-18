import type { Immutable } from 'immer';
// Reader history belongs to a Play Session, never the authored editor.
import { type Element, type RichText, type TextElement } from './model';
import { renormalizeRichText, type TextHistory } from './rich-text';

/** What reader history needs of Play: the Play Session, or the page's mirror of it. */
export type ReaderTextPlay = {
  editText(element: Immutable<TextElement>, next: Immutable<RichText>): void;
  elementsOf(): readonly Immutable<Element>[];
  isVisible(element: Immutable<TextElement>): boolean;
  readonly navigating: boolean;
  readonly stopped: boolean;
};

export class ReaderTextHistory implements TextHistory {
  #undo: Immutable<RichText>[] = [];
  #redo: Immutable<RichText>[] = [];
  #current: Immutable<RichText>;
  constructor(
    readonly play: ReaderTextPlay,
    readonly element: Immutable<TextElement>,
  ) {
    this.#current = element.richText;
  }
  #sync(): void {
    // A Script replacement clears mixed formatting and starts new history.
    if (this.#current !== this.element.richText) {
      this.#undo = [];
      this.#redo = [];
      this.#current = this.element.richText;
    }
  }
  get canUndo(): boolean {
    this.#sync();
    return this.#undo.length > 0;
  }
  get canRedo(): boolean {
    this.#sync();
    return this.#redo.length > 0;
  }
  #change(next: Immutable<RichText>): boolean {
    if (
      this.play.stopped ||
      this.play.navigating ||
      !this.element.editable ||
      !this.play.isVisible(this.element) ||
      !this.play.elementsOf().includes(this.element) ||
      JSON.stringify(next) === JSON.stringify(this.element.richText)
    ) {
      return false;
    }
    this.play.editText(this.element, next);
    this.#current = this.element.richText;
    return true;
  }
  set(text: RichText): void {
    this.#sync();
    const previous = this.#current;
    if (this.#change(renormalizeRichText(text))) {
      this.#undo.push(previous);
      this.#redo = [];
    }
  }
  undo(): void {
    this.#sync();
    const previous = this.#current;
    const next = this.#undo.at(-1);
    if (next && this.#change(next)) {
      this.#undo.pop();
      this.#redo.push(previous);
    }
  }
  redo(): void {
    this.#sync();
    const previous = this.#current;
    const next = this.#redo.at(-1);
    if (next && this.#change(next)) {
      this.#redo.pop();
      this.#undo.push(previous);
    }
  }
}

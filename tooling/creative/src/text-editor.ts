// In-place text editing: browser typing/IME, structured formatting and paste,
// and explicit history shared across reopening the same Element.
import { plainTextOf, richTextFromPlainText, type RichText } from './model';
import {
  rangeHasStyle,
  replaceTextRange,
  styleTextRange,
  TEXT_MARKS,
  TextHistory,
  type TextMark,
  type TextSelection,
  type TextStyle,
} from './rich-text';
import {
  readRichText,
  renderRichText,
  richTextFromHtml,
  selectionInText,
  selectTextRange,
} from './rich-text-dom';

export class InPlaceTextEditor {
  #selection: TextSelection = { start: 0, end: 0 };
  #composing = false;
  #events = new AbortController();
  constructor(
    readonly node: HTMLElement,
    readonly toolbar: HTMLElement,
    readonly history: TextHistory,
    readonly changed: () => void,
    readonly finished: () => void,
    readonly options: { escape?: () => void; selectAll?: boolean } = {},
  ) {
    node.contentEditable = 'true';
    node.classList.add('text-editing');
    node.setAttribute('role', 'textbox');
    node.setAttribute('aria-label', `Edit ${history.element.name}`);
    node.setAttribute('aria-multiline', 'true');
    toolbar.hidden = false;
    this.#listen(document, 'selectionchange', () => {
      const selection = selectionInText(node);
      if (selection) {
        this.#selection = selection;
        this.#updateToolbar();
      }
    });
    this.#listen(node, 'compositionstart', () => {
      this.#composing = true;
    });
    this.#listen(node, 'compositionend', () => {
      this.#composing = false;
      this.#read();
    });
    this.#listen(node, 'input', () => {
      if (!this.#composing) {
        this.#read();
      }
    });
    this.#listen(node, 'beforeinput', event => {
      const input = event as InputEvent;
      if (
        input.inputType === 'historyUndo' ||
        input.inputType === 'historyRedo'
      ) {
        event.preventDefault();
        this.#command(input.inputType === 'historyUndo' ? 'undo' : 'redo');
      } else if (
        ['insertParagraph', 'insertLineBreak'].includes(input.inputType)
      ) {
        event.preventDefault();
        this.#insert(richTextFromPlainText('\n'));
      } else if (input.inputType.startsWith('format')) {
        event.preventDefault();
      }
    });
    this.#listen(node, 'paste', event => {
      event.preventDefault();
      const data = (event as ClipboardEvent).clipboardData;
      if (!data) {
        return;
      }
      const html = data.getData('text/html');
      this.#insert(
        html
          ? richTextFromHtml(html)
          : richTextFromPlainText(data.getData('text/plain')),
      );
    });
    // Dragging external HTML must not bypass the clipboard boundary.
    this.#listen(node, 'drop', event => event.preventDefault());
    this.#listen(node, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (key.isComposing) {
        return;
      }
      if (key.key === 'Escape') {
        key.preventDefault();
        key.stopPropagation();
        (options.escape ?? finished)();
        return;
      }
      if (key.ctrlKey || key.metaKey) {
        const command = {
          b: 'bold',
          i: 'italic',
          u: 'underline',
          z: key.shiftKey ? 'redo' : 'undo',
          y: 'redo',
        }[key.key.toLowerCase()];
        if (command) {
          key.preventDefault();
          this.#command(command);
        }
      }
    });
    this.#listen(toolbar, 'pointerdown', event => {
      this.#selection = selectionInText(node) ?? this.#selection;
      if ((event.target as HTMLElement).closest('button')) {
        event.preventDefault();
      }
    });
    this.#listen(toolbar, 'click', event => {
      const command = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-text-command]',
      )?.dataset.textCommand;
      if (command === 'done') {
        finished();
      } else if (command) {
        this.#command(command);
      }
    });
    this.#listen(toolbar, 'input', event => {
      const input = event.target as HTMLInputElement;
      if (input.type === 'color') {
        this.#format({ color: input.value });
      }
    });
    node.focus();
    this.#selection =
      options.selectAll === false
        ? (selectionInText(node) ?? { start: 0, end: 0 })
        : { start: 0, end: plainTextOf(history.element.richText).length };
    selectTextRange(node, this.#selection);
    this.#updateToolbar();
  }
  #listen(
    target: EventTarget,
    name: string,
    listener: (event: Event) => void,
  ): void {
    target.addEventListener(name, listener, { signal: this.#events.signal });
  }
  #updateToolbar(): void {
    for (const mark of TEXT_MARKS) {
      this.toolbar
        .querySelector(`[data-text-command="${mark}"]`)
        ?.setAttribute(
          'aria-pressed',
          String(
            rangeHasStyle(this.history.element.richText, this.#selection, mark),
          ),
        );
    }
    const undo = this.toolbar.querySelector<HTMLButtonElement>(
      '[data-text-command="undo"]',
    )!;
    const redo = this.toolbar.querySelector<HTMLButtonElement>(
      '[data-text-command="redo"]',
    )!;
    undo.disabled = !this.history.canUndo;
    redo.disabled = !this.history.canRedo;
  }
  #render(): void {
    renderRichText(this.node, this.history.element.richText);
    this.node.focus();
    selectTextRange(this.node, this.#selection);
    this.#updateToolbar();
    this.changed();
  }
  #read(): void {
    this.#selection = selectionInText(this.node) ?? this.#selection;
    this.history.set(readRichText(this.node));
    this.#render();
  }
  #insert(text: RichText): void {
    this.#selection = selectionInText(this.node) ?? this.#selection;
    this.history.set(
      replaceTextRange(this.history.element.richText, this.#selection, text),
    );
    const caret = this.#selection.start + plainTextOf(text).length;
    this.#selection = { start: caret, end: caret };
    this.#render();
  }
  #format(style: TextStyle): void {
    // Formatting applies to a selection; no invisible typing-style state.
    if (this.#selection.start === this.#selection.end) {
      return;
    }
    this.history.set(
      styleTextRange(this.history.element.richText, this.#selection, style),
    );
    this.#render();
  }
  #command(command: string): void {
    this.#selection = selectionInText(this.node) ?? this.#selection;
    if (command === 'paragraph') {
      this.#insert(richTextFromPlainText('\n'));
    } else if (command === 'undo' || command === 'redo') {
      this.history[command]();
      this.#render();
    } else if (command === 'clear') {
      this.#format({
        bold: false,
        italic: false,
        underline: false,
        color: undefined,
      });
    } else if (
      command === 'bold' ||
      command === 'italic' ||
      command === 'underline'
    ) {
      this.#format({
        [command]: !rangeHasStyle(
          this.history.element.richText,
          this.#selection,
          command,
        ),
      });
    }
  }
  /** Refresh Script changes without interrupting an in-progress composition. */
  refresh(): void {
    if (!this.#composing) {
      this.#selection = selectionInText(this.node) ?? this.#selection;
      this.#render();
    }
  }
  destroy(): void {
    if (this.#composing) {
      this.history.set(readRichText(this.node));
    }
    this.#events.abort();
    this.node.removeAttribute('contenteditable');
    this.node.classList.remove('text-editing');
    this.toolbar.hidden = true;
  }
}

/**
 * The formatting controls for a selected text Element that isn't being
 * edited: marks and colour apply to all of its text, as a design tool's
 * inspector applies them to a whole text layer.
 */
export class ElementTextControls {
  #events = new AbortController();
  constructor(
    readonly toolbar: HTMLElement,
    readonly history: TextHistory,
    readonly changed: () => void,
  ) {
    toolbar.hidden = false;
    toolbar.dataset.scope = 'element';
    const listen = (name: string, listener: (event: Event) => void) =>
      toolbar.addEventListener(name, listener, { signal: this.#events.signal });
    listen('click', event => {
      const command = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-text-command]',
      )?.dataset.textCommand;
      const all = this.#all();
      const text = history.element.richText;
      if (command === 'undo' || command === 'redo') {
        history[command]();
      } else if (command === 'clear') {
        history.set(
          styleTextRange(text, all, {
            bold: false,
            italic: false,
            underline: false,
            color: undefined,
          }),
        );
      } else if (TEXT_MARKS.includes(command as TextMark)) {
        const mark = command as TextMark;
        history.set(
          styleTextRange(text, all, {
            [mark]: !rangeHasStyle(text, all, mark),
          }),
        );
      } else {
        return;
      }
      this.changed();
    });
    listen('input', event => {
      const input = event.target as HTMLInputElement;
      if (input.type === 'color') {
        history.set(
          styleTextRange(history.element.richText, this.#all(), {
            color: input.value,
          }),
        );
        this.changed();
      }
    });
    this.update();
  }
  #all(): TextSelection {
    return { start: 0, end: plainTextOf(this.history.element.richText).length };
  }
  update(): void {
    for (const mark of TEXT_MARKS) {
      this.toolbar
        .querySelector(`[data-text-command="${mark}"]`)
        ?.setAttribute(
          'aria-pressed',
          String(
            rangeHasStyle(this.history.element.richText, this.#all(), mark),
          ),
        );
    }
    const undo = this.toolbar.querySelector<HTMLButtonElement>(
      '[data-text-command="undo"]',
    )!;
    const redo = this.toolbar.querySelector<HTMLButtonElement>(
      '[data-text-command="redo"]',
    )!;
    undo.disabled = !this.history.canUndo;
    redo.disabled = !this.history.canRedo;
  }
  destroy(): void {
    this.#events.abort();
    delete this.toolbar.dataset.scope;
    this.toolbar.hidden = true;
  }
}

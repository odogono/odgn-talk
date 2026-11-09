// Literal Editor windows (ADR 0175, #2180): one floating window per pinned
// literal, which follows its literal as the source changes, greys out while
// it can't show it and closes once the literal is gone. Windows last only
// for the visit.
import { VIEW_API } from './add-ons/page';
import type { LiteralEditorView } from './add-ons/api';
import type { CodeSelection } from './code-browser-panel';
import { h } from './dom';
import { parseMiniNotation } from './mini-notation';
import {
  followLiteral,
  literalAt,
  replaceInLiteral,
  type LiteralPin,
  type LiteralState,
  type RegisteredLiteralEditor,
} from './literal-editors';
import { bringWindowForward, floatingWindow } from './windows';

type Open = {
  body: HTMLElement;
  editor: RegisteredLiteralEditor;
  node: HTMLElement;
  notice: HTMLElement;
  pin: LiteralPin;
  source: CodeSelection;
  state: LiteralState;
  /** The source text the pin was last followed in. */
  text: string;
  view: LiteralEditorView;
};

const same = (a: CodeSelection, b: CodeSelection) =>
  a.kind === b.kind && a.id === b.id;

const NOTICES: Record<Exclude<LiteralState['kind'], 'ready'>, string> = {
  invalid: '',
  removed: 'The literal was removed.',
  unreadable: 'The Script has a syntax error.',
};

let nextId = 1;

export class LiteralEditorWindows {
  #open: Open[] = [];

  constructor(
    private readonly options: {
      /** Plays `name` on the Instrument `on` names, or the default (#2190). */
      audition(name: string, on: string | undefined): void;
      /** The text of `source` now, if it still exists. */
      read(source: CodeSelection): string | undefined;
      /** Selects `from`–`to` of `source` in the Code Browser, if it shows it. */
      select(source: CodeSelection, from: number, to: number): void;
      /** Writes `text` as `source`, as an author's edit. */
      write(source: CodeSelection, text: string): void;
    },
  ) {}

  /** The open windows' sources and pins, for tests. */
  get pins(): { at: number; source: CodeSelection }[] {
    return this.#open.map(o => ({ at: o.pin.at, source: o.source }));
  }

  /**
   * Opens `editor` on the literal starting at `at` in `source`, or brings
   * forward the window already showing it.
   */
  open(
    editor: RegisteredLiteralEditor,
    source: CodeSelection,
    at: number,
    title: string,
  ): void {
    const known = this.#open.find(
      o =>
        o.editor.id === editor.id && same(o.source, source) && o.pin.at === at,
    );
    if (known) {
      known.node.hidden = false;
      bringWindowForward(known.node);
      return;
    }
    const text = this.options.read(source);
    if (text === undefined) {
      return;
    }
    const { close, node } = floatingWindow({
      id: `literal-editor-${nextId++}`,
      className: 'literal-editor-window',
      closeLabel: `Close ${editor.label}`,
      label: `${editor.label} — ${title}`,
      left: 180 + this.#open.length * 24,
      top: 120 + this.#open.length * 24,
    });
    const notice = h('p', { class: 'literal-editor-notice' });
    const body = h('div', { class: 'literal-editor-body' });
    node.append(notice, body);
    const open: Open = {
      body,
      editor,
      node,
      notice,
      pin: { at },
      source,
      state: { kind: 'removed' },
      text,
      view: undefined as unknown as LiteralEditorView,
    };
    open.view = editor.open({
      element: body,
      view: VIEW_API,
      replace: (from, to, insert) => this.#replace(open, from, to, insert),
      audition: name =>
        this.options.audition(name, literalAt(open.text, open.pin.at)?.on),
      parse: text => {
        const parsed = parseMiniNotation(text);
        return parsed.ok ? parsed.pattern : undefined;
      },
      select: (from, to) => {
        const found = literalAt(open.text, open.pin.at);
        if (found && from >= 0 && from <= to && to <= found.text.length) {
          const range = found.range(from, to);
          this.options.select(open.source, range.from, range.to);
        }
      },
    });
    close.addEventListener('click', event => {
      event.stopPropagation();
      this.#close(open);
    });
    this.#open.push(open);
    document.body.append(node);
    // stack.ts makes it draggable.
    node.dispatchEvent(new Event('script-window-opened', { bubbles: true }));
    bringWindowForward(node);
    this.#follow(open, text);
  }

  /** Follows every window's literal into its source as it is now. */
  refresh(): void {
    for (const open of this.#open) {
      const text = this.options.read(open.source);
      if (text === undefined) {
        this.#close(open);
      } else if (text !== open.text) {
        this.#follow(open, text);
      }
    }
  }

  /** Tells the windows on `source` showing `text` that `from`–`to` sounds. */
  heard(
    source: CodeSelection,
    text: string,
    event: { cycle?: number; from: number; to: number },
    ms: number,
  ): void {
    for (const open of this.#open) {
      if (
        same(open.source, source) &&
        open.state.kind === 'ready' &&
        open.state.text === text
      ) {
        open.view.heard?.({
          cycle: event.cycle,
          from: event.from,
          to: event.to,
          ms,
        });
      }
    }
  }

  /** Tells the windows on `source` whose literal holds `pos` where it is. */
  caret(source: CodeSelection, pos: number): void {
    for (const open of this.#open) {
      if (!same(open.source, source) || open.state.kind !== 'ready') {
        continue;
      }
      const found = literalAt(open.text, open.pin.at);
      const length = found?.text.length ?? 0;
      for (let i = 0; found && i < length; i++) {
        const range = found.range(i, i + 1);
        if (pos >= range.from && pos < range.to) {
          open.view.caret?.(i);
          break;
        }
      }
    }
  }

  /** Closes every window, as opening another Project does. */
  clear(): void {
    for (const open of this.#open) {
      this.#close(open);
    }
  }

  #follow(open: Open, text: string): void {
    const { pin, state } = followLiteral(open.pin, open.text, text);
    open.text = text;
    open.pin = pin;
    if (state.kind === 'removed') {
      this.#close(open);
      return;
    }
    open.state = state;
    open.node.classList.toggle('unavailable', state.kind !== 'ready');
    open.notice.textContent =
      state.kind === 'invalid'
        ? `Mini-Notation error: ${state.error.message}`
        : state.kind === 'ready'
          ? ''
          : NOTICES[state.kind];
    if (state.kind === 'ready' || state.kind === 'invalid') {
      open.view.show(state);
    }
  }

  #replace(
    open: Open,
    from: number,
    to: number,
    insert: string,
  ): string | undefined {
    if (open.state.kind !== 'ready') {
      return 'the literal cannot be edited now';
    }
    const result = replaceInLiteral(open.text, open.pin, from, to, insert);
    if ('problem' in result) {
      return result.problem;
    }
    this.options.write(open.source, result.source);
    this.refresh();
    return undefined;
  }

  #close(open: Open): void {
    open.view.close?.();
    open.node.remove();
    this.#open = this.#open.filter(o => o !== open);
  }
}

// A NorthTalk editor for the browser: CodeMirror 6 with NorthTalk
// highlighting, suspension marks, and the language server's diagnostics,
// completion, hover and navigation. A page adds its own gutters, marks and
// keys around these extensions.
import type { LspDiagnostic, Position } from '@northtalk/tooling/lsp';
import {
  autocompletion,
  type CompletionContext,
  snippet,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  hoverTooltip,
  keymap,
  WidgetType,
  type DecorationSet,
  type KeyBinding,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { LspClient } from './lsp-client';
import { northtalk } from './language';

// ------------------------------------------------------------- language

// Colours come from the page's CSS variables, so each page sets its theme.
const style = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--keyword)', fontWeight: '600' },
  { tag: tags.labelName, color: 'var(--keyword)', fontStyle: 'italic' },
  { tag: tags.string, color: 'var(--string)' },
  { tag: tags.number, color: 'var(--number)' },
  { tag: tags.comment, color: 'var(--comment)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--operator)' },
]);

// ------------------------------------------------------------- positions

export const offsetOf = (doc: Text, p: Position): number => {
  const line = doc.line(Math.min(doc.lines, p.line + 1));
  return Math.min(line.to, line.from + p.character);
};
export const positionOf = (doc: Text, offset: number): Position => {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
};

// ------------------------------------------------------------- suspension marks

class HintWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly tip: string,
  ) {
    super();
  }
  override eq(other: HintWidget) {
    return other.label === this.label && other.tip === this.tip;
  }
  override toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-hint';
    span.textContent = this.label;
    span.title = this.tip;
    return span;
  }
}
const setHints =
  StateEffect.define<{ label: string; offset: number; tip: string }[]>();
const hints = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHints)) {
        value = Decoration.set(
          e.value
            .filter(h => h.offset <= tr.state.doc.length)
            .map(h =>
              Decoration.widget({
                widget: new HintWidget(h.label, h.tip),
                side: -1,
              }).range(h.offset),
            ),
          true,
        );
      }
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

// ------------------------------------------------------------- the editor

export type LanguageHooks = {
  changed(text: string): void;
  /** Go to a location in another document, by URI. */
  goTo(uri: string, line: number, character: number): void;
  references(lines: string[]): void;
  selected?(): void;
};

/**
 * The editor's NorthTalk extensions for the document at `uri`. A page puts
 * its own gutters and marks before them, and its own keys in `bindings`,
 * which come after the language server's F12, Shift-F12 and F2.
 */
export const northtalkEditor = (
  uri: string,
  lsp: LspClient,
  hooks: LanguageHooks,
  bindings: readonly KeyBinding[] = [],
): Extension[] => {
  const completion = async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const word = context.matchBefore(/[\p{L}\p{N}_]*/u);
    if (!word || (word.from === word.to && !context.explicit)) {
      return null;
    }
    type Item = {
      detail?: string;
      documentation?: string;
      insertText?: string;
      insertTextFormat?: number;
      kind?: number;
      label: string;
    };
    const result = await lsp.request<{ items?: Item[] } | Item[] | null>(
      'textDocument/completion',
      {
        textDocument: { uri },
        position: positionOf(context.state.doc, context.pos),
      },
    );
    const items = Array.isArray(result) ? result : (result?.items ?? []);
    return {
      from: word.from,
      options: items.map(i => ({
        label: i.label,
        ...(i.detail ? { detail: i.detail } : {}),
        ...(typeof i.documentation === 'string'
          ? { info: i.documentation }
          : {}),
        // The LSP's only snippet field is `${1}`, CodeMirror's `${}`.
        ...(i.insertText === undefined
          ? {}
          : {
              apply:
                i.insertTextFormat === 2
                  ? snippet(i.insertText.replaceAll(/\$\{\d+\}/gu, '${}'))
                  : i.insertText,
            }),
        type:
          i.kind === 3 ? 'function' : i.kind === 14 ? 'keyword' : 'variable',
      })),
    };
  };
  const hover = hoverTooltip(async (view, pos) => {
    const result = await lsp.request<{
      contents: { value: string } | string;
    } | null>('textDocument/hover', {
      textDocument: { uri },
      position: positionOf(view.state.doc, pos),
    });
    if (!result) {
      return null;
    }
    const value =
      typeof result.contents === 'string'
        ? result.contents
        : result.contents.value;
    return {
      pos,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-hover';
        dom.textContent = value;
        return { dom };
      },
    };
  });
  const definition = (view: EditorView) => {
    void lsp
      .request<{ range: { start: Position }; uri: string } | null>(
        'textDocument/definition',
        {
          textDocument: { uri },
          position: positionOf(view.state.doc, view.state.selection.main.head),
        },
      )
      .then(location => {
        if (location) {
          hooks.goTo(
            location.uri,
            location.range.start.line,
            location.range.start.character,
          );
        }
      });
    return true;
  };
  const references = (view: EditorView) => {
    void lsp
      .request<{ range: { start: Position }; uri: string }[] | null>(
        'textDocument/references',
        {
          textDocument: { uri },
          position: positionOf(view.state.doc, view.state.selection.main.head),
          context: { includeDeclaration: true },
        },
      )
      .then(locations =>
        hooks.references(
          (locations ?? []).map(
            l =>
              `${decodeURIComponent(l.uri.replace(/^.*\//u, ''))}:${l.range.start.line + 1}:${l.range.start.character + 1}`,
          ),
        ),
      );
    return true;
  };
  const rename = (view: EditorView) => {
    const position = positionOf(view.state.doc, view.state.selection.main.head);
    void lsp
      .request<{ placeholder: string } | null>('textDocument/prepareRename', {
        textDocument: { uri },
        position,
      })
      .then(async prepared => {
        if (!prepared) {
          return;
        }
        const newName = prompt(
          `Rename ${prepared.placeholder} to`,
          prepared.placeholder,
        );
        if (!newName || newName === prepared.placeholder) {
          return;
        }
        const edit = await lsp.request<{
          changes: Record<
            string,
            { newText: string; range: { end: Position; start: Position } }[]
          >;
        }>('textDocument/rename', { textDocument: { uri }, position, newName });
        for (const [target, edits] of Object.entries(edit.changes)) {
          editHook(target, edits);
        }
      })
      .catch((error: Error) => hooks.references([`Rename: ${error.message}`]));
    return true;
  };
  return [
    hints,
    lintGutter(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    northtalk,
    syntaxHighlighting(style),
    autocompletion({ override: [completion] }),
    hover,
    keymap.of([
      { key: 'F12', run: definition },
      { key: 'Shift-F12', run: references },
      { key: 'F2', run: rename },
      ...bindings,
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of(update => {
      if (update.selectionSet) {
        hooks.selected?.();
      }
      if (update.docChanged) {
        hooks.changed(update.state.doc.toString());
      }
    }),
  ];
};

// Applying a rename's edits needs the page's documents; it registers this hook.
let editHook: (
  uri: string,
  edits: { newText: string; range: { end: Position; start: Position } }[],
) => void = () => {};
export const onEdits = (hook: typeof editHook) => {
  editHook = hook;
};

/** The language server's diagnostics, as a CodeMirror transaction. */
export const diagnosticsSpec = (
  state: EditorState,
  diagnostics: readonly LspDiagnostic[],
) =>
  setDiagnostics(
    state,
    diagnostics.map((d): Diagnostic => ({
      from: offsetOf(state.doc, d.range.start),
      to: Math.max(
        offsetOf(state.doc, d.range.start),
        offsetOf(state.doc, d.range.end),
      ),
      severity:
        d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
      message: `${d.message} (${d.code})`,
      source: d.source,
    })),
  );

/** Fetches the suspension marks for a document and shows them. */
export const refreshHints = async (
  view: EditorView,
  uri: string,
  lsp: LspClient,
) => {
  const doc = view.state.doc;
  const result = await lsp.request<
    { label: string; position: Position; tooltip?: string }[] | null
  >('textDocument/inlayHint', {
    textDocument: { uri },
    range: {
      start: { line: 0, character: 0 },
      end: positionOf(doc, doc.length),
    },
  });
  if (view.state.doc !== doc) {
    return;
  }
  view.dispatch({
    effects: setHints.of(
      (result ?? []).map(h => ({
        label: h.label,
        offset: offsetOf(doc, h.position),
        tip: h.tooltip ?? '',
      })),
    ),
  });
};

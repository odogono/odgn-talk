// The Code Browser's gutter mark for literals a Literal Editor can open
// (ADR 0175, #2180): one per line that starts such a literal.
import { RangeSet, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter } from '@codemirror/view';
import { patternTexts } from './pattern-checks';

class LiteralMarker extends GutterMarker {
  constructor(
    readonly at: number,
    readonly label: string,
  ) {
    super();
  }
  override eq(other: LiteralMarker): boolean {
    return other.at === this.at && other.label === this.label;
  }
  override toDOM(): Node {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'literal-editor-mark';
    button.title = `Open in ${this.label}`;
    button.setAttribute('aria-label', button.title);
    button.textContent = '♪';
    return button;
  }
}

/**
 * Marks each literal `label()` names an editor for; clicking one calls
 * `open` with where its text starts. No label, no marks.
 */
export const literalGutter = (
  label: () => string | undefined,
  open: (view: EditorView, at: number) => void,
): Extension =>
  gutter({
    class: 'cm-literal-gutter',
    markers: view => {
      const name = label();
      if (!name) {
        return RangeSet.empty;
      }
      const doc = view.state.doc;
      const seen = new Set<number>();
      const marks = patternTexts(doc.toString())
        .map(found => ({ found, line: doc.lineAt(found.offset) }))
        .filter(({ line }) => !seen.has(line.from) && seen.add(line.from))
        .map(({ found, line }) =>
          new LiteralMarker(found.offset, name).range(line.from),
        );
      return RangeSet.of(marks, true);
    },
    domEventHandlers: {
      click: (view, line, event) => {
        const target = (event.target as HTMLElement).closest(
          '.literal-editor-mark',
        );
        const found = patternTexts(view.state.doc.toString()).find(
          f => view.state.doc.lineAt(f.offset).from === line.from,
        );
        if (!target || !found) {
          return false;
        }
        open(view, found.offset);
        return true;
      },
    },
  });

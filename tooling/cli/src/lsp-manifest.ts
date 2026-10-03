import { rangeAt, type TextEdit } from '@odgn/northtalk-tooling/lsp';

type Frame = {
  key?: string;
  libraries?: boolean;
  library?: boolean;
  name?: string;
  source?: { end: number; start: number; value: string };
};
/** Locate Library source string tokens in already-validated JSON. Editing the
 * field instead of the whole document preserves unrelated JSON/editor edits. */
export const manifestSourceEdits = (
  source: string,
  replacements: ReadonlyMap<string, { after: string; before: string }>,
): TextEdit[] => {
  const stack: Frame[] = [];
  const edits: TextEdit[] = [];
  const strings = /"(?:\\.|[^"\\])*"/y;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    const frame = stack.at(-1);
    if (character === '{' || character === '[') {
      stack.push({
        library: character === '{' && frame?.libraries,
        libraries:
          character === '[' && stack.length === 1 && frame?.key === 'libraries',
      });
    } else if (character === '}' || character === ']') {
      const finished = stack.pop();
      if (finished?.library && finished.name && finished.source) {
        const replacement = replacements.get(finished.name);
        if (replacement) {
          if (finished.source.value !== replacement.before) {
            throw new Error(
              'The Host Manifest changed; retry rename after reload',
            );
          }
          edits.push({
            range: rangeAt(source, finished.source.start, finished.source.end),
            newText: JSON.stringify(replacement.after),
          });
        }
      }
    } else if (character === '"') {
      strings.lastIndex = i;
      const token = strings.exec(source);
      if (!token) {
        throw new Error('Invalid JSON string');
      }
      const value: string = JSON.parse(token[0]);
      const end = strings.lastIndex;
      if (/^\s*:/.test(source.slice(end))) {
        if (frame) {
          frame.key = value;
        }
      } else if (frame?.library) {
        if (frame.key === 'name') {
          frame.name = value;
        }
        if (frame.key === 'source') {
          frame.source = { start: i, end, value };
        }
      }
      i = end - 1;
    }
  }
  if (edits.length !== replacements.size) {
    throw new Error('Cannot locate Library source in the Host Manifest');
  }
  return edits;
};

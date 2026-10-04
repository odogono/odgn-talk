import { isRejectedSource } from '../../../tools/machine/rejected-sources';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkSyntax,
  parseSource,
  parseSourceRecovering,
  syntaxText,
  type SyntaxElement,
} from '../src';

const root = resolve(import.meta.dir, '../../..');
const assertLossless = (source: string, tree: SyntaxElement) => {
  const stack = [tree];
  let offset = 0;
  while (stack.length) {
    const element = stack.pop()!;
    if (element.kind === 'node') {
      expect(element.start).toBe(offset);
      const last = element.children.at(-1);
      expect(element.end).toBe(
        last?.kind === 'node' ? last.end : (last?.end ?? element.start),
      );
      stack.push(...[...element.children].reverse());
    } else {
      for (const trivia of element.leadingTrivia) {
        expect(trivia.pos).toBe(offset);
        expect(trivia.raw).toBe(source.slice(trivia.pos, trivia.end));
        offset = trivia.end;
      }
      expect(element.pos).toBe(offset);
      expect(element.raw).toBe(source.slice(element.pos, element.end));
      offset = element.end;
    }
  }
  expect(offset).toBe(source.length);
};

// These expected codes and positions are authored fixtures, never generated
// from either parser. Run them through the public Core, independently of tools.
const broken = readFileSync(resolve(root, 'tools/grammar/broken.talk'), 'utf8');
for (const part of broken.split(/^-- case: /m).slice(1)) {
  const [label, expectedLine, ...lines] = part.split('\n');
  const source = lines.join('\n');
  const expected = expectedLine!.replace('-- expect: ', '');
  test(`Core syntax fixture: ${label}`, () => {
    const result = parseSource(source);
    const actual = result.error
      ? `${result.error.code} at ${result.error.tok.line}:${result.error.tok.col}`
      : 'parses';
    expect(actual).toBe(expected);
    const recovered = parseSourceRecovering(source);
    expect(recovered.error).toEqual(result.error);
    expect(syntaxText(recovered.tree)).toBe(source);
    assertLossless(source, recovered.tree);
    checkSyntax(recovered.tree);
    if (result.tree) {
      expect(syntaxText(result.tree)).toBe(source);
      assertLossless(source, result.tree);
    }
  });
}

for (const directory of ['corpus', 'spec/stdlib', 'tools/grammar/sketch']) {
  for (const path of new Bun.Glob('**/*.talk').scanSync({
    cwd: resolve(root, directory),
  })) {
    test(`Core lossless source: ${directory}/${path}`, () => {
      const source = readFileSync(resolve(root, directory, path), 'utf8');
      const result = parseSource(source);
      if (result.error && isRejectedSource(resolve(root, directory, path))) {
        const recovered = parseSourceRecovering(source);
        expect(recovered.error).toEqual(result.error);
        expect(syntaxText(recovered.tree)).toBe(source);
        assertLossless(source, recovered.tree);
        return;
      }
      expect(result.error).toBeNull();
      expect(parseSourceRecovering(source)).toMatchObject({
        tree: result.tree,
        error: null,
        diagnostics: [],
      });
      expect(syntaxText(result.tree!)).toBe(source);
      assertLossless(source, result.tree!);
    });
  }
}

for (const directory of ['docs', 'spec']) {
  for (const path of new Bun.Glob('**/*.md').scanSync({
    cwd: resolve(root, directory),
  })) {
    const markdown = readFileSync(resolve(root, directory, path), 'utf8');
    for (const block of markdown.matchAll(
      /^((?:> ?)?)```talk\n([\S\s]*?)^\1```/gm,
    )) {
      const prefix = block[1]!;
      const body = block[2]!
        .split('\n')
        .map(line =>
          line.startsWith(prefix)
            ? line.slice(prefix.length)
            : line.replace(/^>$/, ''),
        )
        .join('\n');
      const first =
        body
          .split('\n')
          .map(line => line.trim())
          .find(line => line && !line.startsWith('--')) ?? '';
      const source =
        /^(on|function|private|use|constant|script\s+variable)\b/.test(first)
          ? body
          : `on example\n${body}end example\n`;
      test(`Core lossless example: ${directory}/${path} at ${block.index}`, () => {
        const result = parseSource(source);
        expect(result.error).toBeNull();
        expect(syntaxText(result.tree!)).toBe(source);
        assertLossless(source, result.tree!);
      });
    }
  }
}

import { expect, test } from 'bun:test';
import { isRejectedSource } from '../../../tools/machine/rejected-sources';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  checkSource,
  compileSource,
  disassemble,
  exportsOf,
  parseSource,
  type CompileOptions,
  type SyntaxElement,
} from '@odgn/northtalk';
import { formatSource } from '../src/format';

const root = resolve(import.meta.dir, '../../..');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });

// Compare tokens, comment bodies and significant/continuation line endings.
// Blank physical lines alone are allowed to disappear.
const spelling = (source: string) => {
  const parsed = parseSource(source);
  expect(parsed.error).toBeNull();
  const stack: SyntaxElement[] = [parsed.tree!];
  const result: string[] = [];
  let content = false;
  const newline = (raw: string) => {
    if (content) {
      result.push(`newline:${raw}`);
    }
    content = false;
  };
  while (stack.length) {
    const element = stack.pop()!;
    if (element.kind === 'node') {
      stack.push(...[...element.children].reverse());
      continue;
    }
    for (const trivia of element.leadingTrivia) {
      if (trivia.kind === 'comment' || trivia.kind === 'bom') {
        result.push(`${trivia.kind}:${trivia.raw}`);
        content = true;
      } else if (trivia.kind === 'continuation') {
        newline(trivia.raw);
      }
    }
    if (element.t === 'nl') {
      newline(element.raw);
    } else if (element.t !== 'eof') {
      result.push(`${element.t}:${element.mode}:${element.raw}`);
      content = true;
    }
  }
  return result;
};

const optionsFor = (path: string): CompileOptions => {
  const dir = dirname(path);
  const setupPath = join(dir, 'case.toml');
  const setup = readdirSync(dir).includes('case.toml')
    ? (Bun.TOML.parse(readFileSync(setupPath, 'utf8')) as {
        libraries?: { source: string }[];
      })
    : {};
  const libraries: NonNullable<CompileOptions['libraries']> =
    Object.fromEntries(
      files(dir)
        .filter(file => file.endsWith('.talk') && file !== path)
        .flatMap(file => {
          const checked = checkSource(readFileSync(file, 'utf8'), {
            unit: 'library',
          });
          return checked.tree
            ? [[basename(file, '.talk'), exportsOf(checked.tree)]]
            : [];
        }),
    );
  return {
    name: basename(path, '.talk'),
    unit:
      path.includes('/spec/stdlib/') ||
      setup.libraries?.some(library => library.source === basename(path))
        ? 'library'
        : 'script',
    libraries,
  };
};

// Examples omit their Host's well-known objects. Supply those bindings just
// as the Core's all-source lowering test does, without editing the example.
const compile = (source: string, options: CompileOptions) => {
  let objects: string[] = [];
  for (;;) {
    const result = compileSource(source, { ...options, objects });
    const unknown = result.diagnostics
      .filter(d => d.code === 'unknown name')
      .map(d => d.message.replace('unknown name: ', ''));
    if (
      result.unit ||
      !unknown.length ||
      unknown.every(name => objects.includes(name))
    ) {
      return result;
    }
    objects = [...new Set([...objects, ...unknown])];
  }
};

const canonical = (text: string) =>
  text.replaceAll(/^( {2}\d{4,} )\d+:\d+ /gm, '$1');

const invariant = (
  source: string,
  options: CompileOptions,
  mustCompile: boolean,
) => {
  const formatted = formatSource(source);
  expect(formatted.error).toBeNull();
  expect(formatSource(formatted.source).source).toBe(formatted.source);
  expect(spelling(formatted.source)).toEqual(spelling(source));
  const before = compile(source, options);
  const after = compile(formatted.source, options);
  expect(after.error).toBeNull();
  if (mustCompile || before.unit) {
    expect(before.unit).not.toBeNull();
    expect(after.unit).not.toBeNull();
    expect(canonical(disassemble(after.unit!))).toBe(
      canonical(disassemble(before.unit!)),
    );
  } else {
    // Some Spec snippets deliberately demonstrate load-time errors or refer
    // to missing Host declarations. There is no Disassembly for such a unit.
    expect(after.unit).toBeNull();
    expect(
      after.diagnostics.map(({ code, message }) => ({ code, message })),
    ).toEqual(
      before.diagnostics.map(({ code, message }) => ({ code, message })),
    );
  }
};

for (const directory of ['corpus', 'spec']) {
  for (const path of files(join(root, directory)).filter(path =>
    path.endsWith('.talk'),
  )) {
    test(`formatter invariants: ${path.slice(root.length + 1)}`, () => {
      invariant(
        readFileSync(path, 'utf8'),
        optionsFor(path),
        !isRejectedSource(path),
      );
    });
  }
}

for (const path of files(join(root, 'spec')).filter(path =>
  path.endsWith('.md'),
)) {
  const markdown = readFileSync(path, 'utf8');
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
    test(`formatter invariants: ${path.slice(root.length + 1)} at ${block.index}`, () => {
      invariant(source, { name: 'example' }, false);
    });
  }
}

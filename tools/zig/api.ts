#!/usr/bin/env bun
// Compares impl/zig/include/talk.h with spec/embedding/talk.go. A name talk.h
// declares that talk.go doesn't is an error; a talk.go name talk.h lacks is
// reported until step 6's conformance gate makes it an error too.
//
// Each talk.go name has one C spelling:
//   type Group, func Text, var AnyShape    talk_group, talk_text, talk_any_shape
//   func (v Value) AsText                  talk_value_as_text
//   func (g *Group) Load, (c *Core) New…   talk_load, talk_new_group: the Core's
//                                          and Group's methods drop the receiver,
//                                          unless that spelling is already taken
//                                          (Group.Script is talk_group_script)
//   const KindText, InvalidValue           TALK_KIND_TEXT, TALK_INVALID_VALUE
//   var ErrLimit                           TALK_ERR_LIMIT, a status code
// A talk.h declaration with no talk.go counterpart, such as a release function,
// is preceded by a comment starting `C only`.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const words = (name: string) =>
  name
    .replaceAll(/([\da-z])([A-Z])/g, '$1_$2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
const lower = (name: string) => `talk_${words(name)}`;
const upper = (name: string) => `TALK_${words(name).toUpperCase()}`;
const exported = (name: string) => /^[A-Z]/.test(name);

/** Maps each exported talk.go declaration to its C name. */
export const goNames = (source: string): Map<string, string> => {
  const names = new Map<string, string>();
  const methods: [string, string][] = [];
  let block: 'const' | 'var' | undefined;
  for (const line of source.split('\n')) {
    if (block) {
      if (line.startsWith(')')) {
        block = undefined;
        continue;
      }
      const name = /^\t([A-Z]\w*)/.exec(line)?.[1];
      if (name) {
        names.set(
          block === 'const' || name.startsWith('Err')
            ? upper(name)
            : lower(name),
          name,
        );
      }
      continue;
    }
    let match = /^(const|var) \($/.exec(line);
    if (match) {
      block = match[1] as 'const' | 'var';
      continue;
    }
    match = /^(?:type|func|var|const) ([A-Z]\w*)/.exec(line);
    if (match) {
      const name = match[1]!;
      names.set(
        line.startsWith('var Err') || line.startsWith('const ')
          ? upper(name)
          : lower(name),
        name,
      );
      continue;
    }
    match = /^func \(\w* ?\*?(\w+)\) ([A-Z]\w*)\(/.exec(line);
    if (match && exported(match[1]!)) {
      methods.push([match[1]!, match[2]!]);
    }
  }
  const short: [string, string, string][] = [];
  for (const [receiver, method] of methods) {
    const long = `${lower(receiver)}_${words(method)}`;
    if (receiver === 'Core' || receiver === 'Group') {
      short.push([lower(method), long, `${receiver}.${method}`]);
    } else {
      names.set(long, `${receiver}.${method}`);
    }
  }
  for (const [name, long, go] of short) {
    const taken =
      names.has(name) || short.filter(([other]) => other === name).length > 1;
    names.set(taken ? long : name, go);
  }
  return names;
};

const marker = '\u0000C-ONLY\u0000';

/** The C names talk.h declares, and whether each is marked `C only`. */
export const headerNames = (source: string): Map<string, boolean> => {
  const text = source
    .replaceAll(/\/\*[\S\s]*?\*\/|\/\/[^\n]*/g, comment =>
      /^\/[*/]\s*C only\b/.test(comment) ? ` ${marker} ` : ' ',
    )
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
    .replaceAll(/\bextern\s+"C"\s*{|^\s*}\s*$/gm, ' ');
  const names = new Map<string, boolean>();
  const add = (name: string | undefined, declaration: string) => {
    if (!name) {
      throw new Error(`talk.h: can't find the name in: ${declaration.trim()}`);
    }
    names.set(name, declaration.includes(marker));
  };
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    } else if (c === ';' && depth === 0) {
      const declaration = text.slice(start, i);
      start = i + 1;
      if (!declaration.trim()) {
        continue;
      }
      const body = /{([\S\s]*)}\s*(\w+)\s*$/.exec(declaration);
      if (/^\s*(?:\S+\s+)?typedef\b/.test(declaration.replace(marker, ''))) {
        if (body) {
          if (/\benum\b/.test(declaration)) {
            for (const enumerator of body[1]!.split(',')) {
              if (enumerator.replace(marker, '').trim()) {
                add(
                  /(\w+)\s*(?:=[^,]*)?$/.exec(enumerator.trim())?.[1],
                  enumerator,
                );
              }
            }
          }
          add(body[2], declaration.replace(body[1]!, ''));
        } else {
          add(
            (/\(\s*\*\s*(\w+)\s*\)/.exec(declaration) ??
              /(\w+)\s*$/.exec(declaration))?.[1],
            declaration,
          );
        }
      } else {
        add(/(\w+)\s*\(/.exec(declaration)?.[1], declaration);
      }
    }
  }
  return names;
};

export const compareAPI = (go: string, header: string) => {
  const want = goNames(go);
  const got = headerNames(header);
  const failures: string[] = [];
  for (const [name, cOnly] of got) {
    if (!name.startsWith('talk_') && !name.startsWith('TALK_')) {
      failures.push(`${name} lacks the talk_ prefix`);
    } else if (cOnly && want.has(name)) {
      failures.push(
        `${name} is marked C only, but talk.go declares ${want.get(name)}`,
      );
    } else if (!cOnly && !want.has(name)) {
      failures.push(
        `${name} matches no talk.go declaration; mark it C only or rename it`,
      );
    }
  }
  const missing = [...want]
    .filter(([name]) => !got.has(name))
    .map(([name, goName]) => `${name} (${goName})`);
  return { failures, missing };
};

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const { failures, missing } = compareAPI(
    await readFile(resolve(root, 'spec/embedding/talk.go'), 'utf8'),
    await readFile(resolve(root, 'impl/zig/include/talk.h'), 'utf8'),
  );
  // Missing names fail only from step 6's conformance gate (#625).
  console.log(
    `${missing.length} talk.go names talk.h doesn't declare yet: ${missing.join(', ')}`,
  );
  for (const failure of failures) {
    console.error(`talk.h: ${failure}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
}

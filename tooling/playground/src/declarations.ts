// The Script tab is the session source (ADR 0051). Apply compares the tab's
// top-level declarations with the session's, and enters each new or changed
// one as an Entry; one the tab no longer has can only go by a Restart.
import {
  parseSource,
  declarationStart,
  syntaxSelector,
  type SyntaxNode,
  type Token,
} from '@odgn/northtalk';

export type TabDeclaration = {
  /** What a redefinition replaces: a Handler, function, constant or Script Variable by name, or a `use` line by its text. */
  key: string;
  /** The declaration's source, as an Entry, without its final line break. */
  source: string;
};

const NAMED =
  /^\s*(?:private\s+)?(on|function|constant|script\s+variable)\s+([\p{L}_][\p{L}\p{N}_]*)/u;

const keyOf = (source: string, declaration: SyntaxNode): string => {
  const handler = declaration.children.find(
    c => c.kind === 'node' && c.rule === 'Handler',
  );
  if (handler?.kind === 'node') {
    const message = handler.children.find(
      c => c.kind === 'node' && c.rule === 'MessageName',
    ) as SyntaxNode;
    const name = (message.children[0] as SyntaxNode).children[0] as Token;
    return `on ${syntaxSelector(handler, name.v)}`;
  }
  const named = NAMED.exec(source);
  return named
    ? `${named[1]!.replaceAll(/\s+/gu, ' ')} ${named[2]}`
    : source.trim();
};

/** Each top-level declaration, in order; a syntax error gives its position. */
export const splitDeclarations = (
  source: string,
):
  | { declarations: TabDeclaration[]; error?: undefined }
  | { error: { code: string; col: number; line: number } } => {
  const parsed = parseSource(source.endsWith('\n') ? source : `${source}\n`);
  if (parsed.error || !parsed.tree) {
    const e = parsed.error!;
    return { error: { code: e.code, line: e.tok.line, col: e.tok.col } };
  }
  const text = source.endsWith('\n') ? source : `${source}\n`;
  return {
    declarations: parsed.tree.children.flatMap(c =>
      c.kind === 'node' && c.rule === 'Declaration'
        ? [
            {
              key: keyOf(text.slice(c.start, c.end), c),
              source: text
                .slice(declarationStart(parsed.tree!, c), c.end)
                .replace(/\s+$/u, ''),
            },
          ]
        : [],
    ),
  };
};

export type Plan = {
  /** The declarations to enter, in the tab's order. */
  enter: TabDeclaration[];
  /** The session's declarations the tab no longer has, so Apply needs a Restart. */
  removed: TabDeclaration[];
};

/** What Apply would enter to bring the session source to the tab's. */
export const planApply = (
  tab: readonly TabDeclaration[],
  session: readonly TabDeclaration[],
): Plan => {
  const current = new Map(session.map(d => [d.key, d.source]));
  const wanted = new Set(tab.map(d => d.key));
  return {
    enter: tab.filter(d => current.get(d.key) !== d.source),
    removed: session.filter(d => !wanted.has(d.key)),
  };
};

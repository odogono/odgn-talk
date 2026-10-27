// What every Test Script runner shares (ADR 0056): the Test Library, finding
// Test Handlers, and where an error was raised. Tooling, so not normative.
import {
  nothing,
  type SyntaxElement,
  type SyntaxNode,
  type Value,
} from '@northtalk/ts';

/**
 * The Test Library's source, supplied by the runner as a Host-supplied
 * Library. Compile it with `atCaller`, so its errors name the Test Script's
 * call, as the stdlib's do.
 */
export const TEST_LIBRARY = `function assert condition, message = "expected true"
  if condition is not true then throw {code: "assertion failed", message: message}
  return nothing
end assert

function assertEqual actual, expected
  if actual is not expected then throw {code: "assertion failed", expected: expected, actual: actual}
  return nothing
end assertEqual
`;

const TEST_HANDLER = /^test[A-Z]/u;

/** A Test Handler, at its `on`. */
export type TestHandler = { col: number; line: number; name: string };

/**
 * The Test Handlers a Test Script declares, parameterless Handlers named
 * `test` and then a capital, once each however many clauses they have, and
 * whether it has an `on setup`.
 */
export const testHandlersOf = (
  tree: SyntaxNode,
): { setup: boolean; tests: TestHandler[] } => {
  const seen = new Map<string, TestHandler>();
  let setup = false;
  for (const declaration of tree.children) {
    const handler =
      declaration.kind === 'node'
        ? declaration.children.find(
            (c): c is SyntaxNode => c.kind === 'node' && c.rule === 'Handler',
          )
        : undefined;
    if (!handler) {
      continue;
    }
    const nodes = handler.children.filter(
      (c): c is SyntaxNode => c.kind === 'node',
    );
    const name = nodes.find(n => n.rule === 'MessageName');
    const word = name && firstToken(name);
    const on = firstToken(handler);
    if (!word || !on || nodes.some(n => n.rule === 'Pattern')) {
      continue;
    }
    if (word.v === 'setup') {
      setup = true;
    } else if (TEST_HANDLER.test(word.v) && !seen.has(word.v)) {
      seen.set(word.v, { name: word.v, line: on.line, col: on.col });
    }
  }
  return { setup, tests: [...seen.values()] };
};

type Token = { col: number; line: number; v: string };
const firstToken = (element: SyntaxElement): Token | undefined => {
  if (element.kind !== 'node') {
    return element as unknown as Token;
  }
  for (const child of element.children) {
    const token = firstToken(child);
    if (token) {
      return token;
    }
  }
  return undefined;
};

/**
 * An error's `at`, which names its Script's call into the Test Library or
 * the stdlib, where its raise is inside them (ADR 0037).
 */
export const errorAt = (
  error: Value,
): { col: number; line: number; unit: string } | undefined => {
  const at = error.kind === 'map' ? error.get('at') : nothing;
  if (at.kind !== 'map') {
    return undefined;
  }
  const [unit, line, col] = [at.get('unit'), at.get('line'), at.get('column')];
  return unit.kind === 'text' && line.kind === 'number' && col.kind === 'number'
    ? {
        unit: unit.asText()!,
        line: Number(line.toString()),
        col: Number(col.toString()),
      }
    : undefined;
};

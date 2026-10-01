import type { DiagnosticCode } from './checker';
import type {
  SemanticElement,
  SemanticNode,
  SemanticToken,
  SourceSpan,
} from './semantic';

export type ControlDiagnostic = {
  code: DiagnosticCode;
  span: SourceSpan;
  text: string;
};
type Context = {
  /** The loop depth at the innermost enclosing `finally` block, if any. */
  finally: number | null;
  lambda: boolean;
  loops: number;
  /** The message the enclosing Handler handles; null outside a Handler. */
  message: string | null;
};
const loopSuffixes = new Set(['queued', 'dropping', 'replacing']);
const suffixes = new Set([...loopSuffixes, 'deciding', 'during']);
const outside: Context = {
  finally: null,
  lambda: false,
  loops: 0,
  message: null,
};

const word = (
  element: SemanticElement | undefined,
  text?: string,
): element is SemanticToken =>
  element?.kind === 'token' &&
  element.type === 'word' &&
  (text === undefined || element.text === text);
const childNode = (node: SemanticNode, rule: SemanticNode['rule']) =>
  node.children.find(
    (child): child is SemanticNode =>
      child.kind === 'node' && child.rule === rule,
  );
/** A MessageName holds one Name, whose semantic node holds the name itself. */
const messageName = (node: SemanticNode | undefined) => {
  const name = node && childNode(node, 'Name')?.children[0];
  return name?.kind === 'name' ? name : undefined;
};

/** Report the first suffix in a Handler head that breaks chapter 5's combining rules. */
const checkSuffixes = (
  handler: SemanticNode,
  message: string | null,
  report: (
    code: DiagnosticCode,
    at: SemanticElement & { text: string },
  ) => void,
) => {
  const seen = new Set<string>();
  const { children } = handler;
  for (let index = 1; index < children.length; index++) {
    const suffix = children[index]!;
    const comma = children[index - 1]!;
    if (
      !word(suffix) ||
      !suffixes.has(suffix.text) ||
      comma.kind !== 'token' ||
      comma.text !== ','
    ) {
      continue;
    }
    const { text } = suffix;
    if (
      seen.has(text) ||
      (loopSuffixes.has(text) && [...seen].some(s => loopSuffixes.has(s))) ||
      (text === 'queued' && seen.has('deciding')) ||
      (text === 'deciding' && seen.has('queued')) ||
      (text === 'during' && message !== 'error')
    ) {
      report('bad suffixes', suffix);
      return;
    }
    seen.add(text);
  }
};

/**
 * Check where control-flow statements, `pass`, `the target` and Handler
 * suffixes may appear. Each Handler, function and Lambda body starts afresh:
 * a Lambda's `return` leaves only the Lambda, and its loops are its own.
 */
export const checkControl = (
  root: SemanticNode,
): readonly ControlDiagnostic[] => {
  const diagnostics: ControlDiagnostic[] = [];
  const report = (
    code: DiagnosticCode,
    at: SemanticElement & { text: string },
  ) => diagnostics.push({ code, span: at.span, text: at.text });
  const work: { context: Context; node: SemanticNode }[] = [
    { node: root, context: outside },
  ];
  while (work.length) {
    const current = work.pop()!;
    const { node } = current;
    let { context } = current;
    switch (node.rule) {
      case 'Handler': {
        const message = messageName(childNode(node, 'MessageName'))?.text;
        context = { ...outside, message: message ?? null };
        checkSuffixes(node, context.message, report);
        break;
      }
      case 'Function':
        context = outside;
        break;
      case 'Lambda':
        context = { ...outside, lambda: true };
        break;
      case 'Repeat':
        context = { ...context, loops: context.loops + 1 };
        break;
      case 'SimpleStatement': {
        const [head, next] = node.children;
        if (
          word(head, 'exit') ||
          (word(head, 'next') && word(next, 'repeat'))
        ) {
          if (!context.loops) {
            report('outside a loop', head);
          } else if (
            context.finally !== null &&
            context.loops <= context.finally
          ) {
            report('leaves finally', head);
          }
        } else if (word(head, 'pass')) {
          if (context.lambda) {
            report('not in a lambda', head);
          } else {
            if (context.finally !== null) {
              report('leaves finally', head);
            }
            const name = messageName(childNode(node, 'MessageName'));
            if (
              name &&
              context.message !== null &&
              name.text !== context.message
            ) {
              report('wrong message', name);
            }
          }
        } else if (
          (word(head, 'return') || word(head, 'veto')) &&
          context.finally !== null
        ) {
          report('leaves finally', head);
        }
        break;
      }
      case 'The': {
        const [the, target, ...rest] = node.children;
        if (
          context.lambda &&
          word(the, 'the') &&
          word(target, 'target') &&
          !rest.length
        ) {
          report('not in a lambda', the);
        }
        break;
      }
    }
    const children = node.children;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]!;
      if (child.kind === 'node') {
        // A `finally` block's own loops may still be left by `exit repeat`.
        const cleanup = word(children[index - 1], 'finally');
        work.push({
          node: child,
          context: cleanup ? { ...context, finally: context.loops } : context,
        });
      }
    }
  }
  return diagnostics;
};

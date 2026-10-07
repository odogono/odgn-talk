import { recoveryBody } from './recovery';
import type { CheckOptions, DiagnosticCode } from './checker';
import { grammar } from './generated/syntax';
import type {
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticToken,
} from './semantic';

type Leaf = SemanticName | SemanticToken;
export type Report = (code: DiagnosticCode, at: Leaf) => void;
type Context = {
  /** The loop depth at the innermost enclosing `finally` block, if any. */
  finally: number | null;
  /** The loop depth at the innermost enclosing Join's body, if any. */
  join: number | null;
  /** Inside a `try` within that Join's body. */
  joinTry: boolean;
  lambda: boolean;
  loops: number;
  /** The message the enclosing Handler handles; null outside a Handler. */
  message: string | null;
  /** Loop depth at the Recovery Catch granting lexical choice permission. */
  recovery: number | null;
};
// A Fallback Handler's message, as its `pass` names it (ADR 0064).
const FALLBACK = 'any message';
const loopSuffixes = new Set(['queued', 'dropping', 'replacing']);
const suffixes = new Set([...loopSuffixes, 'deciding', 'during']);
const outside: Context = {
  finally: null,
  recovery: null,
  join: null,
  joinTry: false,
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
const waits = (node: SemanticNode) =>
  node.children.some(c => c.kind === 'node' && c.rule === 'AndWait');
const firstLeafOf = (e: SemanticElement): Leaf => {
  let current = e;
  while (current.kind === 'node') {
    current = current.children[0]!;
  }
  return current;
};
// Whether a Join's body starts a member: an `ask` or `send` with `and wait`
// outside any Lambda in it.
const hasMember = (join: SemanticNode): boolean => {
  const work = [...join.children];
  while (work.length) {
    const e = work.pop()!;
    if (e.kind !== 'node' || e.rule === 'Lambda') {
      continue;
    }
    if ((e.rule === 'AskTell' || e.rule === 'Send') && waits(e)) {
      return true;
    }
    work.push(...e.children);
  }
  return false;
};
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
  report: Report,
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
      (text === 'during' && message !== 'error') ||
      (text === 'deciding' && message === FALLBACK)
    ) {
      report('bad suffixes', suffix);
      return;
    }
    seen.add(text);
  }
};

const properties = new Set(grammar.properties);
const leaves = (node: SemanticNode) =>
  node.children.filter((child): child is Leaf => child.kind !== 'node');
const keyText = (key: SemanticNode) =>
  leaves(key)
    .map(leaf => leaf.text)
    .join(' ');
/** Descend through production wrappers and grouping parentheses. */
const unwrap = (node: SemanticNode): SemanticNode => {
  for (;;) {
    if (node.children.length === 1 && node.children[0]!.kind === 'node') {
      node = node.children[0] as SemanticNode;
      continue;
    }
    const [open, expression, close] = node.children;
    if (
      node.rule === 'Primary' &&
      node.children.length === 3 &&
      open?.kind === 'token' &&
      open.text === '(' &&
      expression?.kind === 'node' &&
      close?.kind === 'token' &&
      close.text === ')'
    ) {
      node = expression;
      continue;
    }
    return node;
  }
};
/** `me`, `the target` and well-known object names are Host Objects known at load. */
const isHostObject = (element: SemanticElement | undefined) => {
  if (element?.kind !== 'node') {
    return false;
  }
  const base = unwrap(element);
  const [head, next, ...rest] = base.children;
  if (base.rule === 'The') {
    return word(head, 'the') && word(next, 'target') && !rest.length;
  }
  return (
    base.rule === 'Primary' &&
    !next &&
    (word(head, 'me') ||
      (head?.kind === 'name' && head.binding?.kind === 'object'))
  );
};
// Read the last key step without inferring the kind of an intermediate result.
const objectKey = (
  element: SemanticNode,
): { base: SemanticElement; key: string | null } | null => {
  const node = unwrap(element);
  if (node.rule === 'The') {
    const second = node.children[1];
    const base = node.children.at(-1)!;
    if (second?.kind === 'node' && second.rule === 'Key') {
      return { base, key: keyText(second) };
    }
    if (second?.kind === 'token' && second.type === 'str') {
      return { base, key: second.text };
    }
    if (second?.kind === 'token' && second.text === '(') {
      const expression = node.children[2];
      const literal =
        expression?.kind === 'node' ? unwrap(expression).children[0] : null;
      return {
        base,
        key:
          literal?.kind === 'token' && literal.type === 'str'
            ? literal.text
            : null,
      };
    }
  }
  if (node.rule === 'Postfix' && node.children.length >= 3) {
    const key = node.children.at(-1)!;
    if (key.kind === 'node' && key.rule === 'Key') {
      return {
        base: { ...node, children: node.children.slice(0, -2) },
        key: keyText(key),
      };
    }
  }
  return null;
};

/** A Host Object key read calls the Host, unless it is `id` or a Built-in property. */
const hostKey = (key: string) => key !== 'id' && !properties.has(key);

/** A Guard may call only Built-ins, holds no Lambda and reads no Host property but `id`. */
const checkGuard = (guard: SemanticNode, report: Report) => {
  const work = [guard];
  while (work.length) {
    const node = work.pop()!;
    const [head] = node.children;
    if (node.rule === 'Lambda') {
      report('not in a guard', head as Leaf);
      continue;
    }
    if (
      node.rule === 'Call' &&
      head?.kind === 'name' &&
      head.binding?.kind !== 'builtin function'
    ) {
      report('not in a guard', head);
    }
    if (node.rule === 'The' && isHostObject(node.children.at(-1))) {
      const key = node.children.find(
        (child): child is SemanticNode =>
          child.kind === 'node' && child.rule === 'Key',
      );
      const literal = node.children[1];
      const computed = literal?.kind === 'token' && literal.text === '(';
      if (
        (computed && objectKey(node)?.key !== 'id') ||
        (key && hostKey(keyText(key))) ||
        (literal?.kind === 'token' &&
          literal.type === 'str' &&
          literal.text !== 'id')
      ) {
        report('not in a guard', head as Leaf);
      }
    }
    if (node.rule === 'Postfix' && isHostObject(head)) {
      // Only the first key reads the object; later keys read its result.
      const [, apostrophe, key] = node.children;
      if (key?.kind === 'node' && hostKey(keyText(key))) {
        report('not in a guard', apostrophe as Leaf);
      }
    }
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index]!;
      if (child.kind === 'node') {
        work.push(child);
      }
    }
  }
};

/**
 * Check where control-flow statements, `pass`, `the target`, `private`,
 * what Library code may not use,
 * Guard contents and Handler suffixes may appear. Each Handler, function and
 * Lambda body starts afresh: a Lambda's `return` leaves only the Lambda, and
 * its loops are its own.
 */
export const checkControl = (
  root: SemanticNode,
  unit: 'script' | 'library',
  report: Report,
  objectProperties?: CheckOptions['objectProperties'],
  ownerProperties?: CheckOptions['ownerProperties'],
) => {
  const work: { context: Context; node: SemanticNode }[] = [
    { node: root, context: outside },
  ];
  while (work.length) {
    const current = work.pop()!;
    const { node } = current;
    let { context } = current;
    switch (node.rule) {
      case 'Declaration': {
        const [head] = node.children;
        if (unit === 'script' && word(head, 'private')) {
          report('not in a script', head);
        }
        if (unit === 'library' && word(head, 'script')) {
          report('not in a library', head);
        }
        break;
      }
      case 'Send':
        if (unit === 'library') {
          report('not in a library', node.children[0] as Leaf);
        }
        if (context.joinTry && waits(node)) {
          report('not in a join', node.children[0] as Leaf);
        }
        break;
      case 'AskTell':
        if (context.joinTry && waits(node)) {
          report('not in a join', node.children[0] as Leaf);
        }
        break;
      case 'Wait': {
        const [head, next, third] = node.children;
        if (unit === 'library' && word(next, 'for')) {
          report('not in a library', head as Leaf);
        }
        // A Join's closing `end` is its only Suspension Point (chapter 5, Joins).
        if (context.join !== null) {
          report('not in a join', head as Leaf);
        }
        if (word(next, 'for') && word(third, 'all')) {
          if (!hasMember(node)) {
            report('empty join', head as Leaf);
          }
          context = { ...context, join: context.loops, joinTry: false };
        }
        break;
      }
      case 'ChooseOffer':
        if (context.recovery === null) {
          report('not in recovery', firstLeafOf(node));
        }
        break;
      case 'Try': {
        const seen = new Set<string>();
        for (const offer of node.children) {
          if (offer.kind !== 'node' || offer.rule !== 'OfferClause') {
            continue;
          }
          const name = firstLeafOf(offer.children[1]!);
          if (seen.has(name.text)) {
            report('duplicate offer', name);
          }
          seen.add(name.text);
        }
        if (context.join !== null) {
          context = { ...context, joinTry: true };
        }
        break;
      }
      case 'Primary': {
        const [head] = node.children;
        if (unit === 'library' && word(head, 'me')) {
          report('not in a library', head);
        }
        break;
      }
      case 'Handler': {
        // `on any message m`: the Fallback Handler, which a Library can't
        // hold, since imported Handlers are never entry points (ADR 0064).
        const fallback = word(node.children[1], 'any');
        if (fallback && unit === 'library') {
          report('not in a library', node.children[0] as Leaf);
        }
        const message = fallback
          ? FALLBACK
          : messageName(childNode(node, 'MessageName'))?.text;
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
          context.recovery !== null &&
          (word(head, 'return') ||
            word(head, 'veto') ||
            word(head, 'pass') ||
            ((word(head, 'exit') ||
              (word(head, 'next') && word(next, 'repeat'))) &&
              context.loops <= context.recovery))
        ) {
          report('leaves recovery catch', head as Leaf);
        }
        if (word(head, 'set') && next?.kind === 'node') {
          const step = objectKey(next);
          if (step?.key !== null && step && step.base.kind === 'node') {
            const base = unwrap(step.base);
            const root = base.children[0];
            const props =
              base.rule === 'Primary' && base.children.length === 1
                ? word(root, 'me')
                  ? ownerProperties
                  : root?.kind === 'name' &&
                      root.binding?.kind === 'object' &&
                      Object.hasOwn(objectProperties ?? {}, root.text)
                    ? objectProperties![root.text]
                    : undefined
                : undefined;
            if (
              props &&
              (!Object.hasOwn(props, step.key) || !props[step.key])
            ) {
              report("can't write", head);
            }
          }
        }
        if (unit === 'library' && (word(head, 'pass') || word(head, 'veto'))) {
          report('not in a library', head);
        }
        if (context.join !== null) {
          const call = head?.kind === 'node' ? firstLeafOf(head) : head;
          if (
            // `name … and wait` and `f(x) and wait` may run in this Run.
            (waits(node) &&
              (head?.kind === 'name' ||
                (head?.kind === 'node' && head.rule === 'Call'))) ||
            word(head, 'return') ||
            word(head, 'veto') ||
            word(head, 'pass') ||
            ((word(head, 'exit') ||
              (word(head, 'next') && word(next, 'repeat'))) &&
              context.loops <= context.join)
          ) {
            report('not in a join', call as Leaf);
          }
        }
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
            // `pass any message` names a Fallback's message, at `any`.
            const named = messageName(childNode(node, 'MessageName'));
            const name = word(next, 'any')
              ? { leaf: next, text: FALLBACK }
              : named && { leaf: named, text: named.text };
            // Only a Fallback may pass `any message`, so a function can't.
            if (
              name &&
              ((context.message !== null && name.text !== context.message) ||
                (name.text === FALLBACK && context.message !== FALLBACK))
            ) {
              report('wrong message', name.leaf);
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
          unit === 'library' &&
          word(the, 'the') &&
          word(target, 'target') &&
          !rest.length
        ) {
          report('not in a library', the);
        }
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
        if (child.rule === 'Expression' && word(children[index - 1], 'where')) {
          checkGuard(child, report);
        }
        // A `finally` block's own loops may still be left by `exit repeat`.
        const cleanup = word(children[index - 1], 'finally');
        work.push({
          node: child,
          context: {
            ...context,
            ...(cleanup ? { finally: context.loops } : {}),
            ...(recoveryBody(node, index) ? { recovery: context.loops } : {}),
          },
        });
      }
    }
  }
};

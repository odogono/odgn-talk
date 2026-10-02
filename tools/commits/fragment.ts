// Reads a changelog fragment: one file in changelog/unreleased/ per PR that
// needs an entry, as changelog/README.md describes.
//
//   ---
//   type: feat
//   scope: ts
//   breaking: true
//   ---
//   Add the Store Standard Capability.

import { CHANGELOG_TYPES, SCOPES, type Scope, type Subject } from './message';

export type Fragment = {
  breaking: boolean;
  entry: string;
  scope?: Scope;
  type: (typeof CHANGELOG_TYPES)[number];
};

const FRONTMATTER = /^---\n(?<head>[\S\s]*?)\n---\n(?<body>[\S\s]*)$/;
const KEYS = new Set(['type', 'scope', 'breaking']);

export const parseFragment = (
  text: string,
): { errors: string[] } | { fragment: Fragment } => {
  const match = FRONTMATTER.exec(text.replaceAll('\r\n', '\n'));
  if (!match?.groups) {
    return { errors: ['it must start with a "---" frontmatter block'] };
  }
  const errors: string[] = [];
  const fields = new Map<string, string>();
  for (const line of match.groups.head!.split('\n')) {
    const field = /^(?<key>[a-z]+):\s*(?<value>.*?)\s*$/.exec(line);
    const key = field?.groups?.key;
    if (key === undefined) {
      errors.push(`"${line}" isn't "key: value"`);
    } else if (KEYS.has(key)) {
      fields.set(key, field!.groups!.value!);
    } else {
      errors.push(`unknown key "${key}"`);
    }
  }
  const type = fields.get('type');
  const scope = fields.get('scope');
  const breaking = fields.get('breaking');
  if (type === undefined) {
    errors.push('"type" is missing');
  } else if (!(CHANGELOG_TYPES as readonly string[]).includes(type)) {
    errors.push(
      `type "${type}" isn't one of ${CHANGELOG_TYPES.join(', ')}; a breaking change of another type uses the closest of these with "breaking: true"`,
    );
  }
  if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope)) {
    errors.push(`unknown scope "${scope}"; use one of ${SCOPES.join(', ')}`);
  }
  if (breaking !== undefined && breaking !== 'true' && breaking !== 'false') {
    errors.push(`"breaking" must be true or false, not "${breaking}"`);
  }
  const entry = match.groups.body!.trim();
  if (entry === '') {
    errors.push('the entry text after the frontmatter is empty');
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    fragment: {
      breaking: breaking === 'true',
      entry,
      scope: scope as Scope | undefined,
      type: type as Fragment['type'],
    },
  };
};

// Whether a fragment records the change a PR title describes: the same type
// and scope, and breaking when the change is.
export const fragmentMatches = (
  fragment: Fragment,
  subject: Subject,
  breaking: boolean,
): boolean =>
  fragment.scope === subject.scope &&
  fragment.breaking === breaking &&
  ((CHANGELOG_TYPES as readonly string[]).includes(subject.type)
    ? fragment.type === subject.type
    : breaking);

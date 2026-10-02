// Reads a Conventional Commit subject, as docs/agents/commits.md describes:
//
//   type(scope)!: Sentence-case imperative description (#issue)
//
// The scope and `!` are optional. A PR's title is its squash commit's subject.

export const TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;
export const SCOPES = ['spec', 'ts', 'cli', 'tools', 'corpus', 'repo'] as const;

// The types whose changes a reader of the changelog would want to hear about.
export const CHANGELOG_TYPES = ['feat', 'fix', 'perf'] as const;

export type CommitType = (typeof TYPES)[number];
export type Scope = (typeof SCOPES)[number];

export type Subject = {
  breaking: boolean;
  description: string;
  scope?: Scope;
  type: CommitType;
};

const SUBJECT =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<description>.*)$/;

export const parseCommitSubject = (
  subject: string,
): { errors: string[] } | { subject: Subject } => {
  const match = SUBJECT.exec(subject);
  if (!match?.groups) {
    return {
      errors: [
        `"${subject}" isn't "type(scope): Description"; the scope and a "!" before the colon are optional`,
      ],
    };
  }
  const { bang, scope } = match.groups;
  const type = match.groups.type!;
  const description = match.groups.description!;
  const errors: string[] = [];
  if (!(TYPES as readonly string[]).includes(type)) {
    errors.push(`unknown type "${type}"; use one of ${TYPES.join(', ')}`);
  }
  if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope)) {
    errors.push(`unknown scope "${scope}"; use one of ${SCOPES.join(', ')}`);
  }
  if (!/^[\dA-Z`]/.test(description)) {
    errors.push(
      `the description "${description}" must start with a capital letter`,
    );
  }
  if (description.endsWith('.')) {
    errors.push("the description doesn't end with a full stop");
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    subject: {
      breaking: bang !== undefined,
      description,
      scope: scope as Scope | undefined,
      type: type as CommitType,
    },
  };
};

// Whether a commit needs a changelog fragment: a changelog type, or a breaking
// change marked by `!` or by a `BREAKING CHANGE:` footer in the body.
export const requiresChangelog = (subject: Subject, body = ''): boolean =>
  (CHANGELOG_TYPES as readonly string[]).includes(subject.type) ||
  isBreaking(subject, body);

export const isBreaking = (subject: Subject, body = ''): boolean =>
  subject.breaking || /^BREAKING[ -]CHANGE: /m.test(body);

// Commits git writes itself, or that a later squash or rebase removes. The
// local hook lets these through; they never reach main as written.
export const isExemptLocalMessage = (subject: string): boolean =>
  /^(fixup! |squash! |amend! |Merge |Revert ")/.test(subject);

// Splits a commit message file into its subject and body, dropping the `#`
// comment lines git adds.
export const splitMessage = (
  text: string,
): { body: string; subject: string } => {
  const lines = text
    .split('\n')
    .filter(line => !line.startsWith('#'))
    .map(line => line.trimEnd());
  const start = lines.findIndex(line => line !== '');
  if (start === -1) {
    return { body: '', subject: '' };
  }
  return {
    body: lines
      .slice(start + 1)
      .join('\n')
      .trim(),
    subject: lines[start]!,
  };
};

// Renders the dependencies between open issues as Markdown with a Mermaid
// flowchart. A relation comes from GitHub's sub-issues and issue dependencies,
// or from the text fallbacks docs/agents/issue-tracker.md allows in a body:
// `Part of #N`, `Blocked by: #N` and `Blocks #N`.

export type Issue = {
  assignees: string[];
  blockedBy: number[];
  body: string;
  labels: string[];
  number: number;
  parent?: number;
  state: 'OPEN' | 'CLOSED';
  subIssues: number[];
  title: string;
};

export type Relations = {
  // blocked issue -> its blockers
  blockers: Map<number, Set<number>>;
  parentOf: Map<number, number>;
  // `${blocker}>${blocked}` for blocks declared only in issue text
  textOnly: Set<string>;
};

const refs = (text: string): number[] =>
  [...text.matchAll(/#(\d+)/g)].map(m => Number(m[1]));

export const relations = (issues: ReadonlyMap<number, Issue>): Relations => {
  const parentOf = new Map<number, number>();
  const blockers = new Map<number, Set<number>>();
  const native = new Set<string>();
  const fromText = new Set<string>();

  const block = (blocked: number, blocker: number, text: boolean) => {
    if (blocked === blocker || !issues.has(blocked) || !issues.has(blocker)) {
      return;
    }
    let set = blockers.get(blocked);
    if (!set) {
      set = new Set();
      blockers.set(blocked, set);
    }
    set.add(blocker);
    (text ? fromText : native).add(`${blocker}>${blocked}`);
  };

  for (const issue of issues.values()) {
    if (issue.parent !== undefined) {
      parentOf.set(issue.number, issue.parent);
    }
    for (const sub of issue.subIssues) {
      parentOf.set(sub, issue.number);
    }
    for (const blocker of issue.blockedBy) {
      block(issue.number, blocker, false);
    }
  }

  // Text comes second so a GitHub sub-issue wins over a `Part of` line.
  for (const issue of issues.values()) {
    for (const raw of issue.body.split('\n')) {
      const line = raw.replaceAll('**', '').trim();

      const partOf = /^part of #(\d+)/i.exec(line);
      if (partOf && !parentOf.has(issue.number)) {
        parentOf.set(issue.number, Number(partOf[1]));
      }

      const blocks = /^blocks:? (.*)/i.exec(line);
      if (blocks) {
        for (const n of refs(blocks[1]!)) {
          block(n, issue.number, true);
        }
      }

      // `Blocked by: #C`, `#A and #B are blocked by #C`, or a map's
      // `- [ ] #A: ... blocked by #C`: issues before the phrase wait on
      // those after it, and a line naming none before it means this issue.
      const at = line.search(/blocked by/i);
      if (at >= 0) {
        const before = refs(line.slice(0, at));
        const after = refs(line.slice(at));
        for (const a of before.length > 0 ? before : [issue.number]) {
          for (const b of after) {
            block(a, b, true);
          }
        }
      }
    }
  }

  const textOnly = new Set([...fromText].filter(e => !native.has(e)));
  return { blockers, parentOf, textOnly };
};

const REPO = 'https://github.com/odogono/odgn-talk/issues';

const escapeLabel = (s: string) =>
  s.replaceAll('"', '#quot;').replaceAll(/[<>]/g, '');
const truncate = (s: string, max = 48) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;
const node = (n: number) => `i${n}`;

// Writes `#N` and `@name` as code so GitHub doesn't link them, which would
// add a "mentioned in" event to each issue's timeline and ping people. GitHub
// decodes entities before linking, so `&#35;N` isn't enough. The Mermaid
// block needs none of this: code isn't linked.
export const quiet = (s: string) =>
  s.replaceAll(/[#@](?=\w)[\w-]*/g, m => `\`${m}\``);

export const renderGraph = (
  issues: ReadonlyMap<number, Issue>,
  generated: string,
): string => {
  const { blockers, parentOf, textOnly } = relations(issues);
  const isOpen = (n: number) => issues.get(n)?.state === 'OPEN';
  const open = [...issues.values()]
    .filter(i => i.state === 'OPEN')
    .sort((a, b) => a.number - b.number);
  const children = (n: number) =>
    [...issues.values()].filter(i => parentOf.get(i.number) === n);
  const openBlockers = (n: number) =>
    [...(blockers.get(n) ?? [])].filter(isOpen).sort((a, b) => a - b);

  // Only open issues are drawn; closed sub-issues show as a parent's progress.
  const drawn = new Set<number>();
  for (const i of open) {
    const p = parentOf.get(i.number);
    if (p !== undefined && isOpen(p)) {
      drawn.add(i.number).add(p);
    }
    for (const b of openBlockers(i.number)) {
      drawn.add(i.number).add(b);
    }
  }
  const drawnChildren = (n: number) =>
    children(n).filter(c => c.state === 'OPEN' && drawn.has(c.number));

  const label = (i: Issue) => {
    const kids = children(i.number);
    const done = kids.filter(k => k.state === 'CLOSED').length;
    const progress = kids.length > 0 ? ` (${done}/${kids.length} done)` : '';
    const who = i.assignees.map(a => ` @${a}`).join('');
    return `"#${i.number} ${escapeLabel(truncate(i.title))}${progress}${who}"`;
  };

  const lines = ['flowchart LR'];
  const emitted = new Set<number>();
  const leaves: number[] = [];
  const emit = (n: number, indent: string) => {
    if (emitted.has(n)) {
      return;
    }
    emitted.add(n);
    const issue = issues.get(n)!;
    const kids = drawnChildren(n);
    if (kids.length > 0) {
      lines.push(
        `${indent}subgraph ${node(n)}[${label(issue)}]`,
        `${indent}  direction LR`,
      );
      for (const k of kids) {
        emit(k.number, `${indent}  `);
      }
      lines.push(`${indent}end`);
    } else {
      const ready = openBlockers(n).length === 0;
      lines.push(
        `${indent}${node(n)}[${label(issue)}]:::${ready ? 'ready' : 'blocked'}`,
      );
      leaves.push(n);
    }
  };

  const sorted = [...drawn].sort((a, b) => a - b);
  for (const n of sorted) {
    const p = parentOf.get(n);
    if (p === undefined || !drawn.has(p) || !isOpen(p)) {
      emit(n, '  ');
    }
  }
  for (const n of sorted) {
    for (const b of openBlockers(n)) {
      const arrow = textOnly.has(`${b}>${n}`) ? '-.->' : '-->';
      lines.push(`  ${node(b)} ${arrow} ${node(n)}`);
    }
  }
  for (const n of leaves) {
    lines.push(`  click ${node(n)} "${REPO}/${n}" _blank`);
  }
  lines.push(
    '  classDef ready fill:#d4f7dc,stroke:#2da44e,color:#000',
    '  classDef blocked fill:#ffe2e0,stroke:#cf222e,color:#000',
  );

  const unrelated = open.filter(i => !drawn.has(i.number));
  const rows = unrelated.map(
    i =>
      `| ${quiet(`#${i.number}`)} | ${quiet(i.title).replaceAll('|', String.raw`\|`)} | ${i.labels.join(', ')} |`,
  );

  return `This issue's body is regenerated by the \`Issue graph\` workflow (\`tools/issues/update.ts\`). Do not edit it by hand.

Generated ${generated} from ${open.length} open issues.

- **Boxes** are parent issues holding their open sub-issues; the title counts closed sub-issues as done.
- **Green**: no open blocker. **Red**: waiting on an open blocker.
- **Solid arrow** \`A --> B\`: a GitHub issue dependency, A blocks B. **Dotted arrow**: the same, declared only in issue text, such as \`Blocked by: #A\`.
- Closed issues are not drawn.

\`\`\`mermaid
${lines.join('\n')}
\`\`\`

## Open issues with no relations

| Issue | Title | Labels |
| --- | --- | --- |
${rows.join('\n')}
`;
};

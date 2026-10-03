import { parseRecord, replayTrace } from '@odgn/northtalk/replay';
import { readDisplay } from '@odgn/northtalk';
import { execute } from './runner';
import { pump } from './generator';
import type { Finding, FuzzCase, Result } from './model';

const ownerAt = (lines: readonly string[], index: number) => {
  const r = parseRecord(lines[index] ?? 'missing');
  const id = r.ids[0] ?? r.fields.get('to') ?? 'group';
  const script = id.split('/r')[0]!.split(':')[0]!;
  const start = lines
    .slice(0, index + 1)
    .reverse()
    .map(parseRecord)
    .find(x => x.ids[0] === id && x.fields.has('handler'));
  return `${script}:${r.fields.get('handler') ?? start?.fields.get('handler') ?? 'go'}`;
};
const finding = (
  oracle: string,
  lines: readonly string[],
  index: number,
  field: string,
  message: string,
  expected?: string,
  actual?: string,
): Finding => ({
  signature: {
    oracle,
    record: parseRecord(lines[index] ?? 'missing').name,
    field,
    owner: ownerAt(lines, index),
  },
  classification: 'semantic',
  index,
  message,
  ...(expected === undefined ? {} : { expected }),
  ...(actual === undefined ? {} : { actual }),
});
export const compareTraces = (
  expected: readonly string[],
  actual: readonly string[],
  oracle = 'differential',
): Finding | undefined => {
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] === actual[i]) {
      continue;
    }
    const a = parseRecord(expected[i] ?? 'missing');
    const b = parseRecord(actual[i] ?? 'missing');
    const field =
      a.name !== b.name
        ? 'record'
        : a.ids.join(' ') !== b.ids.join(' ')
          ? 'id'
          : ([...new Set([...a.fields.keys(), ...b.fields.keys()])].find(
              k => a.fields.get(k) !== b.fields.get(k),
            ) ?? 'line');
    return finding(
      oracle,
      expected[i] ? expected : actual,
      i,
      field,
      `First differing Trace line (${oracle})`,
      expected[i],
      actual[i],
    );
  }
};
export const traceInvariants = (lines: readonly string[]): Finding[] => {
  const ended = new Set<string>();
  const decided = new Set<string>();
  const findings: Finding[] = [];
  for (const [i, line] of lines.entries()) {
    const r = parseRecord(line);
    if (r.input && r.name === 'restore') {
      ended.clear();
      decided.clear();
    }
    if (r.input) {
      continue;
    }
    const seen =
      r.name === 'run' ? ended : r.name === 'decided' ? decided : undefined;
    if (seen && r.ids[0]) {
      if (seen.has(r.ids[0])) {
        findings.push(
          finding(
            'trace-invariant',
            lines,
            i,
            'terminal',
            'Duplicate terminal outcome',
          ),
        );
      }
      seen.add(r.ids[0]);
    }
    for (const key of r.name === 'seg'
      ? ['fuel', 'alloc', 'state']
      : ['fuel', 'alloc']) {
      if (
        r.fields.has(key) &&
        (!Number.isSafeInteger(Number(r.fields.get(key))) ||
          Number(r.fields.get(key)) < 0)
      ) {
        findings.push(
          finding('trace-invariant', lines, i, key, 'Invalid resource counter'),
        );
      }
    }
  }
  return findings;
};
const rollback = (lines: readonly string[]) => {
  const findings: Finding[] = [];
  const vars = new Map<string, string>();
  let before = new Map<string, string>();
  let segments = new Map<
    string,
    { end: string; how: string; line: number }[]
  >();
  let faulted = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const r = parseRecord(line);
    if (r.input && r.name === 'pump') {
      before = new Map(vars);
      segments = new Map();
      faulted = new Set();
    }
    if (!r.input && ['seg', 'preempt'].includes(r.name)) {
      const s = r.ids[0]!.split('/r')[0]!;
      segments.set(s, [
        ...(segments.get(s) ?? []),
        { line: i, how: r.ids[1]!, end: r.fields.get('end') ?? 'preempt' },
      ]);
    }
    if (!r.input && r.name === 'fault') {
      faulted.add(r.ids[0]!.split('/r')[0]!);
    }
    if (!r.input && r.name === 'vars') {
      const s = r.ids[0]!;
      const segs = segments.get(s) ?? [];
      if (
        faulted.has(s) &&
        segs.length === 1 &&
        segs[0]!.how !== 'continue' &&
        segs[0]!.end === 'fault' &&
        before.has(s) &&
        before.get(s) !== line
      ) {
        findings.push(
          finding(
            'rollback',
            lines,
            segs[0]!.line,
            'vars',
            'Faulting isolated Segment changed Script Variables',
            before.get(s),
            line,
          ),
        );
      }
      vars.set(s, line);
    }
  }
  return findings;
};
const completeReplay = (
  c: FuzzCase,
  lines: readonly string[],
  restored: boolean,
) => {
  const replay = replayTrace(
    () => {
      throw new Error('Missing inline source');
    },
    c.setup,
    lines,
    { restoreBetweenPumps: restored },
  );
  let next = replay.next();
  while (!next.done) {
    next = replay.next();
  }
  return next.value;
};
const withoutObservers = (trace: string[]) =>
  trace.filter(l => !/^(> vars|vars )/.test(l));
const renameProjection = (trace: string[]) =>
  trace.map(line => {
    const r = parseRecord(line);
    const fields = [...r.fields].filter(
      ([key]) => !['identity', 'source', 'pos', 'fingerprint'].includes(key),
    );
    return `${r.input ? '> ' : ''}${r.name} ${r.ids.join(' ')} ${fields.map(([k, v]) => `${k}=${v}`).join(' ')}`;
  });
const loadFingerprint = (c: FuzzCase) => {
  const run = execute({
    ...c,
    inputs: c.setup.scripts!.map(s => ({
      kind: 'input',
      line: `> load ${s.name}`,
    })),
  });
  return run.fingerprints.at(-1)?.after;
};
const resourceSweep = (c: FuzzCase) => {
  // Deliberately isolate a finite, non-suspending Handler: arbitrary schedules have no prefix relation.
  const candidate = c.choices.scripts
    .flatMap(s => s.handlers.map(h => ({ script: s.name, handler: h })))
    .find(x => x.handler.kind === 'compute');
  if (!candidate) {
    return [];
  }
  const base: FuzzCase = structuredClone(c);
  base.setup.scripts = base.setup.scripts!.filter(
    s => s.name === candidate.script,
  );
  base.inputs = [
    { kind: 'input', line: `> load ${candidate.script}` },
    {
      kind: 'input',
      line: `> deliver to=${candidate.script} message=${candidate.handler.name}`,
    },
    { kind: 'input', line: pump() },
    { kind: 'input', line: '> vars' },
  ];
  const baseline = execute(base);
  if (baseline.trace.some(l => /^(fault|raise|diag) /.test(l))) {
    return [];
  }
  const findings: Finding[] = [];
  for (const [limit, field] of [
    ['fuel', 'fuelPerRun'],
    ['alloc', 'allocPerRun'],
    ['state', 'persistentState'],
  ] as const) {
    const end = baseline.trace.find(l => l.startsWith('seg '));
    if (!end) {
      continue;
    }
    const amount = Number(parseRecord(end).fields.get(limit));
    if (!(amount > 2)) {
      continue;
    }
    let previous = -1;
    for (const value of [
      ...new Set([1, Math.floor(amount / 2), amount - 1]),
    ].sort((a, b) => a - b)) {
      const lower = structuredClone(base);
      lower.setup.scripts![0]!.limits = {
        ...lower.setup.scripts![0]!.limits,
        [field]: value,
      };
      const actual = execute(lower).trace;
      const faultIndex = actual.findIndex(l => l.startsWith('fault '));
      if (faultIndex < 0) {
        findings.push(
          finding(
            'limit-sweep',
            actual,
            0,
            field,
            `Lower ${field} did not fault`,
          ),
        );
        continue;
      }
      const fault = parseRecord(actual[faultIndex]!);
      const position = Number(fault.fields.get('at')!.split(':').at(-1));
      if (limit !== 'state' && position < previous) {
        findings.push(
          finding(
            'limit-sweep',
            actual,
            faultIndex,
            'at',
            'Fault instruction moved backwards as limit increased',
          ),
        );
      }
      previous = position;
      if (
        fault.fields.get('limit') !== (limit === 'state' ? 'persistent' : limit)
      ) {
        findings.push(
          finding(
            'limit-sweep',
            actual,
            faultIndex,
            'limit',
            'Wrong limit fault',
            limit,
            fault.fields.get('limit'),
          ),
        );
      }
      const divergence = compareTraces(
        baseline.trace.slice(0, faultIndex),
        actual.slice(0, faultIndex),
        'limit-sweep',
      );
      if (divergence) {
        findings.push(divergence);
      }
    }
  }
  return findings;
};
export const checkCase = (
  c: FuzzCase,
  execution = execute(c),
  options: { relations?: boolean } = {},
): Result => {
  const findings: Finding[] = [];
  const checks = new Set(['trace-invariant']);
  const diag = execution.trace.flatMap((l, i) =>
    l.startsWith('diag ') ? [{ line: l, index: i }] : [],
  );
  if (c.expectedDiagnostic) {
    const expected = c.expectedDiagnostic;
    if (
      diag.length !== 1 ||
      parseRecord(diag[0]!.line).fields.get('code') !== JSON.stringify(expected)
    ) {
      findings.push(
        finding(
          'diagnostic',
          execution.trace,
          diag[0]?.index ?? 0,
          'code',
          'Mutation did not produce its known diagnostic',
          expected,
          diag.map(x => x.line).join('\n'),
        ),
      );
    }
    return { execution, findings, checks: ['diagnostic'] };
  }
  if (diag.length) {
    findings.push({
      ...finding(
        'generator-validity',
        execution.trace,
        diag[0]!.index,
        'code',
        'Supposedly valid generated Script was rejected',
      ),
      classification: 'generator',
    });
    return { execution, findings, checks: ['generator-validity'] };
  }
  findings.push(
    ...traceInvariants(execution.trace),
    ...rollback(execution.trace),
  );
  checks.add('rollback');
  checks.add('fingerprint');
  for (const [i, f] of execution.fingerprints.entries()) {
    if (
      ![
        'load',
        'reload',
        'extend',
        'add-library',
        'replace-library',
        'restore',
      ].includes(f.action) &&
      f.before !== f.after
    ) {
      findings.push(
        finding(
          'fingerprint',
          execution.trace,
          i,
          'state',
          'State-only action changed Group Fingerprint',
        ),
      );
    }
  }
  if (options.relations === false) {
    return { execution, findings, checks: [...checks] };
  }
  const normal = completeReplay(c, execution.trace, false);
  const exact = compareTraces(execution.trace, normal, 'concrete-replay');
  if (exact) {
    findings.push(exact);
  }
  const saved = completeReplay(c, execution.trace, true);
  const saveDiff = compareTraces(normal, saved, 'save-restore');
  if (saveDiff) {
    findings.push(saveDiff);
  }
  checks.add('save-restore');
  const changed = structuredClone(c);
  changed.setup.scripts![0]!.limits = {
    ...changed.setup.scripts![0]!.limits,
    fuelPerRun: (changed.setup.scripts![0]!.limits?.fuelPerRun ?? 2000) + 1,
  };
  if (loadFingerprint(c) === loadFingerprint(changed)) {
    findings.push(
      finding(
        'fingerprint',
        execution.trace,
        0,
        'limits',
        'Changed limit did not change Fingerprint',
      ),
    );
  }
  const sourceChanged = structuredClone(c);
  sourceChanged.setup.scripts![0]!.text += '\n';
  if (loadFingerprint(c) === loadFingerprint(sourceChanged)) {
    findings.push(
      finding(
        'fingerprint',
        execution.trace,
        0,
        'identity',
        'Changed source did not change Fingerprint',
      ),
    );
  }
  checks.add('metamorphic');
  const observed = {
    ...c,
    inputs: c.inputs.flatMap(a =>
      a.kind === 'input' && a.line.startsWith('> pump ')
        ? [a, { kind: 'input' as const, line: '> vars' }]
        : [a],
    ),
  };
  const observeDiff = compareTraces(
    withoutObservers(execution.trace),
    withoutObservers(execute(observed).trace),
    'metamorphic-observer',
  );
  if (observeDiff) {
    findings.push(observeDiff);
  }
  const renamed = structuredClone(c);
  for (const script of renamed.setup.scripts!) {
    script.text = script.text!.replaceAll(/\bn\b/g, 'argument');
  }
  const renameDiff = compareTraces(
    renameProjection(execution.trace),
    renameProjection(execute(renamed).trace),
    'metamorphic-rename',
  );
  if (renameDiff) {
    findings.push(renameDiff);
  }
  for (const [i, line] of execution.trace.entries()) {
    const r = parseRecord(line);
    // Core/source identity and `at` positions are not value fields.
    for (const field of ['value', 'result', 'args', 'error', 'vetoes']) {
      if (
        r.fields.has(field) &&
        !r.fields.get(field)!.includes('<function ') &&
        !r.fields.get(field)!.includes('<object ')
      ) {
        const value = readDisplay(r.fields.get(field)!);
        if (!readDisplay(value.toString()).equals(value)) {
          findings.push(
            finding(
              'metamorphic-display',
              execution.trace,
              i,
              field,
              'Display form failed value round trip',
            ),
          );
        }
      }
    }
  }
  findings.push(...resourceSweep(c));
  checks.add('limit-sweep');
  return { execution, findings, checks: [...checks] };
};

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  signatureKey,
  type Feature,
  type Finding,
  type FuzzCase,
  type Result,
} from './model';
import { generate } from './generator';
import { compareTraces } from './oracles';
import { minimize } from './minimize';

export const withWatchdog = <T>(
  operation: Promise<T>,
  milliseconds: number,
  stop: () => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error('Worker timeout'));
    }, milliseconds);
    operation.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
type Capabilities = {
  costModel: string;
  features: Feature[];
  languageVersion: string;
  version: number;
};
export class Worker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    reject(error: Error): void;
    resolve(value: unknown): void;
  };
  private buffer = '';
  private stderr = '';
  private requests = 0;
  private capabilities?: Capabilities;
  constructor(
    private options: {
      entrypoint?: string;
      native?: boolean;
      timeoutMs?: number;
    } = {},
  ) {}
  private start() {
    const entrypoint =
      this.options.entrypoint ??
      fileURLToPath(new URL('./worker.ts', import.meta.url));
    // Fixed entrypoint and argument array. Never invoke a shell or execute Script text as host code.
    const child = spawn(
      this.options.native ? entrypoint : process.execPath,
      this.options.native ? [] : [entrypoint],
      { stdio: 'pipe' },
    );
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-65_536);
    });
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
        this.fail(new Error('Worker output limit'));
        return;
      }
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const pending = this.pending;
      if (!pending) {
        this.fail(new Error('Unexpected worker output'));
        return;
      }
      this.pending = undefined;
      try {
        const value = JSON.parse(line);
        if (value.error) {
          pending.reject(new Error(value.error));
        } else {
          pending.resolve(value);
        }
      } catch {
        pending.reject(new Error('Malformed worker response'));
        this.close();
      }
    });
    child.on('error', error => {
      if (this.child === child) {
        this.fail(error);
      }
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.fail(
          new Error(`Worker crash (${code ?? signal}): ${this.stderr}`),
        );
      }
    });
    child.stdin.on('error', error => {
      if (this.child === child) {
        this.fail(error);
      }
    });
  }
  private fail(error: Error) {
    const pending = this.pending;
    this.pending = undefined;
    this.close();
    pending?.reject(error);
  }
  close() {
    const child = this.child;
    this.child = undefined;
    this.capabilities = undefined;
    this.requests = 0;
    const pending = this.pending;
    this.pending = undefined;
    child?.kill();
    pending?.reject(new Error('Worker closed'));
  }
  async request(
    value: unknown,
    timeoutMs = this.options.timeoutMs ?? 10_000,
  ): Promise<unknown> {
    if (this.pending) {
      throw new Error('Worker requests must be sequential');
    }
    if (this.requests >= 100) {
      this.close();
    } // Bound process-wide compilation caches during long campaigns.
    if (!this.child) {
      this.start();
    }
    this.requests++;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) {
      throw new Error('Worker input limit');
    }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child!.stdin.write(`${text}\n`);
    });
    return withWatchdog(
      response,
      Math.max(1, Math.min(timeoutMs, this.options.timeoutMs ?? 10_000)),
      () => this.close(),
    );
  }
  async supports(c: FuzzCase, timeoutMs: number): Promise<Capabilities> {
    this.capabilities ??= (await this.request(
      { type: 'capabilities' },
      timeoutMs,
    )) as Capabilities;
    if (
      this.capabilities.version !== 1 ||
      !Array.isArray(this.capabilities.features) ||
      c.profile.some(f => !this.capabilities!.features.includes(f))
    ) {
      throw new Error(
        'Runner does not advertise the requested feature profile',
      );
    }
    return this.capabilities;
  }
}
const executionFailure = (error: Error): Finding => ({
  classification: 'execution',
  message: error.message,
  signature: {
    oracle: 'worker',
    record: 'process',
    field: error.message.includes('timeout')
      ? 'timeout'
      : error.message.includes('output')
        ? 'output'
        : 'crash',
    owner: 'group',
  },
});
const run = async (
  c: FuzzCase,
  worker: Worker,
  timeoutMs: number,
): Promise<Result> => {
  try {
    await worker.supports(c, timeoutMs);
    const value = (await worker.request(
      { type: 'run', case: c },
      timeoutMs,
    )) as Result;
    if (
      !Array.isArray(value.findings) ||
      (value.execution && !Array.isArray(value.execution.trace))
    ) {
      throw new Error('Malformed runner result');
    }
    return value;
  } catch (error) {
    if ((error as Error).message.includes('feature profile')) {
      throw error;
    }
    return { findings: [executionFailure(error as Error)] };
  }
};
export const evaluate = async (
  c: FuzzCase,
  ts: Worker,
  go?: Worker,
  timeoutMs = 10_000,
): Promise<Result> => {
  let result = await run(c, ts, timeoutMs);
  if (result.findings[0]?.classification === 'execution') {
    const first = result;
    ts.close();
    result = await run(c, ts, timeoutMs);
    if (
      !result.findings[0] ||
      signatureKey(result.findings[0].signature) !==
        signatureKey(first.findings[0]!.signature)
    ) {
      return {
        ...first,
        findings: [
          {
            ...first.findings[0]!,
            message: `Not reproduced in fresh process: ${first.findings[0]!.message}`,
          },
        ],
      };
    }
  }
  if (go) {
    const a = await ts.supports(c, timeoutMs),
      b = await go.supports(c, timeoutMs);
    if (
      a.languageVersion !== b.languageVersion ||
      a.costModel !== b.costModel
    ) {
      throw new Error('Runner language/Cost Model versions differ');
    }
    const other = await run(c, go, timeoutMs);
    if (other.findings.length) {
      return other;
    }
    if (!other.execution || !result.execution) {
      return {
        findings: result.findings.length
          ? result.findings
          : [executionFailure(new Error('Missing runner Trace'))],
      };
    }
    const diff = compareTraces(result.execution.trace, other.execution.trace);
    if (diff) {
      result = { ...result, findings: [diff, ...result.findings] };
    }
    // Keep the other Core's entire output in the result artifact.
    Object.assign(result, { peer: other });
  }
  return result;
};
export type CampaignOptions = {
  budgetMs?: number;
  commit?: string;
  count?: number;
  goRunner?: string;
  mode: 'smoke' | 'campaign';
  output: string;
  profile?: Feature[];
  reductionMs?: number;
  searchMs?: number;
  seed: string;
};
const save = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');
export const campaign = async (options: CampaignOptions) => {
  const started = performance.now();
  const budget =
    options.budgetMs ?? (options.mode === 'smoke' ? 120_000 : 1_800_000);
  const deadline = started + budget;
  const searchDeadline =
    options.mode === 'smoke'
      ? deadline
      : Math.min(deadline, started + (options.searchMs ?? 1_200_000));
  const ts = new Worker(),
    go = options.goRunner
      ? new Worker({ entrypoint: options.goRunner, native: true })
      : undefined;
  const retained = new Map<
    string,
    { case: FuzzCase; finding: Finding; path: string }
  >();
  const counts: Record<string, number> = {};
  const summary = {
    version: 1,
    mode: options.mode,
    seed: options.seed,
    commit: options.commit ?? 'uncommitted',
    completed: 0,
    findings: 0,
    exhausted: false,
    counts,
    elapsedMs: 0,
  };
  await mkdir(options.output, { recursive: true });
  try {
    while (
      performance.now() < searchDeadline &&
      summary.completed <
        (options.count ??
          (options.mode === 'smoke' ? 64 : Number.MAX_SAFE_INTEGER))
    ) {
      const seed = String(BigInt(options.seed) + BigInt(summary.completed));
      const mutation =
        summary.completed % 8 === 7
          ? (
              [
                'wrong-mode',
                'after-suspension',
                'bad-suffixes',
                'missing-grant',
                'impure-guard',
              ] as const
            )[Math.floor(summary.completed / 8) % 5]
          : undefined;
      const c = generate(seed, {
        features: options.profile,
        mutation,
        commit: summary.commit,
      });
      const timeoutMs = Math.min(10_000, searchDeadline - performance.now());
      const result = await evaluate(c, ts, go, timeoutMs);
      // A case cut short by the search budget is unfinished, not a Worker timeout.
      if (
        timeoutMs < 10_000 &&
        performance.now() >= searchDeadline &&
        result.findings[0]?.signature.field === 'timeout'
      ) {
        break;
      }
      summary.completed++;
      if (result.execution) {
        for (const [key, value] of Object.entries(
          result.execution.counts.records,
        )) {
          counts[key] = (counts[key] ?? 0) + value;
        }
        counts.applied =
          (counts.applied ?? 0) + result.execution.counts.applied;
        counts.noops = (counts.noops ?? 0) + result.execution.counts.noops;
      }
      const first = result.findings[0];
      if (first && !retained.has(signatureKey(first.signature))) {
        const key = createHash('sha256')
          .update(signatureKey(first.signature))
          .digest('hex')
          .slice(0, 16);
        const path = join(options.output, key);
        await mkdir(path, { recursive: true });
        // Raw artifacts are durable before any reduction starts.
        await save(join(path, 'case.json'), c);
        await save(join(path, 'result.json'), result);
        if (result.execution) {
          await writeFile(
            join(path, 'actual.trace'),
            result.execution.trace.join('\n') + '\n',
          );
        }
        const peer = (result as Result & { peer?: Result }).peer;
        if (peer?.execution) {
          await writeFile(
            join(path, 'peer.trace'),
            peer.execution.trace.join('\n') + '\n',
          );
        }
        retained.set(signatureKey(first.signature), {
          case: c,
          finding: first,
          path,
        });
        summary.findings++;
      }
      await save(join(options.output, 'summary.json'), summary);
      if (first && options.mode === 'smoke') {
        break;
      }
    }
    for (const retainedFinding of [...retained.values()].slice(0, 2)) {
      if (
        performance.now() >= deadline ||
        retainedFinding.finding.message.startsWith('Not reproduced')
      ) {
        break;
      }
      const reduction = await minimize(
        retainedFinding.case,
        retainedFinding.finding.signature,
        async (c, remaining) =>
          (
            await evaluate(
              c,
              ts,
              go,
              Math.min(10_000, remaining, deadline - performance.now()),
            )
          ).findings,
        {
          budgetMs: Math.min(
            options.reductionMs ?? 300_000,
            deadline - performance.now(),
          ),
        },
      );
      await save(join(retainedFinding.path, 'minimized.json'), reduction.case);
      await save(join(retainedFinding.path, 'reduction.json'), {
        exhausted: reduction.exhausted,
        attempts: reduction.attempts,
        stages: reduction.stages,
      });
    }
    summary.exhausted =
      options.mode === 'smoke' &&
      !summary.findings &&
      summary.completed < (options.count ?? 64);
    return summary;
  } finally {
    ts.close();
    go?.close();
    summary.elapsedMs = Math.round(performance.now() - started);
    await save(join(options.output, 'summary.json'), summary);
  }
};

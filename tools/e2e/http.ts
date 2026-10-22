// Starts every northtalk runner on examples/http/hello.talk and checks its
// routes and SIGINT exit. Build the runners first, as .github/workflows/e2e-http.yml does.
// Usage: bun tools/e2e/http.ts [bun|node|go|zig…]
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const script = 'examples/http/hello.talk';

const runners: Record<string, readonly string[]> = {
  bun: ['bun', 'tooling/cli/src/main.ts'],
  node: ['node', 'tooling/cli/dist/main.js'],
  go: ['impl/go/dist/northtalk'],
  zig: ['impl/zig/zig-out/bin/northtalk'],
};

type Expect = {
  readonly body?: string;
  readonly json?: unknown;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly text?: string;
};

const checks: readonly Expect[] = [
  { method: 'GET', path: '/', status: 200, text: 'hello' },
  { method: 'GET', path: '/users/7', status: 200, json: { id: '7' } },
  { method: 'POST', path: '/echo', body: 'hi', status: 201, text: 'hi' },
  { method: 'GET', path: '/missing', status: 404 },
  { method: 'GET', path: '/never', status: 500 },
];

const check = async (port: number, c: Expect): Promise<string | undefined> => {
  const response = await fetch(`http://127.0.0.1:${port}${c.path}`, {
    method: c.method,
    body: c.body,
  });
  const text = await response.text();
  if (response.status !== c.status) {
    return `status ${response.status}, want ${c.status}`;
  }
  if (c.text !== undefined && text !== c.text) {
    return `body ${JSON.stringify(text)}, want ${JSON.stringify(c.text)}`;
  }
  if (c.json !== undefined) {
    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('application/json')) {
      return `content-type ${JSON.stringify(type)}`;
    }
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(c.json)) {
      return `json ${text}`;
    }
  }
  return undefined;
};

const run = async (name: string): Promise<string[]> => {
  const command = runners[name];
  if (command === undefined) {
    return [`unknown runner ${name}`];
  }
  const [file = '', ...rest] = command;
  const child = spawn(file, [...rest, '--port', '0', script], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | string>(done => {
    child.on('exit', (code, signal) => done(code ?? signal ?? 'unknown'));
    child.on('error', error => done(error.message));
  });
  const listening = new Promise<number>((done, fail) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (\d+)/u.exec(output);
      if (match !== null) {
        done(Number(match[1]));
      }
    });
    void exited.then(code =>
      fail(new Error(`exited ${code} before listening`)),
    );
    setTimeout(() => fail(new Error('no "listening on" within 20s')), 20_000);
  });
  const results: string[] = [];
  try {
    const port = await listening;
    for (const c of checks) {
      const problem = await check(port, c).catch(String);
      results.push(problem === undefined ? 'ok' : problem);
    }
  } catch (error) {
    child.kill('SIGKILL');
    return [
      error instanceof Error ? error.message : String(error),
      output.trim(),
    ];
  }
  child.kill('SIGINT');
  const code = await Promise.race([
    exited,
    new Promise<string>(done => setTimeout(() => done('timeout'), 5000)),
  ]);
  if (code === 'timeout') {
    child.kill('SIGKILL');
  }
  results.push(code === 130 ? 'ok' : `exit ${code}, want 130`);
  return results;
};

const names = process.argv.slice(2);
const selected = names.length > 0 ? names : Object.keys(runners);
const header = [...checks.map(c => `${c.method} ${c.path}`), 'SIGINT'];
const rows: string[][] = [];
let failed = false;
for (const name of selected) {
  const results = await run(name);
  if (results.length !== header.length) {
    failed = true;
    rows.push([name, ...header.map(() => 'FAIL')]);
    console.error(`${name}: ${results.join('\n')}`);
    continue;
  }
  rows.push([name, ...results.map(r => (r === 'ok' ? 'ok' : 'FAIL'))]);
  results.forEach((r, i) => {
    if (r !== 'ok') {
      failed = true;
      console.error(`${name} ${header[i]}: ${r}`);
    }
  });
}
const table = [['runner', ...header], ...rows];
const widths = table[0]!.map((_, i) =>
  Math.max(...table.map(row => row[i]!.length)),
);
for (const row of table) {
  console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
}
process.exit(failed ? 1 : 0);

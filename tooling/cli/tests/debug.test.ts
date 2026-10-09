import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  linkSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const main = resolve(import.meta.dir, '../src/main.ts');
test('debug --trace replays a Trace Case with reverse steps and Host Input seeking', () => {
  const trace = resolve(
    import.meta.dir,
    '../../../corpus/counters/lifetime/case.trace',
  );
  const result = Bun.spawnSync(
    [process.execPath, main, 'debug', '--trace', trace],
    {
      stdin: new TextEncoder().encode(
        ':break s:3\n:continue\n:vars\n:step\n:back\n:input 0\n:clear\n:continue\n:quit\n',
      ),
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('NorthTalk replay debugger');
  expect(result.stdout.toString()).toContain('paused breakpoint s:3:');
  expect(result.stdout.toString()).toContain('Host Input 0');
  expect(result.stdout.toString()).toContain('end of Trace');
  expect(result.stderr.toString()).toBe('');
});
test('debug CLI runs a Script, steps, inspects and resumes through piped commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  try {
    const file = join(dir, 'demo.talk');
    writeFileSync(
      file,
      'script variable n = 0\non go\n put 1 into n\n put 2 into n\n return n\nend',
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        main,
        'debug',
        file,
        '--trace',
        join(dir, 'demo.trace'),
      ],
      {
        stdin: new TextEncoder().encode(
          ':break 3\n:run go\n:vars\n:step\n:runs\n:vars\n:continue\n:quit\n',
        ),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('paused breakpoint demo:3:');
    expect(result.stdout.toString()).toContain('[demo] n = 0');
    expect(result.stdout.toString()).toContain('paused step demo:4:');
    expect(result.stdout.toString()).toContain('[demo] n = 1');
    expect(result.stdout.toString()).toMatch(/segment 1 fuel \d+/);
    expect(result.stdout.toString()).toContain('completed 2');
    expect(result.stderr.toString()).toBe('');
    const recorded = readFileSync(join(dir, 'demo.trace'), 'utf8');
    expect(recorded).toContain('> load demo');
    expect(recorded).toContain('> pump');
    expect(recorded).not.toContain('> vars');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug CLI copies a Script Variable in source form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  try {
    const file = join(dir, 'demo.talk');
    writeFileSync(
      file,
      [
        'script variable day = nothing',
        'script variable said = nothing',
        'script variable f = nothing',
        'on go',
        ' put ["2026-09-27" as civil date] into day',
        ' put {`"x`: quote & "hi"} into said',
        ' put g into f',
        ' return 1',
        'end',
        'function g n',
        ' return n',
        'end g',
      ].join('\n'),
    );
    const result = Bun.spawnSync([process.execPath, main, 'debug', file], {
      stdin: new TextEncoder().encode(
        ':break 8\n:run go\n:copy day\n:copy said\n:copy f\n:copy nope\n:copy\n:continue\n:quit\n',
      ),
    });
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain('[demo] day = [("2026-09-27" as civil date)]');
    expect(out).toContain('[demo] said = {`"x`: `"hi`}');
    expect(out).toContain(
      '[demo] f is not readable as source: <function demo:g>',
    );
    expect(result.stderr.toString()).toBe(
      'No Script Variable is named nope\nUsage: :copy <name>\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug CLI validates usage and load diagnostics', () => {
  expect(Bun.spawnSync([process.execPath, main, 'debug']).exitCode).toBe(2);
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  try {
    const file = join(dir, 'bad.talk');
    writeFileSync(file, 'on go\n put + into x\nend');
    const result = Bun.spawnSync([process.execPath, main, 'debug', file], {
      stdin: new Uint8Array(),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('unexpected token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug CLI pumps a suspension deadline and keeps the pending step over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  const file = join(dir, 'waiting.talk');
  writeFileSync(file, 'on go\n wait 10 ms\n return 2\nend');
  const child = Bun.spawn([process.execPath, main, 'debug', file], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    child.stdin.write(':break 2\n:run go\n:over\n');
    child.stdin.flush();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('paused step waiting:3:')) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Debugger ended before the step: ${output}`);
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    child.stdin.write(':runs\n:continue\n:quit\n');
    child.stdin.end();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    expect(await child.exited).toBe(0);
    expect(output).toContain('segment 2 fuel');
    expect(output).toContain('completed 2');
    expect(await new Response(child.stderr).text()).toBe('');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const alias of ['same', 'relative', 'symlink', 'hardlink']) {
  test(`debug CLI refuses a ${alias} source alias as its Trace output`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
    try {
      const file = join(dir, 'demo.talk');
      const source = 'on go\n return 2\nend';
      writeFileSync(file, source);
      let trace = file;
      if (alias === 'relative') {
        trace = dir + '/./demo.talk';
      }
      if (alias === 'symlink' || alias === 'hardlink') {
        trace = join(dir, 'trace');
        if (alias === 'symlink') {
          symlinkSync(file, trace);
        } else {
          linkSync(file, trace);
        }
      }
      const result = Bun.spawnSync(
        [process.execPath, main, 'debug', file, '--trace', trace],
        { stdin: new Uint8Array() },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        'Trace file must differ from Script source',
      );
      expect(readFileSync(file, 'utf8')).toBe(source);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Drive the debugger a step at a time: write each input, then read stdout
// until its expected text, so a test can edit the file while paused.
const session = async (
  file: string,
  steps: { edit?: string; input: string; until?: string }[],
) => {
  const child = Bun.spawn([process.execPath, main, 'debug', file], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    for (const step of steps) {
      if (step.edit !== undefined) {
        writeFileSync(file, step.edit);
      }
      child.stdin.write(step.input);
      child.stdin.flush();
      while (step.until && !output.includes(step.until)) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`Debugger ended before "${step.until}": ${output}`);
        }
        output += decoder.decode(chunk.value, { stream: true });
      }
    }
    child.stdin.end();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    return {
      code: await child.exited,
      output,
      errors: await new Response(child.stderr).text(),
    };
  } finally {
    child.kill();
  }
};

const sending =
  'script variable n = 0\non go\n send ping to me\n put 1 into n\n return n\nend\non ping\nend';

test('debug CLI :reload while paused is Fix and Continue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  const file = join(dir, 'fix.talk');
  writeFileSync(file, sending);
  try {
    const { code, output, errors } = await session(file, [
      { input: ':break 4\n:run go\n', until: 'paused breakpoint fix:4:' },
      {
        edit: sending.replace('put 1', 'put 2'),
        input: ':reload\n',
        until: '[y/N]',
      },
      { input: 'y\n', until: 'paused step fix:' },
      { input: ':vars\n:clear\n:continue\n:quit\n' },
    ]);
    expect(code).toBe(0);
    expect(output).toContain('happen again:\n  send ping to fix');
    expect(output).toContain('paused step fix:3:15 fix/r2');
    expect(output).toContain('[fix] n = 0');
    // go runs again first, from the head of the mailbox; then both pings
    // run, the first rewound Run's and the rerun's.
    expect(output).toContain(
      'fix/r2 completed 2\nfix/r3 completed nothing\nfix/r4 completed nothing',
    );
    expect(errors).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug CLI keeps the paused Run when Fix and Continue is declined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  const file = join(dir, 'fix.talk');
  writeFileSync(file, sending);
  try {
    const { output, errors } = await session(file, [
      { input: ':break 4\n:run go\n', until: 'paused breakpoint fix:4:' },
      {
        edit: sending.replace('put 1', 'put 2'),
        input: ':reload\n',
        until: '[y/N]',
      },
      { input: '\n', until: 'not reloaded' },
      { input: ':continue\n', until: 'completed 1' },
      // Not paused, :reload is an ordinary Reload.
      { input: ':reload\n', until: 'reloaded' },
      { input: ':quit\n' },
    ]);
    expect(output).toContain('fix/r1 completed 1');
    expect(errors).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug CLI refuses Fix and Continue past a Suspension Point', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-debug-'));
  const file = join(dir, 'fix.talk');
  const waiting =
    'script variable n = 0\non go\n wait 1 ms\n put 1 into n\nend';
  writeFileSync(file, waiting);
  try {
    const { output, errors } = await session(file, [
      { input: ':break 4\n:run go\n', until: 'paused breakpoint fix:4:' },
      { input: ':reload\n:continue\n:quit\n' },
    ]);
    expect(errors).toContain(
      "fix/r1 has passed a Suspension Point, so it can't be rewound; :continue first",
    );
    expect(output).not.toContain('[y/N]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

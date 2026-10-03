import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'northtalk-node-'));
const main = fileURLToPath(new URL('./main.js', import.meta.url));
try {
  const file = join(directory, 'demo.talk');
  writeFileSync(file, 'on demo\nput {length: 1} into x\nend');
  const standard = spawnSync(process.execPath, [main, 'lint', file], {
    encoding: 'utf8',
  });
  assert.equal(standard.status, 0, standard.stderr);
  assert.match(standard.stdout, /warning \[key-shadows-property]/);
  assert.doesNotMatch(standard.stdout, /prefer-explicit-end/);
  const beginner = spawnSync(
    process.execPath,
    [main, 'lint', '--profile', 'beginner', file],
    { encoding: 'utf8' },
  );
  assert.equal(beginner.status, 0, beginner.stderr);
  assert.match(beginner.stdout, /warning \[prefer-explicit-end]/);
  writeFileSync(
    file,
    'on demo\nput + into x\nput {length: 1} into x\nend demo',
  );
  const malformed = spawnSync(process.execPath, [main, 'lint', file], {
    encoding: 'utf8',
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /unexpected token/);
  assert.match(malformed.stdout, /key-shadows-property/);
  process.stdout.write(
    'Node CLI lint: profiles, advice and syntax recovery passed\n',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

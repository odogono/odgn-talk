// The Zig reactor the WASM tests run, built by `bun run wasm:build` or named by
// NORTHTALK_WASM. Nothing rebuilds it, so the tests that need it skip when it
// is missing, and run old Zig when a pull, rebase or edit has changed the
// sources since: say which, once per test process.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const artifact = resolve(
  import.meta.dirname,
  process.env.NORTHTALK_WASM ?? '../../../.cache/zig-wasi/bin/talk.wasm',
);

const zig = resolve(import.meta.dirname, '../../zig');

/** The newest modification time among the Zig Core's sources. */
const newestSource = (): number =>
  Math.max(
    statSync(join(zig, 'build.zig')).mtimeMs,
    ...readdirSync(join(zig, 'src'), { recursive: true }).map(
      name => statSync(join(zig, 'src', String(name))).mtimeMs,
    ),
  );

if (!existsSync(artifact)) {
  process.stderr.write(
    `${artifact} is missing, so the WASM tests skip; build it with \`bun run wasm:build\`\n`,
  );
} else if (
  process.env.NORTHTALK_WASM === undefined &&
  statSync(artifact).mtimeMs < newestSource()
) {
  process.stderr.write(
    `${artifact} is older than the Zig sources; rebuild it with \`bun run wasm:build\` before trusting WASM failures\n`,
  );
}

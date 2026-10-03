import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newGroup, parseInstant, text } from '../../src/index';
import { createFileHost } from './host';

const now = parseInstant('2026-10-03T09:00:00Z');
const scenarios = [
  { mode: 'immediate', source: 'fault-open.talk' },
  { mode: 'staged', source: 'export.talk' },
  { mode: 'staged', source: 'fault-closed.talk' },
  { mode: 'staged', source: 'unfinished.talk' },
] as const;

for (const scenario of scenarios) {
  const host = createFileHost(scenario.mode);
  const group = newGroup({ name: 'files' });
  try {
    const destination = join(host.directory, 'report.txt');
    writeFileSync(destination, 'old bytes');
    const script = group.load({
      name: 'writer',
      source: readFileSync(new URL(scenario.source, import.meta.url), 'utf8'),
      grants: { output: host.grant },
      limits: { fuelPerRun: 1000 },
    });
    script.deliver({ name: 'export', args: [text('new bytes')] });
    console.log(`\n${scenario.mode}: ${scenario.source}`);
    console.log(`Host directory: ${host.directory}`);
    const first = group.pump(now, { fuelSlice: 50, fuelCap: 50 });
    console.log(
      `After first Pump: ${readFileSync(destination, 'utf8')}; open handles: ${host.openHandles().length}`,
    );
    const result = group.pump(now);
    for (const report of [...first.reports, ...result.reports]) {
      if (report.kind === 'run end') {
        console.log(`Run outcome: ${report.outcome}`);
      }
      if (report.kind === 'effect failure') {
        console.log(`Effect failure: ${report.phase} ${report.status}`);
      }
    }
    console.log(
      `After Run: ${readFileSync(destination, 'utf8')}; open handles: ${host.openHandles().length}`,
    );
    console.log(`Directory entries: ${readdirSync(host.directory).join(', ')}`);
  } finally {
    try {
      group.script('writer')?.stop('Example Host cleanup');
      group.pump(now);
    } finally {
      host.dispose();
    }
  }
}

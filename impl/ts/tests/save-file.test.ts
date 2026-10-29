import { expect, test } from 'bun:test';
import { newGroup, num } from '../src';
import { TextTable } from '../src/save-format';
import {
  openSave,
  readRecords,
  writeRecords,
  writeSections,
} from '../src/save-file';
import type { SaveRecords } from '../src/save-records';
import { raw, rawValue, type RawValue } from './save-edit';

/** A save with a waiting Run and a variable. */
const saved = () => {
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable n = 0\non go x\n  wait 2 s\n  put x into n\n  send to t: ping\nend go',
  });
  g.load({ name: 't', source: 'on ping\n  return 1\nend ping' });
  g.script('s')!.deliver({ name: 'go', args: [num(4)] });
  g.pump(0n);
  return g.save();
};

const rewritten = (
  bytes: Uint8Array,
  edit: (x: SaveRecords<RawValue>) => void,
) => {
  const { header, texts, ...records } = readRecords(bytes, raw);
  edit(records);
  return writeRecords(header, records, raw, new TextTable(texts));
};

const invalid = (f: () => unknown) =>
  expect(f).toThrow(expect.objectContaining({ message: 'invalid save' }));

test('records read and written back give the same bytes', () => {
  const bytes = saved();
  expect(rewritten(bytes, () => {})).toEqual(bytes);
});

test('values() reads what openSave skipped, against the same tables', () => {
  const save = openSave(saved());
  expect(save.scripts.map(s => s.name)).toEqual(['s', 't']);
  const values = save.values(raw);
  expect(values.scripts.map(s => s.name)).toEqual(['s', 't']);
  expect(values.runs.length).toBe(1);
  expect(values.scripts[0]!.variables).toHaveLength(1);
});

test('a byte after a section’s records is invalid', () => {
  const { header, texts, ...x } = readRecords(saved(), raw);
  const bytes = writeSections(
    header,
    raw,
    {
      group: w => {
        w.group(x.group);
        w.w.byte(0);
      },
      libraries: w => w.libraries(x.libraries),
      objects: w => w.objects(x.objects),
      functions: w => w.functions(x.functions),
      calls: w => w.calls(x.calls),
      scripts: w => w.scripts(x.scripts),
      runs: w => w.runs(x.perScript, x.runs),
      work: w => w.work(x.work),
      waits: w => w.waits(x.waits),
      inputs: w => w.inputs(x.inputs),
      decisions: w => w.decisions(x.decisions),
      accounting: w => w.accounting(x.discards, x.changedRoots),
    },
    new TextTable(texts),
  );
  invalid(() => openSave(bytes));
});

test('a reference past its table is invalid', () => {
  invalid(() =>
    openSave(
      rewritten(saved(), x => {
        x.scripts[0]!.owner = 99;
      }),
    ),
  );
});

test('Runs that disagree with the Scripts’ counts are invalid', () => {
  invalid(() =>
    openSave(
      rewritten(saved(), x => {
        x.perScript[0]! += 1;
      }),
    ),
  );
});

test('openSave refuses a malformed value before any value reader runs', () => {
  const bytes = rewritten(saved(), x => {
    x.scripts[0]!.variables[0] = rawValue([255]);
  });
  let read = false;
  invalid(() =>
    openSave(bytes).values({
      read: r => {
        read = true;
        return raw.read(r);
      },
      write: () => {},
    }),
  );
  expect(read).toBe(false);
});

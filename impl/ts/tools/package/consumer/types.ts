// Typechecked against each supported TypeScript, with the strictest settings
// a consumer might use, so the published declarations hold for all of them.
import {
  newGroup,
  num,
  parseInstant,
  type Group,
  type Value,
} from '@northtalk/ts';
import {
  encodeBinaryValue,
  decodeBinaryValue,
} from '@northtalk/ts/message-layer';
import type { DebugController } from '@northtalk/ts/debug';
import type { autoDrive } from '@northtalk/ts/driver';
import type { createRouter } from '@northtalk/ts/notify';
import { SessionHost } from '@northtalk/ts/session';
import type { buildSetupGroup } from '@northtalk/ts/setup';
import type { openSqliteDatabase } from '@northtalk/ts/sqlite';
import type { encodeContents } from '@northtalk/ts/store';
import type { createCore } from '@northtalk/ts/wasm';

export type Modules = [
  DebugController,
  typeof autoDrive,
  typeof createRouter,
  typeof buildSetupGroup,
  typeof openSqliteDatabase,
  typeof encodeContents,
  typeof createCore,
];

const clock: bigint = parseInstant('2026-10-17T09:00:00Z');
const group: Group = newGroup({ name: 'types' });
export const reply: Promise<Value> = group
  .load({ name: 'main', source: 'on total a, b\n  return a + b\nend total' })
  .request({ name: 'total', args: [num(2), num(3)] }).result;
export const lines: string[] = new SessionHost({ now: () => clock }).input(
  '1 + 1',
);

const combined = group
  .script('main')!
  .requestPump({ name: 'total', args: [num(2), num(3)] }, clock, {
    fuelCap: 100,
  });
export const combinedResult: Promise<Value> | undefined = combined.admitted
  ? combined.requested.result
  : undefined;
export const buffer: ArrayBuffer = encodeBinaryValue(num(1));
export const decoded: Value = decodeBinaryValue(buffer);

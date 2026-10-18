// Browser interoperability Host: the worker runs the TS Core, not WASM.
import { createCore } from '../../src/core';
import { encodeValue } from '../../src/encoding';
import {
  decodeBinaryValue,
  encodeBinaryValue,
  decodeBinaryFrame,
  encodeBinaryFrame,
  JsonObject,
  readOrderedJSON,
} from '../../src/message-layer';
import { fromJson, type Json } from '../../src/readers';

const core = createCore();
const group = core.newGroup({ name: 'worker' });
const script = group.load({
  name: 'echo',
  source: 'on echo value\n return value\nend echo',
});
const field = (j: Json, key: string): Json =>
  typeof j === 'object' &&
  j !== null &&
  !Array.isArray(j) &&
  j.kind === 'object'
    ? (j.pairs.find(([k]) => k === key)?.[1] ?? null)
    : null;
const scope = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<{ buffer: ArrayBuffer; frame: boolean }>) => void)
    | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = async ({ data }) => {
  try {
    const input = data.frame ? decodeBinaryFrame(data.buffer) : null;
    const message = input ? field(input, 'message') : null;
    const args = message ? field(message, 'args') : null;
    const value =
      input && Array.isArray(args)
        ? fromJson(args[0]!)
        : decodeBinaryValue(data.buffer);
    const outcome = script.requestPump({ name: 'echo', args: [value] }, 0n);
    if (!outcome.admitted) {
      throw outcome.error;
    }
    if (!outcome.pump.ok) {
      throw outcome.pump.error;
    }
    const result = await outcome.requested.result;
    const buffer = input
      ? encodeBinaryFrame(
          new JsonObject([
            ['ref', field(input, 'ref')],
            ['delivery', outcome.requested.id],
            ['token', field(input, 'token')],
            [
              'ok',
              new JsonObject([
                ['state', outcome.pump.result.state],
                [
                  'fuelUsed',
                  readOrderedJSON(String(outcome.pump.result.fuelUsed)),
                ],
                [
                  'reports',
                  [
                    new JsonObject([
                      ['kind', 'run end'],
                      ['delivery', outcome.requested.id],
                      ['outcome', 'completed'],
                      ['result', readOrderedJSON(encodeValue(result))],
                    ]),
                  ],
                ],
              ]),
            ],
            ['abandoned', []],
          ]),
        )
      : encodeBinaryValue(result);
    scope.postMessage({ buffer }, [buffer]);
    scope.postMessage({ detached: buffer.byteLength === 0 });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};

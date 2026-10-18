// Runs in real Chromium. No Node, WASM, Buffer, or shared linear memory.
import {
  decodeBinaryValue,
  encodeBinaryValue,
  decodeBinaryFrame,
  encodeBinaryFrame,
  readOrderedJSON,
} from '../../src/message-layer';
import { decodeValue } from '../../src/readers';
import { encodeValue } from '../../src/encoding';
import vectors from '../../../testdata/request-pump-binary.json';

const global = globalThis as { results?: Promise<unknown> };
const run = async () => {
  let count = 0;
  for (const vector of vectors) {
    const buffer = encodeBinaryValue(decodeValue(vector.json));
    const actual = Array.from(new Uint8Array(buffer), b =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    if (actual !== vector.hex) {
      throw new Error(`Vector ${vector.json}: ${actual}`);
    }
    if (encodeValue(decodeBinaryValue(buffer)) !== vector.json) {
      throw new Error(`Vector decode ${vector.json}`);
    }
    count++;
  }
  const worker = new Worker('/worker.js', { type: 'module' });
  const transfer = (
    buffer: ArrayBuffer,
    frame: boolean,
  ): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      let reply: ArrayBuffer | undefined;
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = ({ data }) => {
        if (data.error) {
          reject(new Error(data.error));
        } else if (data.buffer) {
          reply = data.buffer;
        } else if (data.detached && reply) {
          resolve(reply);
        } else {
          reject(new Error('Worker failed to transfer reply ownership'));
        }
      };
      worker.postMessage({ buffer, frame }, [buffer]);
      if (buffer.byteLength !== 0) {
        reject(new Error('Host buffer was not detached'));
      }
    });
  try {
    for (const vector of vectors) {
      const back = await transfer(
        encodeBinaryValue(decodeValue(vector.json)),
        false,
      );
      if (encodeValue(decodeBinaryValue(back)) !== vector.json) {
        throw new Error(`Worker changed ${vector.json}`);
      }
    }
    const input = readOrderedJSON(
      '{"m":"request-pump","ref":7,"group":"worker","token":18446744073709551615,"to":{"script":"echo"},"message":{"name":"echo","args":[{"$dec":"0.00"}]},"now":"1970-01-01T00:00:00Z"}',
    );
    const reply = decodeBinaryFrame(
      await transfer(encodeBinaryFrame(input), true),
    );
    if (
      !(
        typeof reply === 'object' &&
        reply !== null &&
        !Array.isArray(reply) &&
        reply.kind === 'object'
      ) ||
      !JSON.stringify(reply).includes('18446744073709551615') ||
      !JSON.stringify(reply).includes('0.00')
    ) {
      throw new Error('Combined envelope lost its token or decimal scale');
    }
    return {
      vectors: count,
      workerValueTransfers: count,
      workerCombinedTransfers: 1,
      ownership: 'detached in both directions',
      core: 'ts',
    };
  } finally {
    worker.terminate();
  }
};
global.results = run();

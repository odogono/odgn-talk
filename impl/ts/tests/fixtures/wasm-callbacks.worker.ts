import { callbackScenario } from '../../tools/wasm-callbacks';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<boolean>) => void;
  postMessage(message: unknown): void;
};
scope.onmessage = async ({ data: binaryCallbacks }) => {
  try {
    scope.postMessage({
      result: await callbackScenario('/talk.wasm', binaryCallbacks),
    });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};

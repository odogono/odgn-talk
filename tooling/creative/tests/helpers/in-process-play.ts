// A `PlayTransport` to a `PlayHost` in this process (#2270), for testing
// `PlayClient` in Bun. Every message is `structuredClone`d both ways, as
// `postMessage` copies it, and replies arrive in a later task, as across a
// real worker boundary. It records each request the host received.
import { PlayHost, type PlayHostOptions } from '../../src/play-host';
import { type PlayTransport } from '../../src/play-client';
import type { PlayRequest, PlayResponse } from '../../src/play-protocol';

export type InProcessPlay = {
  host: PlayHost;
  /** Each request the host received, in order. */
  requests: PlayRequest[];
  transport: PlayTransport;
};

export const inProcessPlay = (
  options: PlayHostOptions & { onRequest?(request: PlayRequest): void } = {},
): InProcessPlay => {
  const listeners: ((response: PlayResponse) => void)[] = [];
  const pending = new Map<number, (response: PlayResponse) => void>();
  const requests: PlayRequest[] = [];
  let nextId = 1;
  const host = new PlayHost(reply => {
    const { id, response } = structuredClone(reply);
    setTimeout(() => {
      for (const listener of listeners) {
        listener(response);
      }
      if (id !== undefined) {
        pending.get(id)?.(response);
        pending.delete(id);
      }
    });
  }, options);
  const request = (body: PlayRequest, transfer: Transferable[] = []) => {
    const id = nextId++;
    const copy = structuredClone(body, { transfer });
    requests.push(copy);
    options.onRequest?.(copy);
    const reply = new Promise<PlayResponse>(resolve =>
      pending.set(id, resolve),
    );
    host.receive({ id, request: copy });
    return reply;
  };
  return {
    host,
    requests,
    transport: {
      request,
      onEvent: listener => void listeners.push(listener),
      end: stop => request(stop),
    },
  };
};

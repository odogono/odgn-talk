// Chapter 7's optional `http` Standard Capability (ADR 0124, ADR 0151). The
// Core checks `serve`'s, `respond`'s and `fetch`'s arguments and the answers
// of `serve` and `fetch`; the Host listens, matches, delivers, answers and
// makes requests.
import {
  defineValueCapability,
  shape,
  type Call,
  type CapabilityDef,
  type Shape,
  type ValueOperation,
} from './capabilities';
import { decimalParts } from './values';
import { isInteger, integerOf } from './decimal';
import { HostError } from './errors';
import { checkFetch, duplicateHeaderNames, fetchAnswerOk } from './http-fetch';
import { encodeJson } from './json';
import type { HostObject } from './objects';
import { ScriptError } from './operations';
import { validComputedMessageName } from './selectors';
import { costOf, fixed, type Costs } from './standard-capabilities';
import { registerStandardChecks } from './standard-capability-checks';
import { map, nothing, text, type Value } from './values';

/** The server Operations, supplied together. */
export type HttpServerImpl = {
  respond(call: Call<unknown>, exchange: HostObject, response: Value): void;
  serve(
    call: Call<unknown>,
    name: string,
    prefix: string,
    message: string,
    options: Value,
  ): void;
  unserve(call: Call<unknown>, name: string): void;
};

/**
 * The client Operation. `fetch` hears the normalized URL, with `query`
 * added, and the request map without `query`: `method` always, `headers`
 * and `body` as given, and `json` as its compact JSON text. It answers
 * `{status, headers, body}` or fails with `bad address`, `network error` or
 * `response too large`, and aborts the request when `call.signal` does.
 */
export type HttpClientImpl = {
  fetch(call: Call<unknown>, url: string, request: Value): void;
};

/**
 * The server Operations, the client Operation, or both; only those supplied
 * are declared. `serve` hears its effective message, `httpRequest` when omitted or
 * Nothing, and its options as a map, empty when omitted or Nothing, and
 * answers through the Call with `{host, port}`. `respond` hears the response
 * map as the Script gave it, except that a `json` value is replaced by its
 * compact JSON text, written by the `json` Library's rules.
 */
export type HttpImpl =
  HttpServerImpl | HttpClientImpl | (HttpServerImpl & HttpClientImpl);

/** A `serve` waits as long as `console`'s `read`. */
export const HTTP_MAX_PENDING_MS = 2_147_483_647;
export const HTTP_DEFAULT_MESSAGE = 'httpRequest';

const exchangeShape: Shape = { k: 'object', kind: 'httpExchange' };
const optional = (s: Shape) => ({ optional: true as const, shape: s });
const responseShape = shape.map({
  status: optional(shape.number),
  headers: optional(shape.openMap({})),
  body: optional(shape.oneOf(shape.text, shape.bytes)),
  json: optional(shape.any),
});
const optionsShape = shape.optional(
  shape.map({ host: optional(shape.text), port: optional(shape.number) }),
);
const addressShape = shape.map({ host: shape.text, port: shape.number });
const textsShape = shape.openMap({});
const requestShape = shape.optional(
  shape.map({
    method: optional(shape.text),
    headers: optional(textsShape),
    query: optional(textsShape),
    body: optional(shape.oneOf(shape.text, shape.bytes)),
    json: optional(shape.any),
  }),
);
const fetchResultShape = shape.map({
  status: shape.number,
  headers: textsShape,
  body: shape.bytes,
});

const whole = (value: Value | undefined): bigint | undefined => {
  const parts =
    value?.kind === 'number' ? decimalParts(value.asDecimal()!) : undefined;
  return parts && isInteger(parts) ? integerOf(parts) : undefined;
};
const given = (m: Value, key: string): Value | undefined =>
  m.entries().find(([k]) => k === key)?.[1];

const effectiveMessage = (args: readonly Value[]): string =>
  args[2]?.asText() ?? HTTP_DEFAULT_MESSAGE;
const invalid = (code: string, field: string) =>
  new ScriptError(code, [['field', text(field)]], true);

// `serve`'s and `unserve`'s checks, in chapter 7's order: name, prefix,
// message, as a store watch's.
const checkServe = (args: readonly Value[], serving: boolean) => {
  if (args[0]!.asText() === '') {
    throw invalid('invalid serve', 'name');
  }
  if (!serving) {
    return;
  }
  if (!args[1]!.asText()!.startsWith('/')) {
    throw invalid('invalid serve', 'prefix');
  }
  const message = effectiveMessage(args);
  if (message.includes(':') || !validComputedMessageName(message, 1)) {
    throw invalid('invalid serve', 'message');
  }
};

// `respond`'s checks: status, headers, then `body` with `json`, whose
// `field` is `json`, and a `json` value the `json` Library can't write.
const checkResponse = (response: Value) => {
  const status = given(response, 'status');
  if (status) {
    const n = whole(status);
    if (n === undefined || n < 100n || n > 599n) {
      throw invalid('invalid response', 'status');
    }
  }
  const headers = given(response, 'headers');
  if (headers?.kind === 'map') {
    if (duplicateHeaderNames(headers)) {
      throw invalid('invalid response', 'headers');
    }
    for (const [, value] of headers.entries()) {
      const ok =
        value.kind === 'text' ||
        (value.kind === 'list' &&
          Array.from(
            { length: value.length },
            (_, i) => value.index(i + 1).kind,
          ).every(kind => kind === 'text'));
      if (!ok) {
        throw invalid('invalid response', 'headers');
      }
    }
  }
  const json = given(response, 'json');
  if (json) {
    if (given(response, 'body')) {
      throw invalid('invalid response', 'json');
    }
    jsonText(json);
  }
};

const jsonText = (json: Value): string => {
  try {
    return encodeJson(json);
  } catch {
    throw invalid('invalid response', 'json');
  }
};

// The response the implementation hears: `json` as its JSON text.
const resolvedResponse = (response: Value): Value => {
  if (!given(response, 'json')) {
    return response;
  }
  return map(
    response
      .entries()
      .map(([k, v]) => [k, k === 'json' ? text(jsonText(v)) : v] as const),
  );
};

const SERVER = ['serve', 'unserve', 'respond'] as const;

/**
 * Optional for Hosts. The binding is the Host's own description of the
 * addresses a Grant may listen on and the origins it may fetch from.
 */
export const httpCapability = (
  impl: HttpImpl,
  costs: Costs,
): CapabilityDef<unknown> => {
  const has = (name: string) =>
    typeof (impl as Record<string, unknown> | undefined)?.[name] === 'function';
  const serving = SERVER.filter(has).length;
  if (serving !== 0 && serving !== SERVER.length) {
    const missing = SERVER.find(name => !has(name))!;
    throw new HostError('invalid value', `Http needs ${missing}`);
  }
  if (serving === 0 && !has('fetch')) {
    throw new HostError(
      'invalid value',
      'Http needs serve, unserve and respond, fetch, or all four',
    );
  }
  const server = impl as HttpServerImpl;
  const client = impl as HttpClientImpl;
  const all: Record<string, () => ValueOperation<unknown>> = {
    serve: () => ({
      mode: 'suspending',
      args: [shape.text, shape.text, shape.optional(shape.text), optionsShape],
      result: addressShape,
      errors: [{ code: 'address in use' }, { code: 'bad address' }],
      maxPendingMs: HTTP_MAX_PENDING_MS,
      cost: costOf(costs, 'serve'),
      start: (call, ...args) =>
        server.serve(
          call,
          args[0]!.asText()!,
          args[1]!.asText()!,
          effectiveMessage(args as Value[]),
          args[3]?.kind === 'map' ? args[3] : map([]),
        ),
    }),
    unserve: () => ({
      mode: 'immediate',
      args: [shape.text],
      result: shape.nothing,
      errors: [],
      cost: costOf(costs, 'unserve'),
      do: (call, name) => {
        server.unserve(call, name!.asText()!);
        return nothing;
      },
    }),
    respond: () => ({
      mode: 'immediate',
      args: [exchangeShape, responseShape],
      result: shape.nothing,
      errors: [
        { code: 'already responded' },
        { code: 'exchange closed' },
        { code: 'not owner' },
      ],
      cost: costOf(costs, 'respond'),
      do: (call, exchange, response) => {
        server.respond(
          call,
          exchange!.asObject()!,
          resolvedResponse(response!),
        );
        return nothing;
      },
    }),
    // No `maxPending`: a fetch waits for the Script's MaxWait.
    fetch: () => ({
      mode: 'suspending',
      args: [shape.text, requestShape],
      result: fetchResultShape,
      errors: [
        { code: 'bad address' },
        { code: 'network error' },
        { code: 'response too large' },
      ],
      cost: costOf(costs, 'fetch'),
      start: (call, ...args) => {
        const { url, request } = checkFetch(args as Value[]);
        client.fetch(call, url, request);
      },
    }),
  };
  const operations: Record<string, ValueOperation<unknown>> = {};
  for (const name of [
    ...(serving ? SERVER : []),
    ...(has('fetch') ? ['fetch'] : []),
  ]) {
    operations[name] = all[name]!();
  }
  const hostErrors: Record<string, readonly string[]> = {
    serve: ['address in use', 'bad address'],
    unserve: [],
    respond: ['already responded', 'exchange closed', 'not owner'],
    fetch: ['bad address', 'network error', 'response too large'],
  };
  for (const [name, op] of Object.entries(operations)) {
    registerStandardChecks(op, {
      error: code => hostErrors[name]!.includes(code),
      arguments: args => {
        if (name === 'respond') {
          checkResponse(args[1]!);
        } else if (name === 'fetch') {
          checkFetch(args);
        } else {
          checkServe(args, name === 'serve');
        }
      },
      ...(name === 'serve'
        ? {
            result: (answer: Value) =>
              answer.kind === 'map' && whole(answer.get('port')) !== undefined,
          }
        : name === 'fetch'
          ? { result: fetchAnswerOk }
          : {}),
    });
  }
  return fixed(defineValueCapability('http', operations));
};

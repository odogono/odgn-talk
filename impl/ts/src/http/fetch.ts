// `http.fetch`'s Host side (spec chapter 7, Fetching; chapter 9, The `http`
// factory; ADR 0151). It checks the origin against the binding and makes one
// buffered request with `node:http` or `node:https`, so it runs under Node
// and Bun. A platform `fetch()` would decompress content and couldn't bound
// the headers, so it isn't used.
import { Buffer } from 'node:buffer';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HostError, ScriptError } from '../errors';
import type { HttpClientImpl } from '../http-capability';
import { fetchOrigin, parseFetchUrl } from '../http-fetch';
import { bytes, listValues, map, num, text, type Value } from '../values';

/** The largest response body `fetch` reads by default: 8 MiB. */
export const HTTP_FETCH_DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The most response header bytes `fetch` reads by default: 64 KiB. */
export const HTTP_FETCH_DEFAULT_MAX_HEADER_BYTES = 64 * 1024;

/** No origin, every origin, or a list of exact origins. */
export type HttpFetchOrigins = 'any' | readonly string[];

export type HttpFetchOptions = {
  /** The certificate authorities HTTPS trusts, instead of the runtime's. */
  ca?: string | Buffer | readonly (string | Buffer)[];
  /** Told why a call failed. Never shown to the Script. */
  log?: (message: string) => void;
  /** The response body bound, 8 MiB by default. */
  maxBodyBytes?: number;
  /** The response header bound, trailers included, 64 KiB by default. */
  maxHeaderBytes?: number;
  /**
   * The origins a Grant may fetch from: a list such as
   * `['https://api.example.com']`, `'any'`, or a function of the Grant's
   * binding giving one of these. By default, and for an empty list or an
   * undefined result, it may fetch from none. Each origin is a scheme, host
   * and optional port, with no path, query or wildcard.
   */
  origins?:
    HttpFetchOrigins | ((binding: unknown) => HttpFetchOrigins | undefined);
};

/** The origins as `scheme://host:port`, or throws `invalid value`. */
export const httpFetchOrigins = (
  origins: HttpFetchOrigins,
): 'any' | Set<string> => {
  if (origins === 'any') {
    return 'any';
  }
  if (!Array.isArray(origins)) {
    throw new HostError(
      'invalid value',
      "A fetch binding's origins are 'any' or a list of origins",
    );
  }
  const out = new Set<string>();
  for (const origin of origins as unknown[]) {
    // Only a scheme, host and port: nothing after the authority.
    const u =
      typeof origin === 'string' && !/:\/\/[^]*[#/?]/.test(origin)
        ? parseFetchUrl(origin)
        : undefined;
    if (!u) {
      throw new HostError('invalid value', `Not an origin: ${String(origin)}`);
    }
    out.add(fetchOrigin(u));
  }
  return out;
};

const failure = (code: string, message: string, data?: Value) =>
  new ScriptError(code, message, data);

// The response's headers by chapter 7: lowercase names in code point order,
// repeated values joined with `, `, `set-cookie` a list.
const responseHeaders = (raw: readonly string[]): Value => {
  const headers = new Map<string, string[]>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), raw[i + 1]!]);
  }
  return map(
    [...headers]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, vs]) => [
        k,
        k === 'set-cookie'
          ? listValues(vs.map(v => text(v)))
          : text(vs.join(', ')),
      ]),
  );
};

const headerBytes = (raw: readonly string[]): number => {
  let n = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    n += Buffer.byteLength(raw[i]!) + Buffer.byteLength(raw[i + 1]!) + 4;
  }
  return n;
};

/** `fetch` for `httpCapability`, alone or beside the router's server Operations. */
export const createHttpFetch = (o: HttpFetchOptions = {}): HttpClientImpl => {
  const fixed =
    typeof o.origins === 'function'
      ? undefined
      : httpFetchOrigins(o.origins ?? []);
  const maxBody = o.maxBodyBytes ?? HTTP_FETCH_DEFAULT_MAX_BODY_BYTES;
  const maxHeader = o.maxHeaderBytes ?? HTTP_FETCH_DEFAULT_MAX_HEADER_BYTES;
  for (const [name, n] of [
    ['maxBodyBytes', maxBody],
    ['maxHeaderBytes', maxHeader],
  ] as const) {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new HostError('invalid value', `${name} must be a whole number`);
    }
  }
  const log = o.log ?? (() => {});

  const allowed = (binding: unknown, origin: string): boolean => {
    let set = fixed;
    if (!set) {
      const given = (o.origins as (b: unknown) => HttpFetchOrigins | undefined)(
        binding,
      );
      set = httpFetchOrigins(given ?? []);
    }
    return set === 'any' || set.has(origin);
  };

  return {
    fetch: (call, url, request) => {
      const u = parseFetchUrl(url)!;
      const origin = fetchOrigin(u);
      let ok: boolean;
      try {
        ok = allowed(call.binding, origin);
      } catch (error) {
        log(`fetch ${url}: ${error instanceof Error ? error.message : error}`);
        ok = false;
      }
      if (!ok) {
        call.fail(failure('bad address', `${origin} isn't allowed`));
        return;
      }

      const method = request.get('method').asText()!;
      const headers: OutgoingHttpHeaders = {};
      const named = new Set<string>();
      for (const [name, value] of request.get('headers').entries()) {
        named.add(name.toLowerCase());
        headers[name] =
          value.kind === 'text'
            ? value.asText()!
            : Array.from({ length: value.length }, (_, i) =>
                value.index(i + 1).asText()!,
              );
      }
      let body: Uint8Array | undefined;
      const given = request.get('body');
      const json = request.get('json');
      if (given.kind === 'text') {
        body = Buffer.from(given.asText()!, 'utf8');
        if (!named.has('content-type')) {
          headers['content-type'] = 'text/plain; charset=utf-8';
        }
      } else if (given.kind === 'bytes') {
        body = given.asBytes()!;
      } else if (json.kind === 'text') {
        body = Buffer.from(json.asText()!, 'utf8');
        if (!named.has('content-type')) {
          headers['content-type'] = 'application/json';
        }
      }
      if (!named.has('accept-encoding')) {
        headers['accept-encoding'] = 'identity';
      }
      if (body) {
        headers['content-length'] = String(body.length);
      }

      let settled = false;
      let req: ClientRequest | undefined;
      const abort = () => {
        settled = true;
        req?.destroy();
      };
      const settle = (f: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        call.signal.removeEventListener('abort', abort);
        f();
        req?.destroy();
      };
      const networkError = (why: string) =>
        settle(() => {
          log(`fetch ${url}: ${why}`);
          call.fail(failure('network error', why));
        });
      const tooLarge = (field: 'headers' | 'body', limit: number) =>
        settle(() =>
          call.fail(
            failure(
              'response too large',
              `The response's ${field} pass ${limit} bytes`,
              map([
                ['field', text(field)],
                ['limit', num(limit)],
              ]),
            ),
          ),
        );

      if (call.signal.aborted) {
        return;
      }
      call.signal.addEventListener('abort', abort, { once: true });

      const onResponse = (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          networkError(`status ${status}`);
          return;
        }
        let seen = headerBytes(res.rawHeaders);
        if (seen > maxHeader) {
          tooLarge('headers', maxHeader);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBody) {
            tooLarge('body', maxBody);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          seen += headerBytes(res.rawTrailers);
          if (seen > maxHeader) {
            tooLarge('headers', maxHeader);
            return;
          }
          if (!res.complete) {
            networkError('the response ended early');
            return;
          }
          settle(() =>
            call.answer(
              map([
                ['status', num(status)],
                ['headers', responseHeaders(res.rawHeaders)],
                ['body', bytes(new Uint8Array(Buffer.concat(chunks)))],
              ]),
            ),
          );
        });
        res.on('aborted', () => networkError('the response was cut off'));
        res.on('error', e => networkError(e.message));
        res.on('close', () => {
          if (!res.complete) {
            networkError('the connection closed early');
          }
        });
      };

      const target = `${u.path}${u.query === undefined ? '' : `?${u.query}`}`;
      const hostname = u.host.startsWith('[') ? u.host.slice(1, -1) : u.host;
      try {
        req = (u.scheme === 'https' ? httpsRequest : httpRequest)({
          hostname,
          port: u.port,
          path: target,
          method,
          headers,
          // One connection per call: nothing kept between calls.
          agent: false,
          // Our own count is the bound; this only stops the parser first.
          maxHeaderSize: maxHeader + 16 * 1024,
          ...(u.scheme === 'https'
            ? {
                rejectUnauthorized: true,
                ...(o.ca
                  ? { ca: o.ca as string | Buffer | (string | Buffer)[] }
                  : {}),
              }
            : {}),
        });
      } catch (error) {
        networkError(error instanceof Error ? error.message : String(error));
        return;
      }
      req.on('response', onResponse);
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        networkError('the server switched protocols');
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'HPE_HEADER_OVERFLOW') {
          tooLarge('headers', maxHeader);
        } else {
          networkError(e.message);
        }
      });
      req.end(body);
    },
  };
};

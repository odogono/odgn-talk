// `http.fetch`'s checks (chapter 7, Fetching; ADR 0151): the request the
// Core accepts, the destination it gives the Host, and the answer it takes
// back. Runtime-neutral: the Host does the I/O.
import { encodeJson } from './json';
import { ScriptError } from './operations';
import { map, text, type Value } from './values';

export const FETCH_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

/** Header names the Host controls, which a Script can't set. */
export const FETCH_HOST_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);

const invalid = (code: string, field: string) =>
  new ScriptError(code, [['field', text(field)]], true);
const badRequest = (field: string) => invalid('invalid request', field);

/** A URL in chapter 7's strict profile, split and normalized. */
export type FetchUrl = {
  host: string;
  /** The path, `/` when empty, as written. */
  path: string;
  /** The effective port: the scheme's default when the URL omits it. */
  port: number;
  /** The query after `?`, as written; undefined when there is none. */
  query?: string;
  scheme: 'http' | 'https';
};

const DIGIT = /^\d+$/;
const HEX = /^[\dA-Fa-f]{2}$/;
const NAME = /^[\dA-Za-z-]+(\.[\dA-Za-z-]+)*$/;
// RFC 3986 unreserved, sub-delims, `:` and `@`; `/` for paths and queries.
const PCHAR = /^[\w!$&'()*+,./:;=@~-]$/;

const defaultPort = (scheme: string) => (scheme === 'https' ? 443 : 80);

const ipv4 = (host: string): boolean => {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every(
      p =>
        DIGIT.test(p) &&
        p.length <= 3 &&
        (p === '0' || !p.startsWith('0')) &&
        Number(p) <= 255,
    )
  );
};

const hexGroup = (g: string) => /^[\dA-Fa-f]{1,4}$/.test(g);
const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));

const ipv6 = (inner: string): boolean => {
  let s = inner;
  const dot = s.lastIndexOf(':');
  if (s.slice(dot + 1).includes('.')) {
    // An embedded IPv4 address stands for the last two groups.
    if (!ipv4(s.slice(dot + 1))) {
      return false;
    }
    s = `${s.slice(0, dot + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length === 1) {
    const all = groupsOf(s);
    return all.length === 8 && all.every(hexGroup);
  }
  if (halves.length !== 2) {
    return false;
  }
  const named = [...groupsOf(halves[0]!), ...groupsOf(halves[1]!)];
  return named.length <= 7 && named.every(hexGroup);
};

const escapesOk = (s: string): boolean => {
  for (let i = s.indexOf('%'); i >= 0; i = s.indexOf('%', i + 1)) {
    if (!HEX.test(s.slice(i + 1, i + 3))) {
      return false;
    }
  }
  return true;
};

const partOk = (s: string, extra: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '%') {
      i += 2;
    } else if (!PCHAR.test(c) && !extra.includes(c)) {
      return false;
    }
  }
  return true;
};

/** Parses and normalizes a fetch URL, or undefined outside the profile. */
export const parseFetchUrl = (url: string): FetchUrl | undefined => {
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f || c === 0x5c) {
      return undefined;
    }
  }
  if (!escapesOk(url)) {
    return undefined;
  }
  const m = /^(https?):\/\//i.exec(url);
  if (!m) {
    return undefined;
  }
  const scheme = m[1]!.toLowerCase() as 'http' | 'https';
  let rest = url.slice(m[0].length);
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    rest = rest.slice(0, hash);
  }
  const end = rest.search(/[/?]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  rest = end < 0 ? '' : rest.slice(end);
  let host: string;
  let portText: string | undefined;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || !ipv6(authority.slice(1, close))) {
      return undefined;
    }
    host = authority.slice(0, close + 1).toLowerCase();
    const after = authority.slice(close + 1);
    if (after !== '') {
      if (!after.startsWith(':')) {
        return undefined;
      }
      portText = after.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    host = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
    portText = colon < 0 ? undefined : authority.slice(colon + 1);
    if (!NAME.test(host)) {
      return undefined;
    }
    if (DIGIT.test(host.slice(host.lastIndexOf('.') + 1)) && !ipv4(host)) {
      return undefined;
    }
  }
  let port = defaultPort(scheme);
  if (portText !== undefined) {
    if (!DIGIT.test(portText)) {
      return undefined;
    }
    port = Number(portText);
    if (port < 1 || port > 65_535) {
      return undefined;
    }
  }
  const q = rest.indexOf('?');
  const path = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? undefined : rest.slice(q + 1);
  if (!partOk(path, '') || (query !== undefined && !partOk(query, '?'))) {
    return undefined;
  }
  return {
    scheme,
    host,
    port,
    path: path === '' ? '/' : path,
    ...(query === undefined ? {} : { query }),
  };
};

/** The origin, `scheme://host:port`, always with its port. */
export const fetchOrigin = (u: FetchUrl): string =>
  `${u.scheme}://${u.host}:${u.port}`;

/** The normalized URL: no default port, no fragment. */
export const fetchUrlText = (u: FetchUrl): string =>
  `${u.scheme}://${u.host}${u.port === defaultPort(u.scheme) ? '' : `:${u.port}`}${u.path}${u.query === undefined ? '' : `?${u.query}`}`;

const utf8 = new TextEncoder();
const UNRESERVED = /^[\w.~-]$/;
const percentEncode = (s: string): string => {
  let out = '';
  for (const byte of utf8.encode(s)) {
    const c = String.fromCharCode(byte);
    out += UNRESERVED.test(c)
      ? c
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
};

const texts = (v: Value): string[] | undefined => {
  if (v.kind === 'text') {
    return [v.asText()!];
  }
  if (v.kind !== 'list') {
    return undefined;
  }
  const out: string[] = [];
  for (let i = 1; i <= v.length; i++) {
    const item = v.index(i);
    if (item.kind !== 'text') {
      return undefined;
    }
    out.push(item.asText()!);
  }
  return out;
};

// RFC 9110 §5.6.2's tchar.
const TOKEN = /^[\w!#$%&'*+.^`|~-]+$/;
const headerValueOk = (s: string) =>
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(s) && !/^[\t ]|[\t ]$/.test(s);

/**
 * Whether a headers map names one header twice in different cases. Shared
 * with `respond`.
 */
export const duplicateHeaderNames = (headers: Value): boolean => {
  const seen = new Set<string>();
  for (const [name] of headers.entries()) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return true;
    }
    seen.add(lower);
  }
  return false;
};

const given = (m: Value, key: string): Value | undefined =>
  m.entries().find(([k]) => k === key)?.[1];

/** What the Host receives: the normalized URL and the request without `query`. */
export type FetchRequest = { request: Value; url: string };

/**
 * Checks `fetch`'s arguments, after their Shapes, in chapter 7's order, and
 * gives what the Host receives. Throws `out of domain` or `invalid request`.
 */
export const checkFetch = (args: readonly Value[]): FetchRequest => {
  const request = args[1] && args[1].kind === 'map' ? args[1] : map([]);
  const methodValue = given(request, 'method');
  const method = methodValue?.asText() ?? 'GET';
  if (!(FETCH_METHODS as readonly string[]).includes(method)) {
    throw new ScriptError(
      'out of domain',
      [
        ['function', text('fetch')],
        ['value', methodValue!],
      ],
      true,
    );
  }
  const url = parseFetchUrl(args[0]!.asText()!);
  if (!url) {
    throw badRequest('url');
  }
  const headers = given(request, 'headers');
  if (headers) {
    if (duplicateHeaderNames(headers)) {
      throw badRequest('headers');
    }
    for (const [name, value] of headers.entries()) {
      const values = texts(value);
      if (
        !TOKEN.test(name) ||
        FETCH_HOST_HEADERS.has(name.toLowerCase()) ||
        !values ||
        !values.every(headerValueOk)
      ) {
        throw badRequest('headers');
      }
    }
  }
  const query = given(request, 'query');
  if (query) {
    const pairs: string[] = [];
    for (const [key, value] of query.entries()) {
      const values = texts(value);
      if (!values) {
        throw badRequest('query');
      }
      for (const v of values) {
        pairs.push(`${percentEncode(key)}=${percentEncode(v)}`);
      }
    }
    if (query.mapSize > 0) {
      if (url.query !== undefined) {
        throw badRequest('query');
      }
      url.query = pairs.join('&');
    }
  }
  const body = given(request, 'body');
  const json = given(request, 'json');
  let jsonText: string | undefined;
  if (json) {
    if (body) {
      throw badRequest('json');
    }
    try {
      jsonText = encodeJson(json);
    } catch {
      throw badRequest('json');
    }
  }
  if ((method === 'GET' || method === 'HEAD') && (body || json)) {
    throw badRequest(body ? 'body' : 'json');
  }
  const out: [string, Value][] = [['method', text(method)]];
  if (headers) {
    out.push(['headers', headers]);
  }
  if (body) {
    out.push(['body', body]);
  }
  if (jsonText !== undefined) {
    out.push(['json', text(jsonText)]);
  }
  return { url: fetchUrlText(url), request: map(out) };
};

const whole = (v: Value): number | undefined => {
  if (v.kind !== 'number') {
    return undefined;
  }
  const n = Number(v.toString());
  return Number.isSafeInteger(n) ? n : undefined;
};

/** Whether the Host's answer follows chapter 7's response rules. */
export const fetchAnswerOk = (answer: Value): boolean => {
  if (answer.kind !== 'map') {
    return false;
  }
  const entries = answer.entries();
  if (entries.map(([k]) => k).join(',') !== 'status,headers,body') {
    return false;
  }
  const [[, status], [, headers], [, body]] = entries as [
    [string, Value],
    [string, Value],
    [string, Value],
  ];
  const n = whole(status);
  if (n === undefined || n < 200 || n > 599 || body.kind !== 'bytes') {
    return false;
  }
  if (headers.kind !== 'map') {
    return false;
  }
  let previous: string | undefined;
  for (const [name, value] of headers.entries()) {
    if (
      !TOKEN.test(name) ||
      name !== name.toLowerCase() ||
      (previous !== undefined && !(previous < name))
    ) {
      return false;
    }
    previous = name;
    const ok =
      name === 'set-cookie'
        ? value.kind === 'list' && texts(value) !== undefined
        : value.kind === 'text';
    if (!ok) {
      return false;
    }
  }
  return true;
};

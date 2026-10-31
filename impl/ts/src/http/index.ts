// The HTTP router and fetch client every Host that offers `http` can build
// on (spec chapter 9, The HTTP router; ADR 0124, ADR 0151), with `node:http`
// and `node:https`.
export {
  createHttpHost,
  HTTP_DEFAULT_MAX_BODY_BYTES,
  requestFields,
  type HttpAddress,
  type HttpHost,
  type HttpHostOptions,
} from './router';
export {
  createHttpFetch,
  HTTP_FETCH_DEFAULT_MAX_BODY_BYTES,
  HTTP_FETCH_DEFAULT_MAX_HEADER_BYTES,
  httpFetchOrigins,
  type HttpFetchOptions,
  type HttpFetchOrigins,
} from './fetch';

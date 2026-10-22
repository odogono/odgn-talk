// The HTTP router every Host that offers `http` can build on (spec chapter 9,
// The HTTP router; ADR 0124). Server-only: it listens with `node:http`.
export {
  createHttpHost,
  HTTP_DEFAULT_MAX_BODY_BYTES,
  requestFields,
  type HttpAddress,
  type HttpHost,
  type HttpHostOptions,
} from './router';

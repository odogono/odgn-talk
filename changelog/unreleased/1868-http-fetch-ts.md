---
type: feat
scope: ts
---
Let Scripts make HTTP requests with `http`'s `fetch` on the TS Core. The Core checks the request and normalizes its URL, and checks the Host's answer. `@northtalk/ts/http` gains `createHttpFetch`, also offered by `createHttpHost({ fetch })`, a `node:http`/`node:https` client that allows no origin unless its binding names exact origins or allows any. It doesn't follow redirects or decompress, bounds the response, verifies TLS and aborts abandoned calls. `httpCapability` now takes the server Operations, `fetch`, or both, and `respond` refuses header names repeated in different cases. The Script Runner fetches from any origin (#1868).

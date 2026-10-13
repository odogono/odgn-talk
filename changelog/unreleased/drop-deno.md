---
type: feat
scope: ts
breaking: true
---
Support only Bun and Node for server-side TS code, and stop checking Deno (ADR 0083). `sqlite` `query` no longer works around Deno 2.9's `iterate`.

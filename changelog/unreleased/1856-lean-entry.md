---
type: feat
scope: ts
---
Add `@northtalk/ts/lean`, which registers no stdlib Library. A Host registers the ones its Scripts use from `@northtalk/ts/stdlib/<name>` with `registerStdlib`, and a bundler drops the rest. This cuts a minimal browser Host from 206,643 to 188,172 bytes gzipped (#1856).

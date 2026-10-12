---
type: perf
scope: ts
---
Pack the TS Core's Unicode tables into compact strings decoded at load, cutting the minified browser bundle from 753 KB to 562 KB (227 KB to 164 KB gzipped) and speeding up normalization, segmentation, case mapping and category lookups (#399).

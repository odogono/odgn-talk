---
type: fix
scope: cli
---

A Runner's generated peer key no longer fails, about one time in 256, with `illegal padding`: its certificate serial number is now always minimally encoded.

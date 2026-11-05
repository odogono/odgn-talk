---
type: feat
scope: repo
---
Let an optional read take a Host Object (#2093). `the optional k of obj` now reads as `the k of obj` does, giving the Core-held `id`, the Host's property, or Nothing for a property the Object Kind doesn't define, so one spelling works whether a Host models a thing as a map or as an object. It used to raise `wrong kind`. The TS and Zig Cores implement it.

---
type: perf
scope: ts
---
Reduce Script and Library Load time by compacting precedence syntax, climbing operator precedence in one parser task, building the semantic tree in the checker's bounds walk, and avoiding repeated token copies and line searches while lexing.

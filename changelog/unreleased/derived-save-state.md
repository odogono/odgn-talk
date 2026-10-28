---
type: fix
scope: repo
---

A save's `functions` table now holds only the Function Value code the save reaches, numbered in the order the writer first meets it, and the `waits` section no longer lists the Group's Run ids, so the TS Core can write the same bytes. `run order` is pinned as the number of Runs started. A worker-protocol Function Value token now belongs to the Group instance that wrote it: a restored Group, even under the same handle after `drop-group`, refuses an earlier token as `wrong group`.

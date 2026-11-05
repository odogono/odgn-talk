---
type: feat
scope: ts
---
Let a page's Group and a Web Worker's Group, or two workers, send to each other's Peers: `messagePortLink` in `@northtalk/ts/peer` carries Remote Sends over a `MessagePort`, a `Worker` or a worker's `self`, and `WorkerSupervisor.closeOnTerminate` fails a terminated worker's pending calls as `unreachable` (#2037).

---
type: fix
---
Suppress Go's `host error` and `call failed` for Host failures at Operation crossings interrupted by Stop or cancellation, while retaining the `call` record and reporting failures during cancellation cleanup (#540).

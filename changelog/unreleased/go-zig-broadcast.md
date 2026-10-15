---
type: feat
scope: repo
---
Add ordinary Broadcast delivery to the experimental Zig-backed Go adapter, preserving drain-time recipient selection and callback admission. Correct shared Zig cancellation selection and default admission-limit checks, and use the specified maxWaitMs Trace field in native Go (#986, #987, #988).

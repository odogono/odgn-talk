---
type: feat
scope: repo
---
Add Reload and Extend to the experimental Zig-backed Go adapter, and run every native Go test that now passes under it in CI. The Zig Message Layer now publishes the records of a refused Reload or Extend to Hosts that opt into crossing Trace observation (#1039, #1041).

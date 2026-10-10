---
type: perf
---
Reduce the Go Core's container slots from 312 to 32 bytes on 64-bit Hosts.
List growth reaches Allocation Budget and Persistent State faults below
wasm32's 4 GiB ceiling at conformance-minimum limits, with measured Host
memory-cap guidance and regression checks (#584). Existing Go saves remain
compatible.

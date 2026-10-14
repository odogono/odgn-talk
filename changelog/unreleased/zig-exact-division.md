---
type: perf
---
Speed up Zig Decimal division about 2× and Quantity arithmetic about 2.7× by taking a fixed-width exact path for terminating division and `div`/`mod`, rejecting repeating fractions early, and parsing Unit catalogue factors at compile time (#923).

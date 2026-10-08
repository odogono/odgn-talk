---
type: feat
breaking: true
---
Both Cores now return public Run accounting from Pump, Reload, Library replacement and Restore: ordered dispatch/discard events, exact cumulative Fuel, causal ancestry and pending descendant counts. Saves preserve this state in new private formats (Go `go/3`, TS `3`); older snapshots are no longer readable. This is the runtime foundation for the Session Commands in #370.

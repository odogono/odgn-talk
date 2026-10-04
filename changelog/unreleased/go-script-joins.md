---
type: feat
---
Add Script-only `wait for all` Joins in Go, with ordered replies, fail-fast errors, retained early answers, MaxJoin/MaxWait limits and cancellation that preserves receivers. Keep replies arriving during a preempted Join body and count pending Join members at suspension in TS. Reject unmarked calls to suspending local Go Handlers before they can hide nested Joins. Grow the Go corpus gate to 124 cases (#134).

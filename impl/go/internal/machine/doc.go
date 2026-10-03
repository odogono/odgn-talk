// Package machine executes standalone lowered Abstract Machine instructions
// with heap-resident frames, clause dispatch, unwind state and Cost Model 0.
// Runs retain plain data across preemption. Instructions requiring later
// messaging, Library or Capability machinery stop at an uncharged boundary.
package machine

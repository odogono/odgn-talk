// Package machine executes standalone lowered Abstract Machine instructions
// with heap-resident frames, clause dispatch, unwind state and Cost Model 0.
// Runs retain plain data across preemption. Turn adapters connect Group sends,
// Object properties and Capabilities; unavailable adapters stop at an uncharged
// boundary. Foreign Function calls use the same paid send adapter.
package machine

// Package machine executes standalone lowered Abstract Machine instructions
// with heap-resident frames, clause dispatch, unwind state and Cost Model 0.
// Runs retain plain data across preemption. Turn adapters connect Group sends,
// Object properties and Capabilities; unavailable adapters stop at an uncharged
// boundary, as do foreign Function Value calls awaiting their reply machinery.
package machine

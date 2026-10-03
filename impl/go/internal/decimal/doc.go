// Package decimal implements Spec-defined decimal values and arithmetic.
// Transcendental functions use outward-rounded intervals, increasing precision
// until both bounds select the same 34-digit half-even result. Integral rounding
// preserves the requested decimal places or reports overflow.
package decimal

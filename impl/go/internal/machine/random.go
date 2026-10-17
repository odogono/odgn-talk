package machine

import "github.com/odogono/odgn-talk/impl/go/internal/value"

// The Script Group's generator for `random(n)`: PCG32, XSH RR, with the
// increment and seeding the Spec fixes (chapter 7, Random numbers; ADR 0096).

const (
	randomMultiplier uint64 = 6364136223846793005
	randomIncrement  uint64 = 1442695040888963407
	randomLimit      uint64 = 1 << 32
)

func randomStep(state uint64) uint64 { return state*randomMultiplier + randomIncrement }

func randomOutput(state uint64) uint32 {
	x := uint32(((state >> 18) ^ state) >> 27)
	rot := uint32(state >> 59)
	return x>>rot | x<<((-rot)&31)
}

// RandomSeedState is the generator state a seed gives.
func RandomSeedState(seed uint64) uint64 { return randomStep(randomStep(0) + seed) }

// nextRandom gives the next whole number 1..n, 1 <= n <= 2^32, and the state
// after it. Draws below (2^32 - n) mod n are rejected, so every result is as
// likely.
func nextRandom(state, n uint64) (uint64, uint64) {
	threshold := (randomLimit - n) % n
	for {
		r := uint64(randomOutput(state))
		state = randomStep(state)
		if r >= threshold {
			return state, r%n + 1
		}
	}
}

// randomBound is `random(n)`'s bound: a whole number 1 to 2^32.
func randomBound(v value.Value) (uint64, *value.Value) {
	if v.Kind != value.Number {
		e := wrong("number", v)
		return 0, &e
	}
	n, err := v.Number().Int64()
	if err != nil || n < 1 || uint64(n) > randomLimit {
		e := failure("out of domain", value.Pair{Key: "function", Val: text("random")}, value.Pair{Key: "value", Val: v})
		return 0, &e
	}
	return uint64(n), nil
}

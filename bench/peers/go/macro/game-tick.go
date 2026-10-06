package macro

type actor struct{ x, y, vx, vy int64 }

func tick(a actor) actor { a.x += a.vx; a.y += a.vy; return a }

func GameTick(n int64) any {
	state := actor{vx: 1, vy: 2}
	for i := int64(0); i < n; i++ {
		state = tick(state)
	}
	return state.x + state.y
}

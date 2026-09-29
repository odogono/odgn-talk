// A throwaway wasip1 reactor that checks what a Go Core can and can't do
// across wasmexport/wasmimport for #73. Build: see run.sh.
package main

import (
	"runtime"
	"unsafe"
)

func main() {}

// ---- host imports -----------------------------------------------------------

//go:wasmimport host op
func hostOp(x int32) int32

//go:wasmimport host reenter
func hostReenter(x int32) int32

//go:wasmimport host emit
func hostEmit(ptr unsafe.Pointer, n int32)

// ---- 1. an export that blocks with nothing else runnable ---------------------

//go:wasmexport block_chan
func blockChan() int32 {
	ch := make(chan int32)
	return <-ch // no sender: the whole instance has nothing to run
}

// ---- 2. goroutines between exports ------------------------------------------

var ticks int32

//go:wasmexport spawn
func spawn() {
	go func() {
		for {
			ticks++
			runtime.Gosched()
		}
	}()
}

//go:wasmexport ticks_now
func ticksNow() int32 { return ticks }

// ---- 3. an export that yields to the scheduler but terminates -------------

//go:wasmexport yield_some
func yieldSome(n int32) int32 {
	for i := int32(0); i < n; i++ {
		runtime.Gosched()
	}
	return ticks
}

// ---- 4. a synchronous import (an immediate Operation) and reentry ----------

//go:wasmexport call_op
func callOp(x int32) int32 { return hostOp(x) + 1 }

//go:wasmexport call_reenter
func callReenter(x int32) int32 { return hostReenter(x) }

//go:wasmexport inner
func inner(x int32) int32 { return x * 10 }

// ---- 5. a goroutine-per-Run parked across exports --------------------------

var answers = make(chan int32, 1)
var runState int32 // 0 idle, 1 parked, 2 done
var runResult int32

//go:wasmexport start_goroutine_run
func startGoroutineRun() int32 {
	go func() {
		runState = 1
		v := <-answers // parks the Run goroutine, not the export's
		runResult = v * 2
		runState = 2
	}()
	for runState == 0 { // let it reach its park
		runtime.Gosched()
	}
	return runState
}

//go:wasmexport answer_goroutine_run
func answerGoroutineRun(v int32) int32 {
	answers <- v
	for runState == 1 {
		runtime.Gosched()
	}
	return runResult
}

// ---- 6. the plain-data design: Pump parks a Run as data ---------------------

// A Run is a program counter plus locals. "ask ... and wait" at pc 1 parks it
// and Pump reports the pending call; Answer queues a Host Input; the next Pump
// drains the queue and resumes. No goroutine ever blocks.
type run struct {
	pc      int
	acc     int32
	pending int32 // call id, 0 if none
}

var (
	r      run
	inputs []int32 // queued answers: [callID, value]
	nextID int32
)

//go:wasmexport deliver
func deliver(x int32) { r = run{pc: 0, acc: x} }

// pump returns the pending call id, or -result when the Run completed.
//
//go:wasmexport pump
func pump() int32 {
	for len(inputs) >= 2 { // drain the input queue
		id, v := inputs[0], inputs[1]
		inputs = inputs[2:]
		if id == r.pending {
			r.acc += v
			r.pending = 0
			r.pc++
		}
	}
	for {
		switch r.pc {
		case 0: // ask cap to fetch acc and wait
			if r.pending == 0 {
				nextID++
				r.pending = nextID
				msg := []byte(`{"call":"r1.c1","op":"fetch"}`)
				hostEmit(unsafe.Pointer(&msg[0]), int32(len(msg)))
			}
			return r.pending // Quiescent: parked as data
		case 1:
			return -r.acc
		}
	}
}

//go:wasmexport answer
func answer(id, v int32) { inputs = append(inputs, id, v) }

// ---- 7. bytes in and out through linear memory -----------------------------

var inbuf []byte

//go:wasmexport alloc
func alloc(n int32) unsafe.Pointer {
	inbuf = make([]byte, n) // kept reachable until the next alloc
	return unsafe.Pointer(&inbuf[0])
}

// echo_len reads the frame the Host wrote and returns (ptr<<32 | len) of a reply.
var outbuf []byte

//go:wasmexport frame
func frame(n int32) uint64 {
	outbuf = append(outbuf[:0], `{"ok":`...)
	outbuf = append(outbuf, inbuf[:n]...)
	outbuf = append(outbuf, '}')
	return uint64(uintptr(unsafe.Pointer(&outbuf[0])))<<32 | uint64(len(outbuf))
}

// ---- 8. a long export, for the Host's call timeout -------------------------

//go:wasmexport spin
func spin() int32 {
	for {
		ticks++
	}
}

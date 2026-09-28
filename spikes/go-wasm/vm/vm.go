// Package vm is a throwaway, fuel-metered stack bytecode VM, sized like the
// inner loop of a real interpreter. It exists only to measure Go→WASM.
package vm

import (
	"errors"
	"strconv"
)

type Op uint8

const (
	PUSH Op = iota // A = constant index
	LOAD           // A = local
	STORE          // A = local
	ADD
	SUB
	DIV
	MOD
	LT
	GE
	JMP    // A = target
	JZ     // A = target
	CALL   // A = function, B = nargs
	RET
	ITOS   // int -> string
	CONCAT // string ++ string
	NEWLIST
	APPEND // list, v -> list
	LEN
	INDEX // list, i -> v (panics when out of range)
	NEWMAP
	MGET // map, key, default -> v
	MSET // map, key, v -> map
	POP
)

type Kind uint8

const (
	Int Kind = iota
	Str
	List
	Map
)

// Value is a tagged struct, so integer work never boxes.
type Value struct {
	K Kind
	N int64
	S string
	L *[]Value
	M map[string]Value
}

type Instr struct {
	Op   Op
	A, B int32
}

type Func struct {
	Code    []Instr
	NLocals int
}

type Program struct {
	Funcs  []Func
	Consts []Value
}

type frame struct {
	fn     *Func
	pc     int
	base   int // index of local 0 on the stack
	retTop int
}

var ErrFuel = errors.New("fuel exhausted")
var ErrDepth = errors.New("call depth exceeded")

const maxDepth = 10000

// Run calls function 0 with args, charging one Fuel per instruction.
func (p *Program) Run(args []Value, fuel int64) (Value, int64, error) {
	stack := make([]Value, 0, 1024)
	frames := make([]frame, 0, 64) // heap-allocated frames, not the Go stack
	f0 := &p.Funcs[0]
	stack = append(stack, args...)
	for len(stack) < f0.NLocals {
		stack = append(stack, Value{})
	}
	frames = append(frames, frame{fn: f0, base: 0, retTop: 0})
	fr := &frames[0]
	for {
		if fuel--; fuel < 0 {
			return Value{}, fuel, ErrFuel
		}
		in := fr.fn.Code[fr.pc]
		fr.pc++
		switch in.Op {
		case PUSH:
			stack = append(stack, p.Consts[in.A])
		case LOAD:
			stack = append(stack, stack[fr.base+int(in.A)])
		case STORE:
			stack[fr.base+int(in.A)] = stack[len(stack)-1]
			stack = stack[:len(stack)-1]
		case ADD, SUB, DIV, MOD, LT, GE:
			b := stack[len(stack)-1].N
			a := &stack[len(stack)-2]
			stack = stack[:len(stack)-1]
			switch in.Op {
			case ADD:
				a.N += b
			case SUB:
				a.N -= b
			case DIV:
				a.N /= b // integer divide by zero panics, on purpose
			case MOD:
				a.N %= b
			case LT:
				a.N = b2i(a.N < b)
			case GE:
				a.N = b2i(a.N >= b)
			}
		case JMP:
			fr.pc = int(in.A)
		case JZ:
			v := stack[len(stack)-1].N
			stack = stack[:len(stack)-1]
			if v == 0 {
				fr.pc = int(in.A)
			}
		case CALL:
			if len(frames) >= maxDepth {
				return Value{}, fuel, ErrDepth
			}
			fn := &p.Funcs[in.A]
			base := len(stack) - int(in.B)
			for len(stack) < base+fn.NLocals {
				stack = append(stack, Value{})
			}
			frames = append(frames, frame{fn: fn, base: base, retTop: base})
			fr = &frames[len(frames)-1]
		case RET:
			v := stack[len(stack)-1]
			stack = append(stack[:fr.retTop], v)
			frames = frames[:len(frames)-1]
			if len(frames) == 0 {
				return v, fuel, nil
			}
			fr = &frames[len(frames)-1]
		case ITOS:
			t := &stack[len(stack)-1]
			*t = Value{K: Str, S: strconv.FormatInt(t.N, 10)}
		case CONCAT:
			b := stack[len(stack)-1].S
			stack = stack[:len(stack)-1]
			t := &stack[len(stack)-1]
			t.S = t.S + b
		case NEWLIST:
			l := make([]Value, 0)
			stack = append(stack, Value{K: List, L: &l})
		case APPEND:
			v := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			l := stack[len(stack)-1].L
			*l = append(*l, v)
		case LEN:
			t := &stack[len(stack)-1]
			switch t.K {
			case List:
				*t = Value{N: int64(len(*t.L))}
			case Map:
				*t = Value{N: int64(len(t.M))}
			default:
				*t = Value{N: int64(len(t.S))}
			}
		case INDEX:
			i := stack[len(stack)-1].N
			stack = stack[:len(stack)-1]
			t := &stack[len(stack)-1]
			*t = (*t.L)[i] // out of range panics, on purpose
		case NEWMAP:
			stack = append(stack, Value{K: Map, M: map[string]Value{}})
		case MGET:
			d := stack[len(stack)-1]
			k := stack[len(stack)-2].S
			stack = stack[:len(stack)-2]
			t := &stack[len(stack)-1]
			if v, ok := t.M[k]; ok {
				*t = v
			} else {
				*t = d
			}
		case MSET:
			v := stack[len(stack)-1]
			k := stack[len(stack)-2].S
			stack = stack[:len(stack)-2]
			stack[len(stack)-1].M[k] = v
		case POP:
			stack = stack[:len(stack)-1]
		}
	}
}

func b2i(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func I(n int64) Value  { return Value{N: n} }
func S(s string) Value { return Value{K: Str, S: s} }

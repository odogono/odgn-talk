package vm

import (
	"strconv"
	"strings"
)

// asm assembles one function. Lines are "OP [arg [arg]]" or "label:".
// PUSHI n / PUSHS s intern a constant; jump targets may be labels.
func asm(p *Program, nlocals int, src string) {
	ops := map[string]Op{"LOAD": LOAD, "STORE": STORE, "ADD": ADD, "SUB": SUB,
		"DIV": DIV, "MOD": MOD, "LT": LT, "GE": GE, "JMP": JMP, "JZ": JZ,
		"CALL": CALL, "RET": RET, "ITOS": ITOS, "CONCAT": CONCAT,
		"NEWLIST": NEWLIST, "APPEND": APPEND, "LEN": LEN, "INDEX": INDEX,
		"NEWMAP": NEWMAP, "MGET": MGET, "MSET": MSET, "POP": POP}
	var lines [][]string
	labels := map[string]int32{}
	for _, l := range strings.Split(src, ";") {
		f := strings.Fields(l)
		if len(f) == 0 {
			continue
		}
		if strings.HasSuffix(f[0], ":") {
			labels[strings.TrimSuffix(f[0], ":")] = int32(len(lines))
			f = f[1:]
			if len(f) == 0 {
				continue
			}
		}
		lines = append(lines, f)
	}
	arg := func(s string) int32 {
		if n, ok := labels[s]; ok {
			return n
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			panic("asm: bad arg " + s)
		}
		return int32(n)
	}
	var code []Instr
	for _, f := range lines {
		var in Instr
		switch f[0] {
		case "PUSHI":
			n, _ := strconv.ParseInt(f[1], 10, 64)
			p.Consts = append(p.Consts, I(n))
			in = Instr{Op: PUSH, A: int32(len(p.Consts) - 1)}
		case "PUSHS":
			p.Consts = append(p.Consts, S(f[1]))
			in = Instr{Op: PUSH, A: int32(len(p.Consts) - 1)}
		default:
			op, ok := ops[f[0]]
			if !ok {
				panic("asm: bad op " + f[0])
			}
			in.Op = op
			if len(f) > 1 {
				in.A = arg(f[1])
			}
			if len(f) > 2 {
				in.B = arg(f[2])
			}
		}
		code = append(code, in)
	}
	p.Funcs = append(p.Funcs, Func{Code: code, NLocals: nlocals})
}

func program(nlocals int, src string) *Program {
	p := &Program{}
	asm(p, nlocals, src)
	return p
}

// Fib is recursive fib(n): call-heavy dispatch.
var Fib = program(1, `
	LOAD 0; PUSHI 2; LT; JZ rec; LOAD 0; RET;
	rec: LOAD 0; PUSHI 1; SUB; CALL 0 1;
	     LOAD 0; PUSHI 2; SUB; CALL 0 1; ADD; RET`)

// Loop sums 0..n-1: tight dispatch, no allocation. locals: n i s
var Loop = program(3, `
	PUSHI 0; STORE 1; PUSHI 0; STORE 2;
	top: LOAD 1; LOAD 0; LT; JZ end;
	     LOAD 2; LOAD 1; ADD; STORE 2;
	     LOAD 1; PUSHI 1; ADD; STORE 1; JMP top;
	end: LOAD 2; RET`)

// Strings appends "item-<i>" to a list, dropping the list every 1000
// items: allocation and GC pressure. locals: n i total list
var Strings = program(4, `
	PUSHI 0; STORE 1; PUSHI 0; STORE 2; NEWLIST; STORE 3;
	top: LOAD 1; LOAD 0; LT; JZ end;
	     LOAD 3; PUSHS item-; LOAD 1; ITOS; CONCAT; APPEND; POP;
	     LOAD 3; LEN; PUSHI 1000; GE; JZ next;
	     LOAD 2; PUSHI 1000; ADD; STORE 2; NEWLIST; STORE 3;
	next: LOAD 1; PUSHI 1; ADD; STORE 1; JMP top;
	end: LOAD 2; LOAD 3; LEN; ADD; RET`)

// Maps does m["k" ++ (i mod 5000)] += i: string hashing and map churn.
// locals: n i m k
var Maps = program(4, `
	PUSHI 0; STORE 1; NEWMAP; STORE 2;
	top: LOAD 1; LOAD 0; LT; JZ end;
	     PUSHS k; LOAD 1; PUSHI 5000; MOD; ITOS; CONCAT; STORE 3;
	     LOAD 2; LOAD 3; LOAD 2; LOAD 3; PUSHI 0; MGET; LOAD 1; ADD; MSET; POP;
	     LOAD 1; PUSHI 1; ADD; STORE 1; JMP top;
	end: LOAD 2; LEN; RET`)

// DivZero and IndexOOR panic inside the VM's Go code.
var DivZero = program(0, `PUSHI 1; PUSHI 0; DIV; RET`)
var IndexOOR = program(0, `NEWLIST; PUSHI 5; INDEX; RET`)

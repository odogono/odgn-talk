//go:build starlark

package core

import (
	"go.starlark.net/starlark"
	"go.starlark.net/syntax"
)

const starSrc = `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

def loop(n):
    s = 0
    for i in range(n):
        s += i
    return s

def strs(n):
    total = 0
    l = []
    for i in range(n):
        l.append("item-" + str(i))
        if len(l) >= 1000:
            total += len(l)
            l = []
    return total + len(l)

def maps(n):
    m = {}
    for i in range(n):
        k = "k" + str(i % 5000)
        m[k] = m.get(k, 0) + i
    return len(m)
`

var starFuncs = []string{"fib", "loop", "strs", "maps"}
var globals starlark.StringDict

// StarBench runs the Starlark twin of Bench's program kind on n.
func StarBench(kind, n int32) int64 {
	if globals == nil {
		opts := &syntax.FileOptions{Recursion: true}
		g, err := starlark.ExecFileOptions(opts, &starlark.Thread{}, "bench.star", starSrc, nil)
		if err != nil {
			return -2
		}
		globals = g
	}
	th := &starlark.Thread{}
	th.SetMaxExecutionSteps(1 << 50)
	v, err := starlark.Call(th, globals[starFuncs[kind]], starlark.Tuple{starlark.MakeInt(int(n))}, nil)
	if err != nil {
		return -1
	}
	var i int64
	if err := starlark.AsInt(v, &i); err != nil {
		return -4
	}
	return i
}

const HasStarlark = true

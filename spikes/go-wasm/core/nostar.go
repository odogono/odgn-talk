//go:build !starlark

package core

func StarBench(kind, n int32) int64 { return -3 }

const HasStarlark = false

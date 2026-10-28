package northtalk

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"io"
	"strconv"
	"testing"
)

// rewriteSaveVersions rewrites a Zig save's version header and re-signs it.
func rewriteSaveVersions(t *testing.T, saved []byte, versions Versions) []byte {
	t.Helper()
	z := parseZigSave(t, saved)
	if versions.Language != "" {
		z.language = []byte(versions.Language)
	}
	if versions.CostModel != "" {
		var err error
		z.costModel, err = strconv.ParseUint(versions.CostModel, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
	}
	return z.encode()
}

// zigSave is a save in the save format (spec/data/save-format.toml) that
// snapshot.zig writes: NTSV, format, language, Cost Model, Group
// Fingerprint, save id counter, State Fingerprint, body digest, then the
// section count and each section's frame.
type zigSave struct {
	magic     []byte
	format    uint64
	language  []byte
	costModel uint64
	// The Group Fingerprint and the save id counter, as written.
	counters []byte
	state    []byte
	sections []byte
}

func parseZigSave(t *testing.T, saved []byte) zigSave {
	t.Helper()
	if len(saved) < 4 || string(saved[:4]) != "NTSV" {
		t.Fatal("expected a Zig save")
	}
	r := bytes.NewReader(saved[4:])
	readInt := func() uint64 {
		t.Helper()
		n, err := binary.ReadUvarint(r)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	read := func(n int) []byte {
		t.Helper()
		out := make([]byte, n)
		if _, err := io.ReadFull(r, out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	z := zigSave{magic: []byte("NTSV")}
	z.format = readInt()
	z.language = read(int(readInt()))
	z.costModel = readInt()
	print := read(sha256.Size)
	z.counters = binary.AppendUvarint(print, readInt())
	z.state = read(sha256.Size)
	read(sha256.Size)
	z.sections = read(r.Len())
	return z
}

// encode writes the save with its body digest made good again, over each
// section frame that still parses.
func (z zigSave) encode() []byte {
	out := append([]byte(nil), z.magic...)
	out = binary.AppendUvarint(out, z.format)
	out = binary.AppendUvarint(out, uint64(len(z.language)))
	out = append(out, z.language...)
	out = binary.AppendUvarint(out, z.costModel)
	out = append(out, z.counters...)
	out = append(out, z.state...)
	h := sha256.New()
	h.Write(out)
	r := bytes.NewReader(z.sections)
	if n, err := binary.ReadUvarint(r); err == nil {
		for range n {
			frame := make([]byte, 2)
			if _, err := io.ReadFull(r, frame); err != nil {
				break
			}
			length, err := binary.ReadUvarint(r)
			if err != nil {
				break
			}
			digest := make([]byte, sha256.Size)
			if _, err := io.ReadFull(r, digest); err != nil {
				break
			}
			h.Write(frame)
			h.Write(digest)
			if _, err := r.Seek(int64(length), io.SeekCurrent); err != nil {
				break
			}
		}
	}
	out = h.Sum(out)
	return append(out, z.sections...)
}

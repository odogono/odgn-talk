package northtalk

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"io"
	"strconv"
	"testing"
)

// Only the version header is shared by these tests. The payload layout belongs
// to each Core (ADR 0008); native-layout mutations still use rewriteSave.
func rewriteSaveVersions(t *testing.T, saved []byte, versions Versions) []byte {
	t.Helper()
	if experimentalGroupFactory == nil {
		return rewriteSave(t, saved, func(data map[string]any) {
			v := data["Versions"].(map[string]any)
			if versions.Language != "" {
				v["Language"] = versions.Language
			}
			if versions.CostModel != "" {
				v["CostModel"] = versions.CostModel
			}
		})
	}
	payload := zigSavePayload(t, saved)
	r := bytes.NewReader(payload[4:])
	readInt := func() uint64 {
		t.Helper()
		n, err := binary.ReadUvarint(r)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	format := readInt()
	language := make([]byte, readInt())
	if _, err := io.ReadFull(r, language); err != nil {
		t.Fatal(err)
	}
	costModel := readInt()
	if versions.Language != "" {
		language = []byte(versions.Language)
	}
	if versions.CostModel != "" {
		var err error
		costModel, err = strconv.ParseUint(versions.CostModel, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
	}
	out := append([]byte(nil), saved[:4]...)
	out = binary.AppendUvarint(out, format)
	out = binary.AppendUvarint(out, uint64(len(language)))
	out = append(out, language...)
	out = binary.AppendUvarint(out, costModel)
	out = append(out, payload[len(payload)-r.Len():]...)
	return signZigSave(out)
}

// snapshot.zig: NTZS, format (ULEB128), language (length + UTF-8),
// Cost Model (ULEB128), state, then SHA-256 of all preceding bytes.
// zigSavePayload returns everything before the digest.
func zigSavePayload(t *testing.T, saved []byte) []byte {
	t.Helper()
	if len(saved) < 4+sha256.Size || string(saved[:4]) != "NTZS" {
		t.Fatal("expected a Zig save")
	}
	return saved[:len(saved)-sha256.Size]
}

// signZigSave appends the digest to a copy of payload.
func signZigSave(payload []byte) []byte {
	digest := sha256.Sum256(payload)
	return append(bytes.Clone(payload), digest[:]...)
}

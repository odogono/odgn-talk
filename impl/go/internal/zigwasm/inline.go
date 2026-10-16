package zigwasm

import (
	"encoding/binary"
	"fmt"
	"io"
)

// inlineIO carries optional inline-inputs-v1 events over WASI stdio. The guest
// stays on its original stack while the Host supplies admission frames.
// Only the export goroutine accesses this state.
type inlineIO struct {
	event   func([]byte) ([]byte, error)
	written []byte
	read    []byte
	err     error
}

func (s *inlineIO) Write(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	s.written = append(s.written, p...)
	for len(s.written) >= 4 {
		n := int(binary.BigEndian.Uint32(s.written))
		if n > 64<<20 {
			s.err = fmt.Errorf("inline event exceeds 64 MiB")
			return 0, s.err
		}
		if len(s.written) < 4+n {
			break
		}
		reply, err := s.event(s.written[4 : 4+n])
		if err != nil {
			s.err = err
			return 0, err
		}
		if len(reply) == 0 || len(reply) > 64<<20 {
			s.err = fmt.Errorf("inline response length %d outside 1..64 MiB", len(reply))
			return 0, s.err
		}
		s.written = s.written[4+n:]
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], uint32(len(reply)))
		s.read = append(s.read, header[:]...)
		s.read = append(s.read, reply...)
	}
	return len(p), nil
}
func (s *inlineIO) Read(p []byte) (int, error) {
	if len(s.read) == 0 {
		return 0, io.EOF
	}
	n := copy(p, s.read)
	s.read = s.read[n:]
	return n, nil
}

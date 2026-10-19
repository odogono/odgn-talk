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
	chunked bool
	message []byte
}

func (s *inlineIO) Write(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	s.written = append(s.written, p...)
	for len(s.written) >= 4 {
		header, more := splitHeader(binary.BigEndian.Uint32(s.written), s.chunked)
		n := int(header)
		if n == 0 || n > maxFrame {
			s.err = fmt.Errorf("inline event exceeds 64 MiB")
			return 0, s.err
		}
		if len(s.written) < 4+n {
			break
		}
		part := s.written[4 : 4+n]
		if len(s.message) > maxMessage-n {
			s.err = fmt.Errorf("inline message exceeds 2 GiB")
			return 0, s.err
		}
		data := part
		if more || len(s.message) != 0 {
			s.message = append(s.message, part...)
			data = s.message
		}
		if more {
			s.written = s.written[4+n:]
			continue
		}
		reply, err := s.event(data)
		s.message = nil
		if err != nil {
			s.err = err
			return 0, err
		}
		limit := messageLimit(s.chunked)
		if len(reply) == 0 || len(reply) > limit {
			s.err = fmt.Errorf("inline response length %d outside 1..%d bytes", len(reply), limit)
			return 0, s.err
		}
		s.written = s.written[4+n:]
		if len(s.written) == 0 {
			s.written = s.written[:0:cap(s.written)]
		}
		for at := 0; at < len(reply); {
			n := min(maxFrame, len(reply)-at)
			s.read = binary.BigEndian.AppendUint32(s.read, chunkHeader(n, at+n < len(reply)))
			s.read = append(s.read, reply[at:at+n]...)
			at += n
		}
	}
	return len(p), nil
}
func (s *inlineIO) Read(p []byte) (int, error) {
	if len(s.read) == 0 {
		return 0, io.EOF
	}
	n := copy(p, s.read)
	s.read = s.read[n:]
	if len(s.read) == 0 {
		s.read = nil
	}
	return n, nil
}

package messagelayer

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// MaxFrame bounds one sidecar frame, so a corrupt length can't make the
// sidecar allocate without limit.
const MaxFrame = 64 << 20

type oversizedFrame struct{ size uint32 }

func (e *oversizedFrame) Error() string {
	return fmt.Sprintf("frame of %d bytes is over %d", e.size, MaxFrame)
}

// ReadFrame reads one sidecar frame: a 4-byte big-endian length, then the
// JSON. It returns io.EOF only at a clean end between frames. An oversized
// frame is drained without retaining its body, then reported as an error.
func ReadFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, fmt.Errorf("truncated frame header")
		}
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n > MaxFrame {
		if _, err := io.CopyN(io.Discard, r, int64(n)); err != nil {
			return nil, fmt.Errorf("truncated oversized frame: %w", err)
		}
		return nil, &oversizedFrame{n}
	}
	frame := make([]byte, n)
	if _, err := io.ReadFull(r, frame); err != nil {
		return nil, fmt.Errorf("truncated frame: %w", err)
	}
	return frame, nil
}

func WriteFrame(w io.Writer, frame []byte) error {
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(frame)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err := w.Write(frame)
	return err
}

// Serve is the sidecar: it answers each frame read from r with one frame on
// w, until r ends.
func Serve(r io.Reader, w io.Writer) error {
	s := NewSession()
	in := bufio.NewReader(r)
	out := bufio.NewWriter(w)
	for {
		frame, err := ReadFrame(in)
		if err == io.EOF {
			return nil
		}
		var oversized *oversizedFrame
		var reply []byte
		if errors.As(err, &oversized) {
			reply = replyFrame(-1, nil, protocolErrorf("%s", oversized))
		} else if err != nil {
			return err
		} else {
			reply = s.Send(frame)
		}
		if err := WriteFrame(out, reply); err != nil {
			return err
		}
		if err := out.Flush(); err != nil {
			return err
		}
	}
}

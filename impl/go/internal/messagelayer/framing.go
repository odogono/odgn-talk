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

// ReadFrame reads one sidecar frame: a 4-byte big-endian length, then the
// JSON. It returns io.EOF only at a clean end between frames.
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
		return nil, fmt.Errorf("frame of %d bytes is over %d", n, MaxFrame)
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
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := WriteFrame(out, s.Send(frame)); err != nil {
			return err
		}
		if err := out.Flush(); err != nil {
			return err
		}
	}
}

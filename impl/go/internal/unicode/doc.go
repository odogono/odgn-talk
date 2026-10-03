// Package unicode supplies the Core's text primitives using only the pinned,
// generated Unicode tables. Inputs must be valid UTF-8. Segmentation does not
// normalize its input; Host text is normalized separately when constructed.
// Positions and spans in this package are zero-based UTF-8 byte offsets.
package unicode

// Package northtalk implements the NorthTalk Go Core. Its public embedding
// interface follows spec/embedding/talk.go; the Spec and Conformance Corpus
// define its behavior. The Core provides immutable values and codecs, Script
// execution, Libraries, Capabilities, messaging, save/restore and canonical
// Trace records. Package session supplies the Session Host; package driver
// supplies the REPL, deterministic Session Transcript replay and a Pool that
// pumps many Groups.
package northtalk

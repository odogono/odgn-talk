package northtalk

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// hostCommandTill defines `till` with an immediate `price` and a
// fire-and-forget `note`, each a Host Command when command is set.
func hostCommandTill(t *testing.T, c *Core, command bool, seen *[]string) *CapabilityDef {
	t.Helper()
	def, err := c.DefineCapability("till",
		Operation{Name: "price", Mode: Immediate, Args: []Shape{TextShape}, Result: NumberShape, Command: command, Do: func(_ *Call, args []Value) (Value, error) {
			*seen = append(*seen, "price "+args[0].String())
			return Int(2), nil
		}},
		Operation{Name: "note", Mode: FireAndForget, Args: []Shape{AnyShape}, Command: command, Fire: func(_ *Call, args []Value) error {
			*seen = append(*seen, "note "+args[0].String())
			return nil
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	return def
}

const hostCommandSource = "on go\n price \"tea\"\n note it\n return it\nend go"

func runHostCommands(t *testing.T, g *Group, s *Script) Value {
	t.Helper()
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, e := p.Result()
	if e != nil {
		t.Fatal(e)
	}
	return v
}

// A Host Command is the `ask` or `tell` its mode allows (ADR 0094). The same
// source compiled against Grants without `command` sends up its Message Path
// instead, so the compile cache keeps the two apart.
func TestHostCommandsCallTheirOperations(t *testing.T) {
	c := New()
	var seen []string
	commands := hostCommandTill(t, c, true, &seen)
	g := c.NewGroup(GroupOptions{Name: "g"})
	s, err := g.Load(LoadOptions{Name: "s", Source: hostCommandSource, Grants: map[string]*Grant{"till": commands.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if v := runHostCommands(t, g, s); !v.Equal(Int(2)) || strings.Join(seen, ",") != `price "tea",note 2` {
		t.Fatalf("%v %v", v, seen)
	}

	seen = nil
	g = c.NewGroup(GroupOptions{Name: "g"})
	s, err = g.Load(LoadOptions{Name: "s", Source: hostCommandSource, Grants: map[string]*Grant{"till": hostCommandTill(t, c, false, &seen).GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	g.Pump(time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), PumpOptions{})
	// An unhandled send up the Message Path leaves `it` as it was.
	if v, e := p.Result(); e != nil || !v.Equal(Nothing) || len(seen) != 0 {
		t.Fatalf("without command: %v %v %v", v, e, seen)
	}
}

// A Command Call starts with a Name, so a Reserved Word can't be a command.
func TestHostCommandRefusesReservedWord(t *testing.T) {
	c := New()
	do := func(*Call, []Value) (Value, error) { return Nothing, nil }
	_, err := c.DefineCapability("x", Operation{Name: "repeat", Mode: Immediate, Command: true, Do: do})
	var host *HostError
	if !errors.As(err, &host) || host.Code != InvalidValue {
		t.Fatalf("got %v", err)
	}
	if _, err := c.DefineCapability("x", Operation{Name: "repeat", Mode: Immediate, Do: do}); err != nil {
		t.Fatal(err)
	}
}

// `command` is part of the Operation Data: the Fingerprint writes it after
// `segmentBound`, only as true, and restore matching compares it.
func TestHostCommandFlagInFingerprintAndRestore(t *testing.T) {
	var seen []string
	c := New()
	commands := hostCommandTill(t, c, true, &seen)
	plain := hostCommandTill(t, c, false, &seen)
	g := c.NewGroup(GroupOptions{Name: "g"})
	if _, err := g.Load(LoadOptions{Name: "s", Source: hostCommandSource, Grants: map[string]*Grant{"till": commands.GrantAll(nil)}}); err != nil {
		t.Fatal(err)
	}
	if data := string(jsonData(grantData(commands.GrantAll(nil)))); !strings.Contains(data, `"name":"note","mode":"fire-and-forget","args":["any"],"cost":{"fuel":0,"alloc":0},"command":true}`) {
		t.Fatal(data)
	}
	if data := string(jsonData(grantData(plain.GrantAll(nil)))); strings.Contains(data, "command") {
		t.Fatal(data)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = c.Restore(saved, RestoreOptions{Mismatch: RejectMismatch, Grants: func(string, string) *Grant { return plain.GrantAll(nil) }})
	var host *HostError
	if !errors.As(err, &host) || host.Code != SaveMismatch {
		t.Fatalf("restore without command: %v", err)
	}
	restored, _, err := c.Restore(saved, RestoreOptions{Mismatch: RejectMismatch, Grants: func(string, string) *Grant { return commands.GrantAll(nil) }})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Fingerprint() != g.Fingerprint() {
		t.Fatal("restored Fingerprint differs")
	}
	// An unbound restore keeps the saved declarations, `command` included.
	unbound, _, err := c.Restore(saved, RestoreOptions{Mismatch: RejectMismatch})
	if err != nil {
		t.Fatal(err)
	}
	if unbound.Fingerprint() != g.Fingerprint() {
		t.Fatal("unbound restore Fingerprint differs")
	}
}

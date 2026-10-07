package session_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/session"
)

func storeSession(files map[string]string) (*session.Host, *[]session.Item, map[string]string) {
	items := []session.Item{}
	written := map[string]string{}
	host := session.New(session.Environment{
		Now:    func() time.Time { return time.Date(2026, 10, 7, 10, 0, 0, 0, time.UTC) },
		Record: func(i session.Item) { items = append(items, i) },
		ReadStoreFile: func(path string) (string, error) {
			if text, ok := files[path]; ok {
				return text, nil
			}
			return "", fmt.Errorf("missing file")
		},
		WriteStoreFile: func(path, text string) error { written[path] = text; return nil },
	})
	return host, &items, written
}
func input(t *testing.T, h *session.Host, source string, want ...string) {
	t.Helper()
	got := h.Input(source)
	if len(got) != len(want) || len(got) > 0 && !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %q, want %q", source, got, want)
	}
}
func TestSessionStoreBindingsAndLifetime(t *testing.T) {
	h, _, _ := storeSession(nil)
	input(t, h, ":mock store.get immediate", "! bad arguments")
	input(t, h, ":mock db.get immediate")
	input(t, h, ":grant d db named", "! bad arguments")
	input(t, h, ":grant s store")
	input(t, h, ":grant same store default")
	input(t, h, ":grant other store elsewhere")
	input(t, h, "script variable n = 0")
	input(t, h, ":save", "saved default")
	input(t, h, `ask s to increment "plays", 3`)
	input(t, h, "on peek\nask same to get \"plays\"\nsay it\nask other to keys\nsay it\nend peek")
	input(t, h, "peek", "3", "[]")
	input(t, h, ":store", `"plays" = 3`)
	input(t, h, ":store elsewhere")
	// Replacing the Handler reloads the Script; the Host's Store persists.
	input(t, h, "on peek\nask same to increment \"plays\"\nend peek")
	input(t, h, "peek")
	input(t, h, ":restore", "restored default")
	input(t, h, ":store", `"plays" = 4`)
}
func TestSessionStoreFaultRollbackAndErrorCommit(t *testing.T) {
	h, _, _ := storeSession(nil)
	input(t, h, ":grant s store")
	input(t, h, ":limits fuelPerRun 300")
	input(t, h, "on spin\nask s to set \"a\", 1\nrepeat while true\nend repeat\nend spin")
	input(t, h, "on fail\nask s to set \"a\", 1\nthrow \"stop\"\nend fail")
	if out := h.Input("spin"); len(out) != 1 || !strings.HasPrefix(out[0], "! limit fault fuel") {
		t.Fatal(out)
	}
	input(t, h, ":store")
	if out := h.Input("fail"); len(out) != 1 || !strings.HasPrefix(out[0], "! error") {
		t.Fatal(out)
	}
	input(t, h, ":store", `"a" = 1`)
}
func TestSessionStoreFilesAndAtomicRefusals(t *testing.T) {
	h, _, written := storeSession(map[string]string{
		"scores.json": "{\"b\": {\"$quantity\": [\"2.5\", \"km\"]}, \"a\": [1, \"two\"]}\n",
		"array.json":  "[1]", "empty.json": `{ "": 1 }`, "object.json": `{"k":{"$object":["room","r1"]}}`,
		"nothing.json": `{"k":null}`, "duplicate.json": `{"k":1,"k":2}`,
		"unicode.json": `{"\ud800":1}`, "tag.json": `{"$map":7}`, "nested.json": `{"k":{"$map":[["$x",2]]}}`,
	})
	input(t, h, ":store load scores.json", "loaded 2 keys")
	for _, file := range []string{"array.json", "empty.json", "object.json", "missing.json", "duplicate.json", "unicode.json"} {
		input(t, h, ":store load "+file, "! bad arguments")
	}
	input(t, h, ":store", `"a" = [1, "two"]`, `"b" = 2.5 km`)
	input(t, h, ":store save out.json", "wrote out.json")
	if written["out.json"] != `{"a":[1,"two"],"b":{"$quantity":["2.5","km"]}}` {
		t.Fatal(written)
	}
	input(t, h, ":store load nothing.json other", "loaded 0 keys")
	input(t, h, ":store load tag.json tags", "loaded 1 keys")
	input(t, h, ":store tags", `"$map" = 7`)
	input(t, h, ":store load nested.json nested", "loaded 1 keys")
	input(t, h, ":store nested", `"k" = {"$x": 2}`)
	input(t, h, ":store clear", "cleared default")
	input(t, h, ":store")
	for _, source := range []string{":store save", ":store a b", ":store clear a b", ":store load", ":store clear\n{}"} {
		input(t, h, source, "! bad arguments")
	}
}
func TestSessionStoreLoadQuotas(t *testing.T) {
	var pairs []string
	for i := 0; i < 1001; i++ {
		pairs = append(pairs, fmt.Sprintf(`"k%d":1`, i))
	}
	h, _, _ := storeSession(map[string]string{"big.json": "{" + strings.Join(pairs, ",") + "}"})
	input(t, h, ":store load big.json", "! bad arguments")
	input(t, h, ":store")
}
func TestSessionStoreTranscriptParity(t *testing.T) {
	h, items, _ := storeSession(map[string]string{"scores.json": "{\n  \"best\": 9\n}\n"})
	input(t, h, ":grant s store")
	input(t, h, ":store load scores.json", "loaded 1 keys")
	input(t, h, "on best\n  ask s to get \"best\"\n  say it\nend best")
	input(t, h, "best", "9")
	// Same Transcript asserted by the TS Session Host tests.
	expected := "> :grant s store\n> :store load\n| {\n|   \"best\": 9\n| }\nloaded 1 keys\n> on best\n|   ask s to get \"best\"\n|   say it\n| end best\n> best\n@ 2026-10-07T10:00:00Z\n9\n"
	recorded := driver.WriteTranscript(*items)
	if recorded != expected {
		t.Fatalf("got:\n%s\nwant:\n%s", recorded, expected)
	}
	input(t, h, ":store save exported.json", "wrote exported.json")
	recorded = driver.WriteTranscript(*items)
	parsed, err := driver.ParseTranscript(recorded)
	if err != nil {
		t.Fatal(err)
	}
	_, replayed, err := driver.ReplayTranscript(parsed, nil)
	if err != nil {
		t.Fatal(err)
	}
	if driver.WriteTranscript(replayed) != recorded {
		t.Fatal("Replay depends on the source file")
	}
}

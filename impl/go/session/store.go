package session

import (
	"strconv"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/store"
)

func (h *Host) store(rest string) []string {
	head, contents, inline := strings.Cut(rest, "\n")
	words := strings.Fields(head)
	form := ""
	if len(words) > 0 {
		form = words[0]
	}
	if form == "load" {
		if len(words) > 3 || inline && len(words) > 2 || !inline && len(words) < 2 {
			return refusal("bad arguments")
		}
		name := "default"
		if inline {
			if len(words) == 2 {
				name = words[1]
			}
		} else {
			if h.env.ReadStoreFile == nil {
				return refusal("bad arguments")
			}
			var err error
			contents, err = h.env.ReadStoreFile(words[1])
			if err != nil {
				return refusal("bad arguments")
			}
			if len(words) == 3 {
				name = words[2]
			}
			recorded := ":store load"
			if len(words) == 3 {
				recorded += " " + name
			}
			recorded += "\n" + strings.TrimSuffix(contents, "\n")
			h.recording = &recorded
		}
		entries, err := store.DecodeContents(contents)
		if err != nil {
			return refusal("bad arguments")
		}
		if err := h.stores.Replace(name, entries); err != nil {
			return refusal("bad arguments")
		}
		return []string{"loaded " + strconv.Itoa(len(h.stores.Entries(name))) + " keys"}
	}
	if inline {
		return refusal("bad arguments")
	}
	name := "default"
	switch form {
	case "save":
		if len(words) < 2 || len(words) > 3 || h.env.WriteStoreFile == nil {
			return refusal("bad arguments")
		}
		if len(words) == 3 {
			name = words[2]
		}
		encoded, err := store.EncodeContents(h.stores.Entries(name))
		if err != nil {
			return refusal("bad arguments")
		}
		if err := h.env.WriteStoreFile(words[1], encoded); err != nil {
			return refusal("bad arguments")
		}
		return []string{"wrote " + words[1]}
	case "clear":
		if len(words) > 2 {
			return refusal("bad arguments")
		}
		if len(words) == 2 {
			name = words[1]
		}
		if err := h.stores.Clear(name); err != nil {
			return refusal("bad arguments")
		}
		return []string{"cleared " + name}
	default:
		if len(words) > 1 {
			return refusal("bad arguments")
		}
		if form != "" {
			name = form
		}
		var out []string
		for _, p := range h.stores.Entries(name) {
			key, _ := talk.Text(p.Key)
			out = append(out, key.String()+" = "+p.Val.String())
		}
		return out
	}
}

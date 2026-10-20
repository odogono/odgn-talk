package northtalk

import (
	"fmt"

	"github.com/odogono/odgn-talk/impl/go/internal/docs"
)

func init() {
	docs.ScriptUnits = func(value any) ([]docs.UnitSource, error) {
		script, ok := value.(*Script)
		if !ok || script == nil {
			return nil, fmt.Errorf("source units require a Script")
		}
		backend := script.group.backend.(*zigGroup)
		reply, err := backend.send("script-units", map[string]any{"script": script.name})
		if err != nil {
			return nil, err
		}
		var units []docs.UnitSource
		for _, raw := range reply.get("units").items() {
			identity, err := zigBytes(raw.get("identity"))
			if err != nil || len(identity) != 32 {
				return nil, fmt.Errorf("Zig returned an invalid source identity")
			}
			unit := docs.UnitSource{Name: zigText(raw.get("name")), Source: zigText(raw.get("source"))}
			copy(unit.Identity[:], identity)
			units = append(units, unit)
		}
		return units, nil
	}
}

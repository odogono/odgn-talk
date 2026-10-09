package bench

import northtalk "github.com/odogono/odgn-talk/impl/go"

// bindHost installs only the bindings a Host boundary workload needs, and
// the partner Script or Host Objects a messaging workload sends to. The TS
// Host installs the same ones.
func bindHost(core *northtalk.Core, group *northtalk.Group, options *northtalk.LoadOptions, host string) error {
	switch host {
	case "", "restore":
		return nil
	case "partner":
		source, err := readScript("messaging/partner")
		if err != nil {
			return err
		}
		_, err = group.Load(northtalk.LoadOptions{Name: "partner", Source: source, Limits: limits})
		return err
	case "parents":
		// leaf → branch → root, and only root has an Owning Script: the
		// Benchmark's.
		kind, err := core.DefineObjectKind(northtalk.ObjectKindDef{Name: "BenchmarkNode", ParentKinds: []string{"BenchmarkNode"}})
		if err != nil {
			return err
		}
		var chain []*northtalk.Object
		for _, id := range []string{"root", "branch", "leaf"} {
			object, err := group.Object(kind, id, nil)
			if err != nil {
				return err
			}
			if len(chain) > 0 {
				if err = group.SetParent(object, chain[len(chain)-1]); err != nil {
					return err
				}
			}
			chain = append(chain, object)
		}
		options.Owner = chain[0]
		options.Objects = map[string]*northtalk.Object{"leaf": chain[2]}
		return nil
	}
	if host == "properties" {
		kind, err := core.DefineObjectKind(northtalk.ObjectKindDef{
			Name: "BenchmarkMeter",
			Props: []northtalk.Prop{{
				Name: "value", Shape: northtalk.NumberShape,
				GetCost: northtalk.Cost{Fuel: 1},
				Get: func(*northtalk.Object) (northtalk.Value, error) {
					return northtalk.Int(1), nil
				},
			}},
		})
		if err != nil {
			return err
		}
		object, err := group.Object(kind, "meter", nil)
		if err != nil {
			return err
		}
		options.Objects = map[string]*northtalk.Object{"meter": object}
		return nil
	}
	capability, err := core.DefineCapability("BenchmarkHost",
		northtalk.Operation{
			Name: "echo", Mode: northtalk.Immediate,
			Args: []northtalk.Shape{northtalk.NumberShape}, Result: northtalk.NumberShape,
			Cost: northtalk.Cost{Fuel: 1},
			Do: func(_ *northtalk.Call, args []northtalk.Value) (northtalk.Value, error) {
				return args[0], nil
			},
		},
		northtalk.Operation{
			Name: "later", Mode: northtalk.Suspending,
			Args: []northtalk.Shape{northtalk.NumberShape}, Result: northtalk.NumberShape,
			Cost: northtalk.Cost{Fuel: 1},
			Start: func(call *northtalk.Call, args []northtalk.Value) error {
				call.Answer(args[0])
				return nil
			},
		},
		northtalk.Operation{
			Name: "convert", Mode: northtalk.Immediate,
			Args: []northtalk.Shape{northtalk.AnyShape}, Result: northtalk.AnyShape,
			Cost: northtalk.Cost{Fuel: 1},
			Do: func(_ *northtalk.Call, args []northtalk.Value) (northtalk.Value, error) {
				encoded, err := northtalk.EncodeJSON(args[0])
				if err != nil {
					return northtalk.Nothing, err
				}
				return northtalk.DecodeJSON(encoded)
			},
		},
	)
	if err != nil {
		return err
	}
	options.Grants = map[string]*northtalk.Grant{"host": capability.GrantAll(nil)}
	return nil
}

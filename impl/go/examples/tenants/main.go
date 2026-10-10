// Command tenants is the multi-tenant Go Example Host (spec Appendix B,
// milestone 2): an HTTP server that gives each tenant its own Group, pumped
// in parallel by the driver Pool. It is an embedding example, not a product.
//
//	go run ./examples/tenants serve [-addr :8080]
//	go run ./examples/tenants record [dir]
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	talk "github.com/odogono/odgn-talk/impl/go"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ExitOnError)
		addr := fs.String("addr", "127.0.0.1:8080", "listen address")
		_ = fs.Parse(os.Args[2:])
		if err := serve(*addr); err != nil {
			log.Fatal(err)
		}
	case "record":
		dir := "../../corpus/examples"
		if len(os.Args) > 2 {
			dir = os.Args[2]
		}
		if err := record(dir); err != nil {
			log.Fatal(err)
		}
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: tenants serve [-addr host:port] | tenants record [dir]")
	os.Exit(2)
}

func serve(addr string) error {
	h, err := NewHost(HostOptions{FuelSlice: 10000, OnRunEnd: func(tenant string, end *talk.RunEnd) {
		log.Printf("%s: run %s %s outcome=%s fuel=%d", tenant, end.Run, end.Handler, outcomes[end.Outcome], end.Fuel)
	}})
	if err != nil {
		return err
	}
	defer h.Close()
	for _, d := range demoTenants {
		if _, err := h.AddTenant(d.name, d.plan, d.catalog, d.sender, script("shop.talk")); err != nil {
			return err
		}
	}
	log.Printf("tenants listening on http://%s", addr)
	return http.ListenAndServe(addr, h.handler())
}

// handler routes the tenant and admin endpoints. Bodies and results cross as
// JSON, through the Core's JSON conversion.
func (h *Host) handler() http.Handler {
	mux := http.NewServeMux()
	tenant := func(f func(w http.ResponseWriter, r *http.Request, t *Tenant)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			t, ok := h.Tenant(r.PathValue("tenant"))
			if !ok {
				http.Error(w, "unknown tenant", http.StatusNotFound)
				return
			}
			f(w, r, t)
		}
	}
	mux.HandleFunc("POST /tenants/{tenant}/orders", tenant(func(w http.ResponseWriter, r *http.Request, t *Tenant) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		o, err := talk.DecodeJSON(body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		v, err := h.Order(r.Context(), t, o)
		if err != nil {
			var failure *talk.ScriptError
			if errors.As(err, &failure) {
				// A failed Run rejects with `send failed`, its reason in Data.
				data, _ := talk.EncodeJSON(failure.Data)
				writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"code": failure.Code, "data": json.RawMessage(data)})
				return
			}
			if errors.Is(err, talk.ErrMailboxFull) {
				http.Error(w, "busy", http.StatusTooManyRequests)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// JSON has no Quantities, so a total crosses as its amount and unit.
		if n, unit, ok := v.AsQuantity(); ok {
			writeJSON(w, http.StatusOK, map[string]string{"amount": n.String(), "unit": unit})
			return
		}
		out, err := talk.EncodeJSON(v)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(append(out, '\n'))
	}))
	mux.HandleFunc("POST /tenants/{tenant}/reminders", tenant(func(w http.ResponseWriter, r *http.Request, t *Tenant) {
		var body struct {
			To   []string `json:"to"`
			Note string   `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := h.Remind(t, body.To, body.Note); err != nil {
			http.Error(w, err.Error(), http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	mux.HandleFunc("GET /tenants/{tenant}/outbox", tenant(func(w http.ResponseWriter, r *http.Request, t *Tenant) {
		writeJSON(w, http.StatusOK, h.Outbox(t))
	}))
	mux.HandleFunc("GET /tenants/{tenant}/usage", tenant(func(w http.ResponseWriter, r *http.Request, t *Tenant) {
		c := h.Usage(t)
		writeJSON(w, http.StatusOK, map[string]any{"plan": t.Plan.Name, "fuel": c.FuelTotal, "alloc": c.AllocTotal, "runs": c.Runs, "faults": c.Faults, "state": c.PersistentState})
	}))
	mux.HandleFunc("POST /admin/tenants/{tenant}/revoke/{grant}", tenant(func(w http.ResponseWriter, r *http.Request, t *Tenant) {
		h.Revoke(t, r.PathValue("grant"))
		w.WriteHeader(http.StatusAccepted)
	}))
	mux.HandleFunc("PUT /admin/tenants/{tenant}/script", tenant(func(w http.ResponseWriter, r *http.Request, t *Tenant) {
		source, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := h.Reload(t, string(source)); err != nil {
			var load *talk.LoadError
			if errors.As(err, &load) {
				type diagnostic struct {
					Code string `json:"code"`
					Line int    `json:"line"`
					Col  int    `json:"col"`
				}
				out := []diagnostic{}
				for _, d := range load.Diagnostics {
					out = append(out, diagnostic{d.Code, d.Line, d.Col})
				}
				writeJSON(w, http.StatusUnprocessableEntity, out)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	return mux
}

var outcomes = map[talk.Outcome]string{
	talk.Completed: "completed", talk.Errored: "errored", talk.LimitFault: "limit-fault", talk.Cancelled: "cancelled",
	talk.UnhandledOutcome: "unhandled", talk.Dropped: "dropped", talk.EffectFailureOutcome: "effect-failed",
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

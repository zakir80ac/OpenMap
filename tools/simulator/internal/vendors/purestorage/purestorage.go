// REQ-QA-005 REQ-DISC-014 — simulated Pure Storage FlashArray (REST 2.x): every estate storage_array whose
// manufacturer is Pure Storage gets its own HTTPS listener with api-token login, x-auth-token sessions and
// limit/continuation_token paging on arrays, hardware, controllers, volumes, hosts and connections. Volumes
// are the array's estate LUNs; hosts and connections come from the estate's presented_to relationships.
package purestorage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	apiVersion   = "2.36"
	manufacturer = "Pure Storage"
	wwnPrefix    = "624a9370"
	serialHexLen = 24
	bytesPerGiB  = 1 << 30
	bytesPerTiB  = 1 << 40
	percent      = 100
	defaultLimit = 1000
	// createdMillis is a fixed volume creation instant (2025-01-01T00:00:00Z) so runs are reproducible.
	createdMillis = 1735689600000
)

type Vendor struct{}

func (Vendor) ID() string             { return "pure-flasharray" }
func (Vendor) Collector() string      { return "storage_pure" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-014"} }

func arrays(e *estate.Estate) []*estate.CI {
	return e.OfType("storage_array", func(c *estate.CI) bool { return c.Str("manufacturer") == manufacturer })
}

// volumeSerial is the 24-hex Purity serial: the tail of a Pure-shaped WWN, otherwise derived from the WWN.
func volumeSerial(wwn string) string {
	w := strings.ToLower(strings.TrimPrefix(wwn, "naa."))
	if strings.HasPrefix(w, wwnPrefix) && len(w) == len(wwnPrefix)+serialHexLen {
		return w[len(wwnPrefix):]
	}
	sum := sha256.Sum256([]byte(w))
	return hex.EncodeToString(sum[:])[:serialHexLen]
}

func uuidOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	h := hex.EncodeToString(sum[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

type named struct {
	Name string `json:"name"`
}

type array struct {
	ci    *estate.CI
	luns  []*estate.CI
	hosts map[string]*hostView
	conns []map[string]any
}

type hostView struct {
	name  string
	group string
}

func hostName(h *estate.CI) string {
	if f := h.ID("fqdn"); f != "" {
		return strings.ToLower(f)
	}
	return strings.ToLower(h.Name)
}

func load(e *estate.Estate, a *estate.CI) *array {
	v := &array{ci: a, hosts: map[string]*hostView{}}
	v.luns = e.From(a, "contains")
	sort.SliceStable(v.luns, func(i, j int) bool { return v.luns[i].Name < v.luns[j].Name })
	for _, l := range v.luns {
		for _, h := range e.From(l, "presented_to") {
			name := hostName(h)
			if _, ok := v.hosts[name]; !ok {
				v.hosts[name] = &hostView{name: name, group: l.Str("hostGroup")}
			}
			v.conns = append(v.conns, map[string]any{"host": named{name}, "volume": named{l.Name}, "lun": int(l.Num("lunId", 1))})
		}
	}
	return v
}

func (v *array) docs(path string) []any {
	a := v.ci
	switch path {
	case "/arrays":
		capacity := int64(a.Num("usableTb", 0) * bytesPerTiB)
		used := capacity * int64(a.Num("usedPercent", 0)) / percent
		version := strings.TrimSpace(strings.TrimPrefix(a.Str("firmware"), "Purity//FA"))
		return []any{map[string]any{
			"id": uuidOf(a.ID("serialNumber")), "name": a.Name, "os": "Purity//FA", "version": version, "capacity": capacity,
			"space": map[string]any{"total_physical": used, "data_reduction": a.Num("dataReductionRatio", 1), "unique": used, "snapshots": 0, "shared": 0},
		}}
	case "/hardware":
		return []any{map[string]any{"name": "CH0", "type": "chassis", "serial": a.ID("serialNumber"), "model": a.Str("model"), "status": "ok"}}
	case "/controllers":
		n := int(a.Num("controllers", 2))
		out := make([]any, 0, n)
		version := strings.TrimSpace(strings.TrimPrefix(a.Str("firmware"), "Purity//FA"))
		for i := 0; i < n; i++ {
			mode := "secondary"
			if i == 0 {
				mode = "primary"
			}
			out = append(out, map[string]any{"name": "CT" + strconv.Itoa(i), "model": a.Str("model"), "status": "ready", "mode": mode, "version": version})
		}
		return out
	case "/volumes":
		out := make([]any, 0, len(v.luns))
		for _, l := range v.luns {
			out = append(out, map[string]any{
				"name": l.Name, "serial": strings.ToUpper(volumeSerial(l.Str("wwn"))), "provisioned": int64(l.Num("sizeGb", 0) * bytesPerGiB),
				"created": int64(createdMillis), "destroyed": false,
				"space": map[string]any{"total_physical": int64(l.Num("usedGb", 0) * bytesPerGiB), "unique": int64(l.Num("usedGb", 0) * bytesPerGiB), "snapshots": 0},
			})
		}
		return out
	case "/hosts":
		names := make([]string, 0, len(v.hosts))
		for n := range v.hosts {
			names = append(names, n)
		}
		sort.Strings(names)
		out := make([]any, 0, len(names))
		for _, n := range names {
			h := v.hosts[n]
			personality := "esxi"
			if !strings.HasPrefix(n, "esx") {
				personality = ""
			}
			doc := map[string]any{"name": h.name, "wwns": []string{}, "iqns": []string{}, "nqns": []string{"nqn.2014-08.org.nvmexpress:uuid:" + uuidOf(h.name)}, "personality": personality}
			if h.group != "" {
				doc["host_group"] = named{h.group}
			}
			out = append(out, doc)
		}
		return out
	case "/connections":
		out := make([]any, 0, len(v.conns))
		for _, c := range v.conns {
			out = append(out, c)
		}
		return out
	}
	return nil
}

func (v *array) handler(env *sim.Env) http.Handler {
	prefix := "/api/" + apiVersion
	session := env.Token("pure-" + v.ci.ID("serialNumber"))
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+prefix+"/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("api-token") != env.Secret {
			sim.Unauthorized(w)
			return
		}
		w.Header().Set("x-auth-token", session)
		sim.WriteJSON(w, http.StatusOK, map[string]any{"items": []any{map[string]string{"username": env.User}}})
	})
	mux.HandleFunc("GET "+prefix+"/{collection}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-auth-token") != session {
			sim.Unauthorized(w)
			return
		}
		all := v.docs("/" + r.PathValue("collection"))
		if all == nil {
			sim.NotFound(w)
			return
		}
		limit := defaultLimit
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
			limit = n
		}
		offset, _ := strconv.Atoi(r.URL.Query().Get("continuation_token"))
		if offset > len(all) {
			offset = len(all)
		}
		end := offset + limit
		next := ""
		if end < len(all) {
			next = strconv.Itoa(end)
		} else {
			end = len(all)
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"items": all[offset:end], "continuation_token": next, "total_item_count": len(all)})
	})
	return mux
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	views := map[string]*array{}
	keys := []string{}
	for _, a := range arrays(e) {
		views[a.Name] = load(e, a)
		keys = append(keys, a.Name)
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return views[k].handler(env) })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, a := range arrays(e) {
		v := load(e, a)
		run := sim.Run{
			Name:           a.Name,
			Targets:        []sim.Target{{Kind: "host", Value: ep.Devices[a.Name], Label: a.Name}},
			Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM, "apiVersion": apiVersion},
			CredentialType: "api_token",
			Credential:     &sim.Credential{Type: "api_token", Fields: map[string]string{"token": env.Secret}},
		}
		run.Expect.EstateCI(a)
		for _, l := range v.luns {
			run.Expect.EstateCI(l)
			run.Expect.Rel("contains", "storage_array", a.Name, "lun", l.Name)
		}
		for _, c := range v.conns {
			host, _ := c["host"].(named)
			vol, _ := c["volume"].(named)
			run.Expect.RelToRef("presented_to", "lun", vol.Name, "host", map[string]string{"fqdn": host.Name})
		}
		runs = append(runs, run)
	}
	return runs
}

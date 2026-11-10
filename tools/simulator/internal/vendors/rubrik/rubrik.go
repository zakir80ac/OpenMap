// REQ-QA-005 REQ-INT-017 — simulated Rubrik CDM REST API (ADR-075), rendered from the estate's Rubrik SLA domains: the
// service account session (POST /api/v1/service_account/session), bearer tokens, limit/offset paging with hasMore,
// /v1/cluster/me, /v2/sla_domain with snapshot frequencies and retention that give each domain's RPO and retention,
// /v1/vmware/vcenter, /v1/vmware/vm with every VMware VM of the estate (the ones no domain protects as UNPROTECTED),
// each protected VM's snapshots one RPO apart back from its last good backup, and /v1/fileset with the hosts' filesets.
package rubrik

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/backupsim"
)

const (
	vendor       = "rubrik"
	defaultLimit = 50
	minutesHour  = 60
	minutesDay   = 1440
	hoursPerDay  = 24
	unprotected  = "UNPROTECTED"
	vcenterTag   = "vcsa"
)

type Vendor struct{}

func (Vendor) ID() string             { return "rubrik-cdm" }
func (Vendor) Collector() string      { return "backup" }
func (Vendor) Requirements() []string { return []string{"REQ-INT-017"} }

type object struct {
	cover  backupsim.Cover
	policy *backupsim.Policy
}

type view struct {
	policies []*backupsim.Policy
	host     string
	serverID string
	vms      []*estate.CI
	byVM     map[*estate.CI]object
	filesets []object
}

func load(e *estate.Estate) *view {
	v := &view{policies: backupsim.Policies(e, vendor), byVM: map[*estate.CI]object{}}
	v.host, v.serverID = backupsim.Server(v.policies)
	for _, p := range v.policies {
		for _, c := range p.Covers {
			if c.CI.Type == "vm" {
				v.byVM[c.CI] = object{cover: c, policy: p}
			} else {
				v.filesets = append(v.filesets, object{cover: c, policy: p})
			}
		}
	}
	v.vms = e.OfType("vm", func(c *estate.CI) bool { return c.Str("platform") == "vmware" })
	return v
}

func vcenterID(vm *estate.CI) string {
	return "vCenter:::" + strings.ToLower(nonEmpty(vm.Str("site"), "dc"))
}
func vcenterHost(vm *estate.CI) string {
	return vcenterTag + "-" + strings.ToLower(nonEmpty(vm.Str("site"), "dc")) + ".sim"
}

func moidOf(vm *estate.CI) string {
	sum := 0
	for _, r := range vm.ID("instanceUuid") + vm.Name {
		sum = (sum*31 + int(r)) % 1_000_000
	}
	return "vm-" + strconv.Itoa(sum)
}

func nonEmpty(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func frequencies(rpo, days int) map[string]any {
	out := map[string]any{}
	if rpo > 0 && rpo < minutesDay {
		out["hourly"] = map[string]any{"frequency": rpo / minutesHour, "retention": hoursPerDay}
	}
	out["daily"] = map[string]any{"frequency": 1, "retention": days}
	return out
}

func snapshots(o object, prefix string) []any {
	out := []any{}
	newest, ok := backupsim.Time(o.cover.Attrs, "lastGoodBackupAt")
	if !ok {
		return out
	}
	step := time.Duration(nonZero(backupsim.Int(o.policy.CI.Attributes, "rpoMinutes"), minutesDay)) * time.Minute
	for i := 0; i < backupsim.Int(o.cover.Attrs, "restorePoints"); i++ {
		out = append(out, map[string]any{"id": prefix + "-snap-" + strconv.Itoa(i), "date": newest.Add(-time.Duration(i) * step).Format("2006-01-02T15:04:05.000Z"), "isOnDemandSnapshot": false, "cloudState": 0})
	}
	return out
}

func nonZero(v, fallback int) int {
	if v == 0 {
		return fallback
	}
	return v
}

func filesetID(i int) string { return "Fileset:::" + strconv.Itoa(i+1) }

func (v *view) handler(env *sim.Env) http.Handler {
	token := env.Token(vendor)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/service_account/session", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["serviceAccountId"] != env.User || body["secret"] != env.Secret {
			sim.WriteJSON(w, http.StatusUnauthorized, map[string]any{"errorType": "user_error", "message": "Incorrect service account credentials", "provenance": sim.Provenance})
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"token": token, "sessionId": "sim-session", "expirationTime": time.Now().UTC().Add(time.Hour).Format(time.RFC3339)})
	})
	guard := func(next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !sim.BearerOK(r, token) {
				sim.Unauthorized(w)
				return
			}
			next(w, r)
		}
	}
	page := func(w http.ResponseWriter, r *http.Request, items []any) {
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil || limit <= 0 || limit > defaultLimit {
			// Rubrik caps a page; a smaller page than asked for proves the collector follows hasMore.
			limit = defaultLimit
		}
		data, more := backupsim.Page(items, offset, limit)
		sim.WriteJSON(w, http.StatusOK, map[string]any{"data": data, "hasMore": more, "total": len(items)})
	}
	vmByID := map[string]*estate.CI{}
	for _, vm := range v.vms {
		vmByID["VirtualMachine:::"+vm.ID("instanceUuid")] = vm
	}
	mux.HandleFunc("GET /api/v1/cluster/me", guard(func(w http.ResponseWriter, _ *http.Request) {
		sim.WriteJSON(w, http.StatusOK, map[string]any{"id": v.serverID, "name": v.host, "version": "9.1.2-p1", "provenance": sim.Provenance})
	}))
	mux.HandleFunc("GET /api/v2/sla_domain", guard(func(w http.ResponseWriter, r *http.Request) {
		out := []any{}
		for _, p := range v.policies {
			a := p.CI.Attributes
			out = append(out, map[string]any{"id": p.CI.ID("policyId"), "name": p.CI.Name, "primaryClusterId": v.serverID,
				"frequencies": frequencies(backupsim.Int(a, "rpoMinutes"), backupsim.Int(a, "retentionDays")), "numProtectedObjects": len(p.Covers)})
		}
		page(w, r, out)
	}))
	mux.HandleFunc("GET /api/v1/vmware/vcenter", guard(func(w http.ResponseWriter, r *http.Request) {
		seen := map[string]bool{}
		out := []any{}
		for _, vm := range v.vms {
			if id := vcenterID(vm); !seen[id] {
				seen[id] = true
				out = append(out, map[string]any{"id": id, "hostname": vcenterHost(vm), "name": vcenterHost(vm)})
			}
		}
		page(w, r, out)
	}))
	mux.HandleFunc("GET /api/v1/vmware/vm", guard(func(w http.ResponseWriter, r *http.Request) {
		out := []any{}
		for _, vm := range v.vms {
			doc := map[string]any{"id": "VirtualMachine:::" + vm.ID("instanceUuid"), "name": vm.Name, "moid": moidOf(vm), "vcenterId": vcenterID(vm), "ipAddress": vm.Str("ipAddress"),
				"effectiveSlaDomainId": unprotected, "effectiveSlaDomainName": "Unprotected", "isRelic": false}
			if o, ok := v.byVM[vm]; ok {
				doc["name"] = backupsim.Str(o.cover.Attrs, "objectName")
				doc["effectiveSlaDomainId"], doc["effectiveSlaDomainName"] = o.policy.CI.ID("policyId"), o.policy.CI.Name
			}
			out = append(out, doc)
		}
		page(w, r, out)
	}))
	mux.HandleFunc("GET /api/v1/vmware/vm/{id}/snapshot", guard(func(w http.ResponseWriter, r *http.Request) {
		vm, ok := vmByID[r.PathValue("id")]
		if !ok {
			sim.NotFound(w)
			return
		}
		o, ok := v.byVM[vm]
		if !ok {
			page(w, r, []any{})
			return
		}
		page(w, r, snapshots(o, r.PathValue("id")))
	}))
	mux.HandleFunc("GET /api/v1/fileset", guard(func(w http.ResponseWriter, r *http.Request) {
		out := []any{}
		for i, o := range v.filesets {
			name := "root"
			if subs := backupsim.Strs(o.cover.Attrs, "subclients"); len(subs) > 0 {
				name = subs[0]
			}
			out = append(out, map[string]any{"id": filesetID(i), "name": name, "hostName": backupsim.Str(o.cover.Attrs, "objectName"),
				"effectiveSlaDomainId": o.policy.CI.ID("policyId"), "effectiveSlaDomainName": o.policy.CI.Name})
		}
		page(w, r, out)
	}))
	mux.HandleFunc("GET /api/v1/fileset/{id}", guard(func(w http.ResponseWriter, r *http.Request) {
		for i, o := range v.filesets {
			if filesetID(i) == r.PathValue("id") {
				sim.WriteJSON(w, http.StatusOK, map[string]any{"id": filesetID(i), "hostName": backupsim.Str(o.cover.Attrs, "objectName"), "snapshots": snapshots(o, filesetID(i))})
				return
			}
		}
		sim.NotFound(w)
	}))
	return mux
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep, _, err := sim.ServeHTTPS(env, load(e).handler(env))
	return ep, err
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	v := load(e)
	if len(v.policies) == 0 {
		return nil
	}
	run := sim.Run{
		Name:           vendor,
		Targets:        []sim.Target{{Kind: "host", Value: ep.URL, Label: v.host}},
		Options:        map[string]any{"vendor": vendor, "verifyTls": true, "caCertPem": env.CA.PEM, "inventory": backupsim.Inventory(e)},
		CredentialType: "oauth_client",
		Credential:     &sim.Credential{Type: "oauth_client", Fields: map[string]string{"clientId": env.User, "clientSecret": env.Secret}},
	}
	backupsim.Expect(&run, v.policies)
	return []sim.Run{run}
}

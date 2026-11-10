// REQ-QA-005 REQ-INT-017 — simulated Veeam Backup & Replication REST API v1 (ADR-075), rendered from the estate's Veeam
// backup policies: the OAuth 2.0 password grant at /api/oauth2/token, the x-api-version header required on every call,
// skip/limit paging in the {data, pagination} envelope, /serverInfo, /jobs with each job's VMs, schedule and retention,
// /jobs/states, /backups, each backup's objects and each object's restore points (spaced one RPO apart back from the
// cover's last good backup). VMs that never completed a backup are in their job but in no backup.
package veeam

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/backupsim"
)

const (
	vendor       = "veeam"
	apiVersion   = "1.1-rev2"
	versionHdr   = "x-api-version"
	defaultLimit = 200
	minutesHour  = 60
	minutesDay   = 1440
	// Folder names under the vCenter in an object's path.
	datacenter = "Datacenter"
	vcenterTag = "vcsa"
)

type Vendor struct{}

func (Vendor) ID() string             { return "veeam-backup-replication" }
func (Vendor) Collector() string      { return "backup" }
func (Vendor) Requirements() []string { return []string{"REQ-INT-017"} }

type view struct {
	policies []*backupsim.Policy
	serverID string
	host     string
}

func load(e *estate.Estate) *view {
	ps := backupsim.Policies(e, vendor)
	host, id := backupsim.Server(ps)
	return &view{policies: ps, serverID: id, host: host}
}

// vcenterOf names the vCenter that manages a VM: one per site, as the estate's VMs carry their site.
func vcenterOf(vm *estate.CI) string {
	return vcenterTag + "-" + strings.ToLower(nonEmpty(vm.Str("site"), "dc")) + ".sim"
}

// moRefOf is a vCenter-shaped managed object id derived from the VM's instance UUID, stable across runs.
func moRefOf(vm *estate.CI) string {
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

func schedule(rpo int) map[string]any {
	switch {
	case rpo > 0 && rpo < minutesDay && rpo%minutesHour == 0:
		return map[string]any{"runAutomatically": true, "periodically": map[string]any{"isEnabled": true, "periodicallyKind": "Hours", "frequency": rpo / minutesHour}}
	case rpo > 0 && rpo < minutesDay:
		return map[string]any{"runAutomatically": true, "periodically": map[string]any{"isEnabled": true, "periodicallyKind": "Minutes", "frequency": rpo}}
	case rpo == minutesDay:
		return map[string]any{"runAutomatically": true, "daily": map[string]any{"isEnabled": true, "localTime": "22:00", "dailyKind": "Everyday"}}
	case rpo > minutesDay:
		return map[string]any{"runAutomatically": true, "monthly": map[string]any{"isEnabled": true}}
	}
	return map[string]any{"runAutomatically": false}
}

func titleResult(r string) string {
	switch r {
	case "success":
		return "Success"
	case "warning":
		return "Warning"
	case "failed":
		return "Failed"
	}
	return "None"
}

func (v *view) jobs() []any {
	out := make([]any, 0, len(v.policies))
	for _, p := range v.policies {
		a := p.CI.Attributes
		includes := []any{}
		for _, c := range backupsim.SortedCovers(p) {
			includes = append(includes, map[string]any{"inventoryObject": map[string]any{"type": "VirtualMachine", "hostName": vcenterOf(c.CI), "name": backupsim.Str(c.Attrs, "objectName"), "objectId": moRefOf(c.CI)}, "size": "0 B"})
		}
		retention := map[string]any{"type": "Days", "quantity": backupsim.Int(a, "retentionDays")}
		if n := backupsim.Int(a, "retentionPoints"); n > 0 {
			retention = map[string]any{"type": "RestorePoints", "quantity": n}
		}
		enabled, _ := a["enabled"].(bool)
		out = append(out, map[string]any{
			"id": p.CI.ID("policyId"), "name": p.CI.Name, "type": "VSphereBackup", "description": "", "isDisabled": !enabled,
			"virtualMachines": map[string]any{"includes": includes, "excludes": map[string]any{}},
			"storage":         map[string]any{"backupRepositoryId": p.CI.ID("serverId"), "retentionPolicy": retention},
			"schedule":        schedule(backupsim.Int(a, "rpoMinutes")),
		})
	}
	return out
}

func (v *view) states() []any {
	out := make([]any, 0, len(v.policies))
	for _, p := range v.policies {
		a := p.CI.Attributes
		out = append(out, map[string]any{"id": p.CI.ID("policyId"), "name": p.CI.Name, "type": "VSphereBackup", "status": "Inactive",
			"lastRun": backupsim.Str(a, "lastRunAt"), "lastResult": titleResult(backupsim.Str(a, "lastResult")), "objectsCount": len(p.Covers)})
	}
	return out
}

// backupID and objectID are stable ids for a job's backup and each object in it.
func backupID(p *backupsim.Policy) string { return "bk-" + p.CI.ID("policyId") }
func objectID(p *backupsim.Policy, c backupsim.Cover) string {
	return "obj-" + p.CI.ID("policyId") + "-" + url.PathEscape(moRefOf(c.CI))
}

func (v *view) handler(env *sim.Env) http.Handler {
	token := env.Token(vendor)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Header.Get(versionHdr) == "" || r.Form.Get("grant_type") != "password" || r.Form.Get("username") != env.User || r.Form.Get("password") != env.Secret {
			sim.WriteJSON(w, http.StatusUnauthorized, map[string]any{"errorCode": "Unauthorized", "message": "Invalid credentials.", "provenance": sim.Provenance})
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"access_token": token, "token_type": "bearer", "refresh_token": env.Token(vendor + "-refresh"), "expires_in": 900})
	})
	guard := func(next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get(versionHdr) != apiVersion {
				sim.WriteJSON(w, http.StatusBadRequest, map[string]any{"errorCode": "BadRequest", "message": "x-api-version header is required", "provenance": sim.Provenance})
				return
			}
			if !sim.BearerOK(r, token) {
				sim.Unauthorized(w)
				return
			}
			next(w, r)
		}
	}
	page := func(w http.ResponseWriter, r *http.Request, items []any) {
		skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
		limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil || limit <= 0 {
			limit = defaultLimit
		}
		data, _ := backupsim.Page(items, skip, limit)
		sim.WriteJSON(w, http.StatusOK, map[string]any{"data": data, "pagination": map[string]any{"total": len(items), "count": len(data), "skip": skip, "limit": limit}})
	}
	byPolicy := map[string]*backupsim.Policy{}
	byObject := map[string]backupsim.Cover{}
	objPolicy := map[string]*backupsim.Policy{}
	for _, p := range v.policies {
		byPolicy[backupID(p)] = p
		for _, c := range p.Covers {
			byObject[objectID(p, c)] = c
			objPolicy[objectID(p, c)] = p
		}
	}
	mux.HandleFunc("GET /api/v1/serverInfo", guard(func(w http.ResponseWriter, _ *http.Request) {
		sim.WriteJSON(w, http.StatusOK, map[string]any{"vbrId": v.serverID, "name": v.host, "buildVersion": "12.2.0.334", "patches": []string{}, "provenance": sim.Provenance})
	}))
	mux.HandleFunc("GET /api/v1/jobs", guard(func(w http.ResponseWriter, r *http.Request) { page(w, r, v.jobs()) }))
	mux.HandleFunc("GET /api/v1/jobs/states", guard(func(w http.ResponseWriter, r *http.Request) { page(w, r, v.states()) }))
	mux.HandleFunc("GET /api/v1/backups", guard(func(w http.ResponseWriter, r *http.Request) {
		out := []any{}
		for _, p := range v.policies {
			out = append(out, map[string]any{"id": backupID(p), "name": p.CI.Name, "jobId": p.CI.ID("policyId"), "policyUniqueId": p.CI.ID("policyId"), "jobType": "VSphereBackup", "platformName": "VMware"})
		}
		page(w, r, out)
	}))
	mux.HandleFunc("GET /api/v1/backups/{id}/objects", guard(func(w http.ResponseWriter, r *http.Request) {
		p, ok := byPolicy[r.PathValue("id")]
		if !ok {
			sim.NotFound(w)
			return
		}
		out := []any{}
		for _, c := range backupsim.SortedCovers(p) {
			// Only objects with a restore point are in the backup.
			if backupsim.Int(c.Attrs, "restorePoints") == 0 {
				continue
			}
			vc := vcenterOf(c.CI)
			out = append(out, map[string]any{"id": objectID(p, c), "name": backupsim.Str(c.Attrs, "objectName"), "type": "VM", "platformName": "VMware", "viType": "VirtualMachine",
				"objectId": moRefOf(c.CI), "path": vc + "\\" + datacenter + "\\" + nonEmpty(c.CI.Str("cluster"), "Cluster") + "\\" + backupsim.Str(c.Attrs, "objectName"), "restorePointsCount": backupsim.Int(c.Attrs, "restorePoints")})
		}
		page(w, r, out)
	}))
	mux.HandleFunc("GET /api/v1/backupObjects/{id}/restorePoints", guard(func(w http.ResponseWriter, r *http.Request) {
		c, ok := byObject[r.PathValue("id")]
		if !ok {
			sim.NotFound(w)
			return
		}
		p := objPolicy[r.PathValue("id")]
		newest, has := backupsim.Time(c.Attrs, "lastGoodBackupAt")
		out := []any{}
		if has {
			step := time.Duration(nonZero(backupsim.Int(p.CI.Attributes, "rpoMinutes"), minutesDay)) * time.Minute
			for i := 0; i < backupsim.Int(c.Attrs, "restorePoints"); i++ {
				kind := "Increment"
				if i == backupsim.Int(c.Attrs, "restorePoints")-1 {
					kind = "Full"
				}
				out = append(out, map[string]any{"id": r.PathValue("id") + "-rp" + strconv.Itoa(i), "name": backupsim.Str(c.Attrs, "objectName"), "platformName": "VMware",
					"creationTime": newest.Add(-time.Duration(i) * step).Format(time.RFC3339), "backupId": backupID(p), "type": kind, "malwareStatus": "Clean"})
			}
		}
		page(w, r, out)
	}))
	return mux
}

func nonZero(v, fallback int) int {
	if v == 0 {
		return fallback
	}
	return v
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	v := load(e)
	ep, _, err := sim.ServeHTTPS(env, v.handler(env))
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
		Options:        map[string]any{"vendor": vendor, "apiVersion": apiVersion, "verifyTls": true, "caCertPem": env.CA.PEM, "inventory": backupsim.Inventory(e)},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
	}
	backupsim.Expect(&run, v.policies)
	return []sim.Run{run}
}

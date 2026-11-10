// T-651 REQ-INT-017 (ADR-075) — the Veeam Backup & Replication adapter and the backup collector's matching, against an
// HTTPS test server. Response shapes are built from Veeam's published REST API v1 reference (1.1-rev2), not recorded
// captures (no Veeam server is available, risk R-004): the password grant with x-api-version on every request,
// skip/limit paging, a periodic and a daily job, a job VM that no backup holds yet, restore points as last good backup;
// inventory matching by vCenter moRef and by name, the FQDN fallback, unmatched objects, and a rejected password.
package backup

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	testUser     = "svc-openmap"
	testPassword = "s3cret-pass"
	testToken    = "veeam-access-token"
)

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// veeamPaged answers one page of items in Veeam's {data, pagination} envelope.
func veeamPaged(w http.ResponseWriter, r *http.Request, items []any) {
	skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = len(items)
	}
	if skip > len(items) {
		skip = len(items)
	}
	end := skip + limit
	if end > len(items) {
		end = len(items)
	}
	writeJSON(w, map[string]any{"data": items[skip:end], "pagination": map[string]any{"total": len(items), "count": end - skip, "skip": skip, "limit": limit}})
}

func veeamServer(t *testing.T) *httptest.Server {
	t.Helper()
	jobs := []any{
		map[string]any{
			"id": "job-1", "name": "Tier1 VMs 4h", "type": "VSphereBackup", "isDisabled": false,
			"virtualMachines": map[string]any{"includes": []any{
				map[string]any{"inventoryObject": map[string]any{"type": "VirtualMachine", "hostName": "vc01.corp.example", "name": "app-01", "objectId": "vm-101"}},
				map[string]any{"inventoryObject": map[string]any{"type": "VirtualMachine", "hostName": "vc01.corp.example", "name": "new-vm", "objectId": "vm-199"}},
			}},
			"storage":  map[string]any{"retentionPolicy": map[string]any{"type": "Days", "quantity": 14}},
			"schedule": map[string]any{"runAutomatically": true, "periodically": map[string]any{"isEnabled": true, "periodicallyKind": "Hours", "frequency": 4}},
		},
		map[string]any{
			"id": "job-2", "name": "Daily VMs", "type": "VSphereBackup", "isDisabled": true,
			"virtualMachines": map[string]any{"includes": []any{}},
			"storage":         map[string]any{"retentionPolicy": map[string]any{"type": "RestorePoints", "quantity": 7}},
			"schedule":        map[string]any{"runAutomatically": true, "daily": map[string]any{"isEnabled": true, "localTime": "22:00"}},
		},
	}
	mux := http.NewServeMux()
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("x-api-version") != veeamAPIVersion {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if r.Header.Get("Authorization") != "Bearer "+testToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("POST /api/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Header.Get("x-api-version") == "" || r.Form.Get("grant_type") != "password" || r.Form.Get("username") != testUser || r.Form.Get("password") != testPassword {
			w.WriteHeader(http.StatusUnauthorized)
			writeJSON(w, map[string]any{"errorCode": "Unauthorized"})
			return
		}
		writeJSON(w, map[string]any{"access_token": testToken, "token_type": "bearer", "expires_in": 900})
	})
	mux.HandleFunc("GET /api/v1/serverInfo", auth(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"vbrId": "6f2b1c1e-0000-4000-8000-00000000vbr1", "name": "vbr01", "buildVersion": "12.2.0.334"})
	}))
	// Page size 1 on the jobs list proves the collector follows skip/limit.
	mux.HandleFunc("GET /api/v1/jobs", auth(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		q.Set("limit", "1")
		r.URL.RawQuery = q.Encode()
		veeamPaged(w, r, jobs)
	}))
	mux.HandleFunc("GET /api/v1/jobs/states", auth(func(w http.ResponseWriter, r *http.Request) {
		veeamPaged(w, r, []any{
			map[string]any{"id": "job-1", "status": "Inactive", "lastRun": "2026-11-10T06:00:00Z", "lastResult": "Warning"},
			map[string]any{"id": "job-2", "status": "Inactive", "lastRun": "2026-11-09T22:00:00Z", "lastResult": "Failed"},
		})
	}))
	mux.HandleFunc("GET /api/v1/backups", auth(func(w http.ResponseWriter, r *http.Request) {
		veeamPaged(w, r, []any{map[string]any{"id": "bk-1", "name": "Tier1 VMs 4h", "jobId": "job-1", "platformName": "VMware"}, map[string]any{"id": "bk-2", "name": "Daily VMs", "jobId": "job-2"}})
	}))
	mux.HandleFunc("GET /api/v1/backups/{id}/objects", auth(func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("id") {
		case "bk-1":
			veeamPaged(w, r, []any{
				map[string]any{"id": "obj-1", "name": "app-01", "type": "VM", "platformName": "VMware", "viType": "VirtualMachine", "objectId": "vm-101", "path": "vc01.corp.example\\DC1\\Cluster1\\app-01", "restorePointsCount": 2},
				map[string]any{"id": "obj-2", "name": "db-01.corp.example", "type": "VM", "viType": "VirtualMachine", "objectId": "vm-102", "path": "vc01.corp.example\\DC1\\Cluster1\\db-01.corp.example", "restorePointsCount": 1},
				map[string]any{"id": "obj-3", "name": "orphan", "type": "VM", "viType": "VirtualMachine", "objectId": "vm-103", "path": "vc09\\DC9\\orphan", "restorePointsCount": 1},
			})
		default:
			veeamPaged(w, r, []any{map[string]any{"id": "obj-4", "name": "web-01", "type": "VM", "viType": "VirtualMachine", "objectId": "vm-201", "path": "vc01.corp.example\\DC1\\Cluster2\\web-01"}})
		}
	}))
	mux.HandleFunc("GET /api/v1/backupObjects/{id}/restorePoints", auth(func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("id") {
		case "obj-1":
			veeamPaged(w, r, []any{map[string]any{"id": "rp-1", "creationTime": "2026-11-10T02:00:00Z", "type": "Increment"}, map[string]any{"id": "rp-2", "creationTime": "2026-11-10T06:01:12.5+00:00", "type": "Increment"}})
		case "obj-4":
			veeamPaged(w, r, []any{})
		default:
			veeamPaged(w, r, []any{map[string]any{"id": "rp-9", "creationTime": "2026-11-09T22:30:00Z", "type": "Full"}})
		}
	}))
	return httptest.NewTLSServer(mux)
}

func inventoryOption(entries ...map[string]any) []any {
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, e)
	}
	return out
}

func entry(ciType string, identity map[string]any, keys ...string) map[string]any {
	k := make([]any, 0, len(keys))
	for _, s := range keys {
		k = append(k, s)
	}
	return map[string]any{"type": ciType, "identity": identity, "keys": k}
}

func relsFrom(rels []contract.ObservedRelationship, policyID string) map[string]contract.ObservedRelationship {
	out := map[string]contract.ObservedRelationship{}
	for _, r := range rels {
		if r.To.Identity["policyId"] == policyID {
			out[r.Attributes["objectName"].(string)] = r
		}
	}
	return out
}

func TestVeeamPoliciesCoversAndMatching(t *testing.T) {
	srv := veeamServer(t)
	defer srv.Close()
	options := map[string]any{
		"vendor": "veeam",
		"inventory": inventoryOption(
			entry("vm", map[string]any{"instanceUuid": "4210aa00-0000-0000-0000-000000000101", "hypervisorRef": "esx01", "fqdn": "app-01.corp.example"}, "app-01", "vc01.corp.example:vm-101"),
			entry("vm", map[string]any{"instanceUuid": "4210aa00-0000-0000-0000-000000000201"}, "web-01"),
			// Two CIs named "dup": the key is ambiguous and dropped.
			entry("vm", map[string]any{"instanceUuid": "a"}, "dup"),
			entry("vm", map[string]any{"instanceUuid": "b"}, "dup"),
		),
	}
	cred := &contract.Credential{Type: "password", Fields: map[string]string{"username": testUser, "password": testPassword}}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs.Cis) != 2 {
		t.Fatalf("want 2 policies, got %d", len(obs.Cis))
	}
	byID := map[string]contract.ObservedCi{}
	for _, c := range obs.Cis {
		if c.Type != "backup_policy" || c.Identity["vendor"] != "veeam" || c.Identity["serverId"] != "6f2b1c1e-0000-4000-8000-00000000vbr1" {
			t.Fatalf("policy identity %v", c.Identity)
		}
		byID[c.Identity["policyId"]] = c
	}
	j1 := byID["job-1"].Attributes
	if j1["rpoMinutes"] != 240 || j1["retentionDays"] != 14 || j1["policyKind"] != "job" || j1["lastResult"] != "warning" || j1["enabled"] != true || j1["lastRunAt"] != "2026-11-10T06:00:00Z" {
		t.Fatalf("job-1 attributes %v", j1)
	}
	// app-01 by moRef, db-01 by FQDN fallback, new-vm unmatched (no inventory entry, no DNS name), orphan unmatched.
	if j1["protectedObjects"] != 2 || j1["unmatchedObjects"] != 2 {
		t.Fatalf("job-1 counts %v / %v", j1["protectedObjects"], j1["unmatchedObjects"])
	}
	names, _ := j1["unmatchedNames"].([]string)
	if strings.Join(names, ",") != "new-vm,orphan" {
		t.Fatalf("unmatched names %v", names)
	}
	j2 := byID["job-2"].Attributes
	if j2["rpoMinutes"] != 1440 || j2["retentionPoints"] != 7 || j2["enabled"] != false || j2["lastResult"] != "failed" {
		t.Fatalf("job-2 attributes %v", j2)
	}
	if _, ok := j2["retentionDays"]; ok {
		t.Fatal("a restore-point retention reports no days")
	}
	r1 := relsFrom(obs.Relationships, "job-1")
	app := r1["app-01"]
	if app.Type != "backed_by" || app.From.Type != "vm" || app.From.Identity["instanceUuid"] != "4210aa00-0000-0000-0000-000000000101" {
		t.Fatalf("app-01 edge %+v", app)
	}
	if app.Attributes["lastGoodBackupAt"] != "2026-11-10T06:01:12Z" || app.Attributes["restorePoints"] != 2 || app.Attributes["rpoMinutes"] != 240 || app.Attributes["retentionDays"] != 14 || app.Attributes["lastResult"] != "warning" {
		t.Fatalf("app-01 cover %v", app.Attributes)
	}
	db := r1["db-01.corp.example"]
	if db.From.Type != "vm" || db.From.Identity["fqdn"] != "db-01.corp.example" || len(db.From.Identity) != 1 {
		t.Fatalf("db-01 fallback %+v", db.From)
	}
	web := relsFrom(obs.Relationships, "job-2")["web-01"]
	if web.From.Identity["instanceUuid"] != "4210aa00-0000-0000-0000-000000000201" || web.Attributes["lastResult"] != "none" || web.Attributes["restorePoints"] != 0 {
		t.Fatalf("web-01 never backed up %+v", web)
	}
	if _, ok := web.Attributes["lastGoodBackupAt"]; ok {
		t.Fatal("no restore point means no last good backup")
	}
	if len(obs.Evidence) == 0 {
		t.Fatal("no evidence captured")
	}
}

func TestVeeamRejectsPassword(t *testing.T) {
	srv := veeamServer(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{"username": testUser, "password": "wrong"}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, map[string]any{"vendor": "veeam"})
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("want auth_failed, got %v", err)
	}
}

func TestVerifyTlsRefusesAnUntrustedServer(t *testing.T) {
	srv := veeamServer(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{"username": testUser, "password": testPassword}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, map[string]any{"vendor": "veeam", "verifyTls": true})
	if err == nil {
		t.Fatal("verifyTls must refuse a certificate no CA vouches for")
	}
}

func TestUnknownVendor(t *testing.T) {
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: "x"}, nil, map[string]any{"vendor": "netbackup"})
	if err == nil || !strings.Contains(err.Error(), contract.ErrUnsupportedDevice) {
		t.Fatalf("want unsupported_device, got %v", err)
	}
}

func TestInventoryPrecedenceAndAmbiguity(t *testing.T) {
	inv := ParseInventory(map[string]any{"inventory": inventoryOption(
		entry("vm", map[string]any{"instanceUuid": "u-1"}, "shared-name", "vc:vm-1"),
		entry("vm", map[string]any{"instanceUuid": "u-2"}, "shared-name", "10.0.0.2"),
		entry("host", map[string]any{"serialNumber": "SN1"}, "srv-01.corp.example"),
		entry("storage_array", map[string]any{"serialNumber": "X"}, "ignored"),
	)})
	// The moRef key wins over the ambiguous name.
	ref, ok := inv.Resolve(Object{Kind: "vm", Name: "shared-name", VCenter: "VC", MoRef: "vm-1"})
	if !ok || ref.Identity["instanceUuid"] != "u-1" {
		t.Fatalf("moRef match %+v", ref)
	}
	// Name ambiguous, address unique.
	ref, ok = inv.Resolve(Object{Kind: "vm", Name: "shared-name", IP: "10.0.0.2"})
	if !ok || ref.Identity["instanceUuid"] != "u-2" {
		t.Fatalf("address match %+v", ref)
	}
	ref, ok = inv.Resolve(Object{Kind: "host", Name: "SRV-01", FQDN: "SRV-01.corp.example"})
	if !ok || ref.Type != "host" || ref.Identity["serialNumber"] != "SN1" {
		t.Fatalf("fqdn match %+v", ref)
	}
	if _, ok := inv.Resolve(Object{Kind: "vm", Name: "shared-name"}); ok {
		t.Fatal("an ambiguous name alone must not match")
	}
	if _, ok := inv.Resolve(Object{Kind: "vm", Name: "ignored"}); ok {
		t.Fatal("entries of types a backup does not protect are ignored")
	}
	if _, ok := inv.Resolve(Object{Kind: "host", Name: "10.1.1.1"}); ok {
		t.Fatal("a bare address is not a DNS name")
	}
}

func TestVeeamRpo(t *testing.T) {
	var j veeamJob
	j.Schedule.Periodically.IsEnabled, j.Schedule.Periodically.PeriodicallyKind, j.Schedule.Periodically.Frequency = true, "Minutes", 30
	if VeeamRpoMinutes(j) != 30 {
		t.Fatal("periodic minutes")
	}
	j = veeamJob{}
	j.Schedule.Monthly.IsEnabled = true
	if VeeamRpoMinutes(j) != minutesPerMonth {
		t.Fatal("monthly")
	}
	if VeeamRpoMinutes(veeamJob{}) != 0 {
		t.Fatal("unscheduled job states no RPO")
	}
	if VeeamResult("Success", "Running") != ResultRunning || VeeamResult("None", "Inactive") != ResultNone {
		t.Fatal("results")
	}
}

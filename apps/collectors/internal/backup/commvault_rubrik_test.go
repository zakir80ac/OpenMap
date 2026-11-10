// T-652 REQ-INT-017 (ADR-075) — the Commvault and Rubrik adapters against HTTPS test servers. Response shapes are built
// from Commvault's Command Center REST API reference and Rubrik's CDM REST API reference (v1 and v2), not recorded
// captures (no Commvault or Rubrik system is available, risk R-004). Commvault: the Base64 password login and Authtoken
// header, a wrong password answered with 200 and an errList, a plan and a storage policy, agents and subclients per
// client, job history giving the last good backup; Rubrik: the service account session, SLA frequencies giving RPO and
// retention, VMs by vCenter moRef with paging, unprotected VMs skipped, filesets per host.
package backup

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	cvToken     = "QSDK 3f6a1c"
	rubrikID    = "sa-1234"
	rubrikKey   = "rubrik-secret"
	rubrikToken = "rubrik-session-token"
)

func commvaultServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authtoken") != cvToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("POST /webconsole/api/Login", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		pw, _ := base64.StdEncoding.DecodeString(body.Password)
		if body.Username != testUser || string(pw) != testPassword {
			writeJSON(w, map[string]any{"errList": []any{map[string]any{"errLogMessage": "Invalid Username or Password", "errorCode": 5}}})
			return
		}
		writeJSON(w, map[string]any{"token": cvToken, "userName": testUser})
	})
	mux.HandleFunc("GET /webconsole/api/v2/Plan", auth(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"plans": []any{map[string]any{
			"plan": map[string]any{"planId": 7, "planName": "Server Gold"}, "rpoInMinutes": 240,
			"storage": map[string]any{"copy": []any{map[string]any{"retentionRules": map[string]any{"retainBackupDataForDays": 30}}, map[string]any{"retentionRules": map[string]any{"retainBackupDataForDays": 90}}}},
		}}})
	}))
	mux.HandleFunc("GET /webconsole/api/Client", auth(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"clientProperties": []any{
			map[string]any{"client": map[string]any{"clientEntity": map[string]any{"clientId": 2, "clientName": "sql-01", "hostName": "sql-01.corp.example"}}},
			map[string]any{"client": map[string]any{"clientEntity": map[string]any{"clientId": 3, "clientName": "legacy-01", "hostName": "10.9.9.9"}}},
			map[string]any{"client": map[string]any{"clientEntity": map[string]any{"clientId": 4, "clientName": "idle", "hostName": "idle.corp.example"}}},
		}})
	}))
	mux.HandleFunc("GET /webconsole/api/Subclient", auth(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("clientId") {
		case "2":
			writeJSON(w, map[string]any{"subClientProperties": []any{
				map[string]any{"subClientEntity": map[string]any{"subclientId": 21, "subclientName": "default", "backupsetName": "defaultBackupSet", "appName": "File System", "clientName": "sql-01"}, "planEntity": map[string]any{"planId": 7, "planName": "Server Gold"}, "commonProperties": map[string]any{"enableBackup": true}},
				map[string]any{"subClientEntity": map[string]any{"subclientId": 22, "subclientName": "default", "backupsetName": "MSSQLSERVER", "appName": "SQL Server", "clientName": "sql-01"}, "planEntity": map[string]any{"planId": 7, "planName": "Server Gold"}, "commonProperties": map[string]any{"enableBackup": true}},
			}})
		case "3":
			writeJSON(w, map[string]any{"subClientProperties": []any{
				map[string]any{"subClientEntity": map[string]any{"subclientId": 31, "subclientName": "default", "backupsetName": "defaultBackupSet", "appName": "File System", "clientName": "legacy-01"}, "commonProperties": map[string]any{"enableBackup": false, "storageDevice": map[string]any{"dataBackupStoragePolicy": map[string]any{"storagePolicyId": 11, "storagePolicyName": "SP-Legacy"}}}},
			}})
		default:
			writeJSON(w, map[string]any{})
		}
	}))
	mux.HandleFunc("GET /webconsole/api/Job", auth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("jobFilter") != "Backup" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		job := func(id, sub int, status string, start, end int64) any {
			return map[string]any{"jobSummary": map[string]any{"jobId": id, "status": status, "jobType": "Backup", "jobStartTime": start, "jobEndTime": end, "subclient": map[string]any{"subclientId": sub}}}
		}
		switch r.URL.Query().Get("clientId") {
		case "2":
			writeJSON(w, map[string]any{"totalRecordsWithoutPaging": 4, "jobs": []any{
				job(1, 21, "Completed", 1762740000, 1762743600),                       // 2025-11-10T02:00Z..03:00Z
				job(2, 22, "Completed w/ one or more errors", 1762750800, 1762754400), // ..06:00Z
				job(3, 21, "Failed", 1762758000, 1762758600),                          // 07:00..07:10Z
				job(4, 22, "Running", 1762761600, 0),                                  // 08:00Z
			}})
		default:
			writeJSON(w, map[string]any{"totalRecordsWithoutPaging": 0})
		}
	}))
	return httptest.NewTLSServer(mux)
}

func TestCommvaultPlansClientsAndJobs(t *testing.T) {
	srv := commvaultServer(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{"username": testUser, "password": testPassword}}
	options := map[string]any{"vendor": "commvault", "inventory": inventoryOption(entry("host", map[string]any{"serialNumber": "SQL01SN"}, "sql-01", "sql-01.corp.example"))}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs.Cis) != 2 {
		t.Fatalf("want a plan and a storage policy, got %d", len(obs.Cis))
	}
	host := strings.ToLower(strings.Split(strings.TrimPrefix(srv.URL, "https://"), ":")[0])
	byID := map[string]contract.ObservedCi{}
	for _, c := range obs.Cis {
		if c.Identity["serverId"] != host {
			t.Fatalf("serverId %q, want %q", c.Identity["serverId"], host)
		}
		byID[c.Identity["policyId"]] = c
	}
	plan := byID["plan:7"]
	if plan.Name != "Server Gold" || plan.Attributes["policyKind"] != "plan" || plan.Attributes["rpoMinutes"] != 240 || plan.Attributes["retentionDays"] != 90 || plan.Attributes["lastResult"] != "running" {
		t.Fatalf("plan %s %v", plan.Name, plan.Attributes)
	}
	sp := byID["sp:11"]
	if sp.Name != "SP-Legacy" || sp.Attributes["policyKind"] != "storage_policy" || sp.Attributes["enabled"] != false || sp.Attributes["unmatchedObjects"] != 1 {
		t.Fatalf("storage policy %v", sp.Attributes)
	}
	if _, ok := sp.Attributes["rpoMinutes"]; ok {
		t.Fatal("a storage policy states no RPO")
	}
	edges := relsFrom(obs.Relationships, "plan:7")
	sql := edges["sql-01"]
	if sql.From.Type != "host" || sql.From.Identity["serialNumber"] != "SQL01SN" {
		t.Fatalf("sql-01 matched %+v", sql.From)
	}
	a := sql.Attributes
	if a["lastGoodBackupAt"] != "2025-11-10T06:00:00Z" || a["restorePoints"] != 2 || a["lastResult"] != "running" || a["lastBackupAt"] != "2025-11-10T08:00:00Z" {
		t.Fatalf("sql-01 cover %v", a)
	}
	agents, _ := a["agents"].([]string)
	subs, _ := a["subclients"].([]string)
	if strings.Join(agents, ",") != "File System,SQL Server" || len(subs) != 2 {
		t.Fatalf("agents %v subclients %v", agents, subs)
	}
}

func TestCommvaultWrongPassword(t *testing.T) {
	srv := commvaultServer(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "password", Fields: map[string]string{"username": testUser, "password": "nope"}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, map[string]any{"vendor": "commvault"})
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("want auth_failed, got %v", err)
	}
}

func rubrikServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	auth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+rubrikToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	paged := func(w http.ResponseWriter, r *http.Request, items []any) {
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		// One item per page proves the collector follows hasMore.
		if limit > 1 {
			limit = 1
		}
		if offset > len(items) {
			offset = len(items)
		}
		end := offset + limit
		if end > len(items) {
			end = len(items)
		}
		writeJSON(w, map[string]any{"data": items[offset:end], "hasMore": end < len(items), "total": len(items)})
	}
	mux.HandleFunc("POST /api/v1/service_account/session", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["serviceAccountId"] != rubrikID || body["secret"] != rubrikKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeJSON(w, map[string]any{"token": rubrikToken, "sessionId": "s-1", "expirationTime": "2026-11-11T00:00:00Z"})
	})
	mux.HandleFunc("GET /api/v1/cluster/me", auth(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"id": "c0ffee00-1111-2222-3333-444455556666", "name": "rbk01", "version": "9.1.2"})
	}))
	mux.HandleFunc("GET /api/v2/sla_domain", auth(func(w http.ResponseWriter, r *http.Request) {
		paged(w, r, []any{
			map[string]any{"id": "sla-gold", "name": "Gold", "frequencies": map[string]any{"hourly": map[string]any{"frequency": 4, "retention": 72}, "daily": map[string]any{"frequency": 1, "retention": 30}, "monthly": map[string]any{"frequency": 1, "retention": 12}}},
			map[string]any{"id": "sla-bronze", "name": "Bronze", "frequencies": map[string]any{"daily": map[string]any{"frequency": 1, "retention": 7}}},
		})
	}))
	mux.HandleFunc("GET /api/v1/vmware/vcenter", auth(func(w http.ResponseWriter, r *http.Request) {
		paged(w, r, []any{map[string]any{"id": "vCenter:::1", "hostname": "vc01.corp.example"}})
	}))
	mux.HandleFunc("GET /api/v1/vmware/vm", auth(func(w http.ResponseWriter, r *http.Request) {
		paged(w, r, []any{
			map[string]any{"id": "VirtualMachine:::1-vm-101", "name": "app-01", "moid": "vm-101", "vcenterId": "vCenter:::1", "ipAddress": "10.0.0.11", "effectiveSlaDomainId": "sla-gold", "effectiveSlaDomainName": "Gold"},
			map[string]any{"id": "VirtualMachine:::1-vm-102", "name": "scratch", "moid": "vm-102", "vcenterId": "vCenter:::1", "effectiveSlaDomainId": "UNPROTECTED", "effectiveSlaDomainName": "Unprotected"},
			map[string]any{"id": "VirtualMachine:::1-vm-103", "name": "fresh", "moid": "vm-103", "vcenterId": "vCenter:::1", "effectiveSlaDomainId": "sla-bronze", "effectiveSlaDomainName": "Bronze"},
		})
	}))
	mux.HandleFunc("GET /api/v1/vmware/vm/{id}/snapshot", auth(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.PathValue("id"), "vm-101") {
			paged(w, r, []any{map[string]any{"id": "s1", "date": "2026-11-10T04:00:00.000Z"}, map[string]any{"id": "s2", "date": "2026-11-10T08:00:00.000Z"}})
			return
		}
		paged(w, r, []any{})
	}))
	mux.HandleFunc("GET /api/v1/fileset", auth(func(w http.ResponseWriter, r *http.Request) {
		paged(w, r, []any{
			map[string]any{"id": "Fileset:::1", "name": "etc", "hostName": "files-01.corp.example", "effectiveSlaDomainId": "sla-bronze", "effectiveSlaDomainName": "Bronze"},
			map[string]any{"id": "Fileset:::2", "name": "var", "hostName": "files-01.corp.example", "effectiveSlaDomainId": "sla-bronze", "effectiveSlaDomainName": "Bronze"},
		})
	}))
	mux.HandleFunc("GET /api/v1/fileset/{id}", auth(func(w http.ResponseWriter, r *http.Request) {
		date := "2026-11-09T01:00:00Z"
		if r.PathValue("id") == "Fileset:::2" {
			date = "2026-11-09T03:00:00Z"
		}
		writeJSON(w, map[string]any{"id": r.PathValue("id"), "snapshots": []any{map[string]any{"id": "f", "date": date}}})
	}))
	return httptest.NewTLSServer(mux)
}

func TestRubrikSlaDomainsVmsAndFilesets(t *testing.T) {
	srv := rubrikServer(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "oauth_client", Fields: map[string]string{"clientId": rubrikID, "clientSecret": rubrikKey}}
	options := map[string]any{"vendor": "rubrik", "inventory": inventoryOption(
		entry("vm", map[string]any{"instanceUuid": "u-101"}, "vc01.corp.example:vm-101"),
		entry("vm", map[string]any{"instanceUuid": "u-103"}, "fresh"),
	)}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, options)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]contract.ObservedCi{}
	for _, c := range obs.Cis {
		if c.Identity["serverId"] != "c0ffee00-1111-2222-3333-444455556666" {
			t.Fatalf("serverId %v", c.Identity)
		}
		byID[c.Identity["policyId"]] = c
	}
	gold := byID["sla-gold"].Attributes
	if gold["policyKind"] != "sla_domain" || gold["rpoMinutes"] != 240 || gold["retentionDays"] != 360 || gold["protectedObjects"] != 1 || gold["lastRunAt"] != "2026-11-10T08:00:00Z" {
		t.Fatalf("gold %v", gold)
	}
	bronze := byID["sla-bronze"].Attributes
	if bronze["rpoMinutes"] != 1440 || bronze["retentionDays"] != 7 || bronze["protectedObjects"] != 2 {
		t.Fatalf("bronze %v", bronze)
	}
	app := relsFrom(obs.Relationships, "sla-gold")["app-01"]
	if app.From.Identity["instanceUuid"] != "u-101" || app.Attributes["lastGoodBackupAt"] != "2026-11-10T08:00:00Z" || app.Attributes["restorePoints"] != 2 || app.Attributes["lastResult"] != "success" {
		t.Fatalf("app-01 %+v", app)
	}
	br := relsFrom(obs.Relationships, "sla-bronze")
	if br["fresh"].Attributes["lastResult"] != "none" || br["fresh"].From.Identity["instanceUuid"] != "u-103" {
		t.Fatalf("fresh %+v", br["fresh"])
	}
	files := br["files-01.corp.example"]
	if files.From.Type != "host" || files.From.Identity["fqdn"] != "files-01.corp.example" || files.Attributes["lastGoodBackupAt"] != "2026-11-09T03:00:00Z" || files.Attributes["restorePoints"] != 2 {
		t.Fatalf("fileset host %+v", files)
	}
	for _, r := range obs.Relationships {
		if r.Attributes["objectName"] == "scratch" {
			t.Fatal("an unprotected VM has no cover")
		}
	}
}

func TestRubrikRejectsSecret(t *testing.T) {
	srv := rubrikServer(t)
	defer srv.Close()
	cred := &contract.Credential{Type: "oauth_client", Fields: map[string]string{"clientId": rubrikID, "clientSecret": "bad"}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: srv.URL}, cred, map[string]any{"vendor": "rubrik"})
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("want auth_failed, got %v", err)
	}
}

func TestResultsNormalise(t *testing.T) {
	cases := map[string]string{"Completed": ResultSuccess, "Completed w/ one or more warnings": ResultWarning, "Failed to Start": ResultFailed, "Killed": ResultFailed, "Pending": ResultRunning, "": ResultNone}
	for in, want := range cases {
		if got := CommvaultResult(in); got != want {
			t.Errorf("%q: %s, want %s", in, got, want)
		}
	}
	var s rubrikSLA
	s.Frequencies.Hourly = &rubrikFrequency{Frequency: 1, Retention: 25}
	if rpo, days := RubrikRpoAndRetention(s); rpo != 60 || days != 2 {
		t.Fatalf("hourly %d %d", rpo, days)
	}
}

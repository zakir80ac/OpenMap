// REQ-QA-005 REQ-INT-017 — simulated Commvault Command Center REST API (ADR-075), rendered from the estate's Commvault
// policies: /Login with the Base64 password (a wrong one is answered 200 with an errList, as Commvault does), the
// Authtoken header, /Client with each protected CI as a client, /Subclient?clientId= with each agent's subclient on its
// plan or storage policy, /v2/Plan with RPO and retention, and /Job?clientId=&jobFilter=Backup with the backup history:
// the cover's good jobs one RPO apart back from its last good backup, and a newer failed job where the cover says so.
package commvault

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/backupsim"
)

const (
	vendor        = "commvault"
	apiPath       = "/webconsole/api"
	tokenPrefix   = "QSDK "
	planPrefix    = "plan:"
	storagePrefix = "sp:"
	minutesDay    = 1440
	// A simulated good job runs this long before it ends; a failed one this long before it fails.
	goodJobDuration   = 30 * time.Minute
	failedJobDuration = 10 * time.Minute
	firstClientID     = 2 // client 1 is the CommServe itself
	firstSubclientID  = 100
)

type Vendor struct{}

func (Vendor) ID() string             { return "commvault-command-center" }
func (Vendor) Collector() string      { return "backup" }
func (Vendor) Requirements() []string { return []string{"REQ-INT-017"} }

type subclient struct {
	id      int
	app     string
	set     string
	name    string
	policy  *backupsim.Policy
	enabled bool
}

type job struct {
	id         int
	subclient  int
	status     string
	start, end time.Time
}

type client struct {
	id      int
	ci      *estate.CI
	name    string
	host    string
	subs    []subclient
	history []job
}

type view struct {
	policies []*backupsim.Policy
	clients  []*client
	byID     map[int]*client
	host     string
}

func fqdnOf(c *estate.CI) string {
	if f := c.ID("fqdn"); f != "" {
		return f
	}
	if f := c.Str("fqdn"); f != "" {
		return f
	}
	return c.Name
}

func load(e *estate.Estate) *view {
	v := &view{policies: backupsim.Policies(e, vendor), byID: map[int]*client{}}
	v.host, _ = backupsim.Server(v.policies)
	byCI := map[*estate.CI]*client{}
	subID, jobID := firstSubclientID, 1
	for _, p := range v.policies {
		rpo := time.Duration(nonZero(backupsim.Int(p.CI.Attributes, "rpoMinutes"), minutesDay)) * time.Minute
		for _, c := range p.Covers {
			cl, ok := byCI[c.CI]
			if !ok {
				cl = &client{id: firstClientID + len(v.clients), ci: c.CI, name: backupsim.Str(c.Attrs, "objectName"), host: fqdnOf(c.CI)}
				byCI[c.CI] = cl
				v.clients = append(v.clients, cl)
				v.byID[cl.id] = cl
			}
			first := 0
			for i, s := range backupsim.Strs(c.Attrs, "subclients") {
				parts := strings.SplitN(s, "/", 3)
				for len(parts) < 3 {
					parts = append(parts, "default")
				}
				cl.subs = append(cl.subs, subclient{id: subID, app: parts[0], set: parts[1], name: parts[2], policy: p, enabled: true})
				if i == 0 {
					first = subID
				}
				subID++
			}
			if good, ok := backupsim.Time(c.Attrs, "lastGoodBackupAt"); ok {
				for i := 0; i < backupsim.Int(c.Attrs, "restorePoints"); i++ {
					end := good.Add(-time.Duration(i) * rpo)
					cl.history = append(cl.history, job{id: jobID, subclient: first, status: "Completed", start: end.Add(-goodJobDuration), end: end})
					jobID++
				}
			}
			if backupsim.Str(c.Attrs, "lastResult") == "failed" {
				if at, ok := backupsim.Time(c.Attrs, "lastBackupAt"); ok {
					cl.history = append(cl.history, job{id: jobID, subclient: first, status: "Failed", start: at.Add(-failedJobDuration), end: at})
					jobID++
				}
			}
		}
	}
	return v
}

func nonZero(v, fallback int) int {
	if v == 0 {
		return fallback
	}
	return v
}

func idOf(policyID, prefix string) int {
	n, _ := strconv.Atoi(strings.TrimPrefix(policyID, prefix))
	return n
}

func (v *view) plans() []any {
	out := []any{}
	for _, p := range v.policies {
		id := p.CI.ID("policyId")
		if !strings.HasPrefix(id, planPrefix) {
			continue
		}
		a := p.CI.Attributes
		out = append(out, map[string]any{
			"plan": map[string]any{"planId": idOf(id, planPrefix), "planName": p.CI.Name}, "planType": "Server", "rpoInMinutes": backupsim.Int(a, "rpoMinutes"),
			"numAssocEntities": len(p.Covers),
			"storage":          map[string]any{"copy": []any{map[string]any{"copyName": "Primary", "retentionRules": map[string]any{"retainBackupDataForDays": backupsim.Int(a, "retentionDays")}}}},
		})
	}
	return out
}

func (cl *client) subclients() []any {
	out := []any{}
	for _, s := range cl.subs {
		doc := map[string]any{
			"subClientEntity":  map[string]any{"subclientId": s.id, "subclientName": s.name, "backupsetName": s.set, "appName": s.app, "clientName": cl.name, "clientId": cl.id},
			"commonProperties": map[string]any{"enableBackup": s.enabled},
		}
		id := s.policy.CI.ID("policyId")
		if strings.HasPrefix(id, planPrefix) {
			doc["planEntity"] = map[string]any{"planId": idOf(id, planPrefix), "planName": s.policy.CI.Name}
		} else {
			doc["commonProperties"] = map[string]any{"enableBackup": s.enabled, "storageDevice": map[string]any{"dataBackupStoragePolicy": map[string]any{"storagePolicyId": idOf(id, storagePrefix), "storagePolicyName": s.policy.CI.Name}}}
		}
		out = append(out, doc)
	}
	return out
}

func (cl *client) jobs() []any {
	h := append([]job(nil), cl.history...)
	sort.SliceStable(h, func(i, j int) bool { return h[i].end.After(h[j].end) })
	out := []any{}
	for _, j := range h {
		var sub subclient
		for _, s := range cl.subs {
			if s.id == j.subclient {
				sub = s
			}
		}
		out = append(out, map[string]any{"jobSummary": map[string]any{
			"jobId": j.id, "status": j.status, "jobType": "Backup", "backupLevelName": "Incremental", "jobStartTime": j.start.Unix(), "jobEndTime": j.end.Unix(),
			"subclient": map[string]any{"subclientId": sub.id, "subclientName": sub.name, "clientName": cl.name, "appName": sub.app, "backupsetName": sub.set},
		}})
	}
	return out
}

func (v *view) handler(env *sim.Env) http.Handler {
	token := tokenPrefix + env.Token(vendor)
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+apiPath+"/Login", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		pw, err := base64.StdEncoding.DecodeString(body.Password)
		if err != nil || body.Username != env.User || string(pw) != env.Secret {
			sim.WriteJSON(w, http.StatusOK, map[string]any{"errList": []any{map[string]any{"errLogMessage": "Invalid Username or Password", "errorCode": 5}}, "provenance": sim.Provenance})
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"token": token, "userName": env.User, "aliasName": "1", "provenance": sim.Provenance})
	})
	guard := func(next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authtoken") != token {
				sim.Unauthorized(w)
				return
			}
			next(w, r)
		}
	}
	clientOf := func(w http.ResponseWriter, r *http.Request) (*client, bool) {
		id, _ := strconv.Atoi(r.URL.Query().Get("clientId"))
		cl, ok := v.byID[id]
		if !ok {
			sim.WriteJSON(w, http.StatusOK, map[string]any{})
		}
		return cl, ok
	}
	mux.HandleFunc("GET "+apiPath+"/v2/Plan", guard(func(w http.ResponseWriter, _ *http.Request) {
		sim.WriteJSON(w, http.StatusOK, map[string]any{"plans": v.plans()})
	}))
	mux.HandleFunc("GET "+apiPath+"/Client", guard(func(w http.ResponseWriter, _ *http.Request) {
		out := []any{}
		for _, cl := range v.clients {
			out = append(out, map[string]any{"client": map[string]any{"clientEntity": map[string]any{"clientId": cl.id, "clientName": cl.name, "hostName": cl.host, "displayName": cl.name}}})
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"clientProperties": out, "provenance": sim.Provenance})
	}))
	mux.HandleFunc("GET "+apiPath+"/Subclient", guard(func(w http.ResponseWriter, r *http.Request) {
		if cl, ok := clientOf(w, r); ok {
			sim.WriteJSON(w, http.StatusOK, map[string]any{"subClientProperties": cl.subclients()})
		}
	}))
	mux.HandleFunc("GET "+apiPath+"/Job", guard(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("jobFilter") != "Backup" {
			sim.WriteJSON(w, http.StatusBadRequest, map[string]any{"errorMessage": "jobFilter must be Backup here", "provenance": sim.Provenance})
			return
		}
		if cl, ok := clientOf(w, r); ok {
			jobs := cl.jobs()
			sim.WriteJSON(w, http.StatusOK, map[string]any{"totalRecordsWithoutPaging": len(jobs), "jobs": jobs})
		}
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
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
		// The collector keys the CommServe by the host it dialled; against the real product that is the CommServe's name.
		Aliases: map[string]string{strings.ToLower(ep.Host): v.host},
	}
	backupsim.Expect(&run, v.policies)
	return []sim.Run{run}
}

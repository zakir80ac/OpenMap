// REQ-QA-005 REQ-CMDB-022 — simulated Salesforce: the OAuth 2.0 client-credentials flow at /services/oauth2/token
// (instance_url, id, signature, issued_at) and the REST API v60.0 query resource. The SOQL is parsed (SELECT
// field list or COUNT(), FROM Organization, UserLicense or User, an optional WHERE field = value), every selected
// field is checked against the object, and record lists page by the Sforce-Query-Options batchSize (default
// 2000) with done=false and a nextRecordsUrl query locator, as the real query resource does.
package saas

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	sfAPIVersion    = "v60.0"
	sfDefaultBatch  = 2000
	sfMinBatch      = 200
	sfInstanceRange = 60
	sfLocatorPrefix = "01g"
)

var soqlPattern = regexp.MustCompile(`(?i)^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*=\s*'?([\w.@-]+)'?)?\s*$`)

func sfErrors(w http.ResponseWriter, status int, code, message string) {
	sim.WriteJSON(w, status, []any{map[string]string{"message": message, "errorCode": code}})
}

type soqlQuery struct {
	object, whereField, whereValue string
	fields                         []string
	count                          bool
}

func salesforceHandler(env *sim.Env, t *Tenant) http.Handler {
	token := env.Token("salesforce-" + t.TenantID)
	userID := salesforceID18("005" + pick("sf-user", alnumMixed, sfBodyLen))
	instance := t.Region + strconv.Itoa(intIn("sf-instance", [2]int{1, sfInstanceRange}))
	objects := map[string]func() []map[string]any{
		"Organization": func() []map[string]any {
			return []map[string]any{{"Id": t.TenantID, "Name": displayName, "OrganizationType": t.Edition + " Edition", "InstanceName": instance, "IsSandbox": false, "PrimaryContact": "IT Administration", "Country": countryCode}}
		},
		"UserLicense": func() []map[string]any {
			var out []map[string]any
			for _, p := range t.Products {
				status := "Active"
				if p.Expired {
					status = "Disabled"
				}
				out = append(out, map[string]any{"Id": salesforceID18("100" + pick("license|"+p.SKU, alnumMixed, sfBodyLen)), "Name": p.Name, "MasterLabel": p.Name,
					"LicenseDefinitionKey": p.SKU, "TotalLicenses": p.Seats, "UsedLicenses": p.Assigned, "Status": status})
			}
			return out
		},
		"User": func() []map[string]any {
			out := make([]map[string]any, 0, t.Users)
			for i := 0; i < t.Users; i++ {
				n := strconv.Itoa(i + 1)
				out = append(out, map[string]any{"Id": salesforceID18("005" + pick("user|"+n, alnumMixed, sfBodyLen)), "Username": "user" + n + "@" + domain, "Name": "User " + n, "IsActive": i < t.Active})
			}
			return out
		},
	}
	var mu sync.Mutex
	locators := map[string][]map[string]any{}

	// respond writes one batch of rendered records starting at offset, registering a locator for the rest.
	respond := func(w http.ResponseWriter, r *http.Request, records []map[string]any, offset int) {
		batch := sfDefaultBatch
		if opt := r.Header.Get("Sforce-Query-Options"); opt != "" {
			if v, ok := strings.CutPrefix(strings.TrimSpace(opt), "batchSize="); ok {
				if n, err := strconv.Atoi(v); err == nil && n >= sfMinBatch && n <= sfDefaultBatch {
					batch = n
				}
			}
		}
		end := min(offset+batch, len(records))
		body := map[string]any{"totalSize": len(records), "done": end >= len(records), "records": records[offset:end]}
		if end < len(records) {
			loc := sfLocatorPrefix + hexOf("locator|" + r.URL.RawQuery + strconv.Itoa(len(records)))[:sfBodyLen]
			mu.Lock()
			locators[loc] = records
			mu.Unlock()
			body["nextRecordsUrl"] = "/services/data/" + sfAPIVersion + "/query/" + loc + "-" + strconv.Itoa(end)
		}
		sim.WriteJSON(w, http.StatusOK, body)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /services/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.PostForm.Get("grant_type") != "client_credentials" {
			oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "grant type not supported")
			return
		}
		if r.PostForm.Get("client_id") != env.User || r.PostForm.Get("client_secret") != env.Secret {
			oauthError(w, http.StatusBadRequest, "invalid_client", "invalid client credentials")
			return
		}
		issued := strconv.FormatInt(time.Now().UnixMilli(), 10)
		id := absolute(r, "/id/"+t.TenantID+"/"+userID)
		mac := hmac.New(sha256.New, []byte(env.Secret))
		mac.Write([]byte(id + issued))
		sim.WriteJSON(w, http.StatusOK, map[string]any{"access_token": token, "signature": base64.StdEncoding.EncodeToString(mac.Sum(nil)), "scope": "api",
			"instance_url": absolute(r, ""), "id": id, "token_type": "Bearer", "issued_at": issued})
	})
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !sim.BearerOK(r, token) {
				sfErrors(w, http.StatusUnauthorized, "INVALID_SESSION_ID", "Session expired or invalid")
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /services/data/"+sfAPIVersion+"/query", authed(func(w http.ResponseWriter, r *http.Request) {
		q, problem := parseSOQL(r.URL.Query().Get("q"))
		if problem != "" {
			sfErrors(w, http.StatusBadRequest, "MALFORMED_QUERY", problem)
			return
		}
		source, ok := objects[q.object]
		if !ok {
			sfErrors(w, http.StatusBadRequest, "INVALID_TYPE", "sObject type '"+q.object+"' is not supported.")
			return
		}
		all := source()
		var kept []map[string]any
		for _, rec := range all {
			if q.whereField != "" {
				v, has := rec[q.whereField]
				if !has {
					sfErrors(w, http.StatusBadRequest, "INVALID_FIELD", "No such column '"+q.whereField+"' on entity '"+q.object+"'.")
					return
				}
				if !strings.EqualFold(stringOf(v), q.whereValue) {
					continue
				}
			}
			kept = append(kept, rec)
		}
		if q.count {
			sim.WriteJSON(w, http.StatusOK, map[string]any{"totalSize": len(kept), "done": true, "records": []any{}})
			return
		}
		selected := make([]map[string]any, 0, len(kept))
		for _, rec := range kept {
			id, _ := rec["Id"].(string)
			doc := map[string]any{"attributes": map[string]string{"type": q.object, "url": "/services/data/" + sfAPIVersion + "/sobjects/" + q.object + "/" + id}}
			for _, f := range q.fields {
				v, has := rec[f]
				if !has {
					sfErrors(w, http.StatusBadRequest, "INVALID_FIELD", "No such column '"+f+"' on entity '"+q.object+"'.")
					return
				}
				doc[f] = v
			}
			selected = append(selected, doc)
		}
		respond(w, r, selected, 0)
	}))
	mux.HandleFunc("GET /services/data/"+sfAPIVersion+"/query/{locator}", authed(func(w http.ResponseWriter, r *http.Request) {
		loc, off, ok := strings.Cut(r.PathValue("locator"), "-")
		offset, err := strconv.Atoi(off)
		mu.Lock()
		records, known := locators[loc]
		mu.Unlock()
		if !ok || err != nil || !known || offset < 0 || offset > len(records) {
			sfErrors(w, http.StatusBadRequest, "INVALID_QUERY_LOCATOR", "invalid query locator")
			return
		}
		respond(w, r, records, offset)
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		sfErrors(w, http.StatusNotFound, "NOT_FOUND", "The requested resource does not exist")
	})
	return mux
}

func stringOf(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case int:
		return strconv.Itoa(x)
	}
	return ""
}

func parseSOQL(s string) (soqlQuery, string) {
	m := soqlPattern.FindStringSubmatch(s)
	if m == nil {
		return soqlQuery{}, "unexpected token in query: " + s
	}
	q := soqlQuery{object: m[2], whereField: m[3], whereValue: m[4]}
	if strings.EqualFold(strings.ReplaceAll(m[1], " ", ""), "COUNT()") {
		q.count = true
		return q, ""
	}
	for _, f := range strings.Split(m[1], ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			return soqlQuery{}, "unexpected token: ','"
		}
		q.fields = append(q.fields, f)
	}
	return q, ""
}

// REQ-QA-005 REQ-CMDB-022 — simulated ServiceNow instance: basic authentication (the collector's password
// credential), the Table API (/api/now/table/{table}) with encoded queries (field=value, field!=value,
// fieldINa,b joined by ^), sysparm_fields, sysparm_limit/sysparm_offset paging with X-Total-Count and Link
// headers, and the Aggregate (Stats) API (/api/now/stats/{table}?sysparm_count=true). Every value is a string,
// as the Table API returns it. Tables: sys_properties, sys_user and license_details.
package saas

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	snowDefaultLimit = 10000
	// snowBuild is the instance's release build (glide.war / glide.buildtag).
	snowBuild = "glide-yokohama-12-18-2024__patch4-05-14-2025"
)

func snowError(w http.ResponseWriter, status int, message, detail string) {
	sim.WriteJSON(w, status, map[string]any{"error": map[string]string{"message": message, "detail": detail}, "status": "failure"})
}

// snowMatch evaluates an encoded query against one record.
func snowMatch(query string, rec map[string]string) (bool, bool) {
	if query == "" {
		return true, true
	}
	for _, cond := range strings.Split(query, "^") {
		switch {
		case strings.Contains(cond, "!="):
			f, v, _ := strings.Cut(cond, "!=")
			val, ok := rec[f]
			if !ok {
				return false, false
			}
			if val == v {
				return false, true
			}
		case strings.Contains(cond, "="):
			f, v, _ := strings.Cut(cond, "=")
			val, ok := rec[f]
			if !ok {
				return false, false
			}
			if val != v {
				return false, true
			}
		case strings.Contains(cond, "IN"):
			f, list, _ := strings.Cut(cond, "IN")
			val, ok := rec[f]
			if !ok {
				return false, false
			}
			found := false
			for _, v := range strings.Split(list, ",") {
				if v == val {
					found = true
				}
			}
			if !found {
				return false, true
			}
		default:
			return false, false
		}
	}
	return true, true
}

func serviceNowHandler(env *sim.Env, t *Tenant) http.Handler {
	tables := map[string][]map[string]string{
		"sys_properties": {
			{"sys_id": hexOf("prop|instance_name")[:32], "name": "instance_name", "value": instanceName},
			{"sys_id": hexOf("prop|glide.war")[:32], "name": "glide.war", "value": snowBuild + ".zip"},
			{"sys_id": hexOf("prop|glide.buildtag")[:32], "name": "glide.buildtag", "value": snowBuild},
			{"sys_id": hexOf("prop|glide.installation.production")[:32], "name": "glide.installation.production", "value": "true"},
		},
	}
	for i := 0; i < t.Users; i++ {
		n := strconv.Itoa(i + 1)
		tables["sys_user"] = append(tables["sys_user"], map[string]string{"sys_id": hexOf("user|" + n)[:32], "user_name": "user" + n, "email": "user" + n + "@" + domain, "active": strconv.FormatBool(i < t.Active)})
	}
	for _, p := range t.Products {
		state := "active"
		if p.Expired {
			state = "expired"
		}
		tables["license_details"] = append(tables["license_details"], map[string]string{"sys_id": hexOf("licence|" + p.SKU)[:32], "name": p.Name, "license_key": p.SKU,
			"purchased_count": strconv.Itoa(p.Seats), "allocated_count": strconv.Itoa(p.Assigned), "state": state, "start_date": dateOnly(p.Start), "end_date": dateOnly(p.End)})
	}
	filter := func(w http.ResponseWriter, table, query string) ([]map[string]string, bool) {
		rows, ok := tables[table]
		if !ok {
			snowError(w, http.StatusBadRequest, "Invalid table "+table, "")
			return nil, false
		}
		var out []map[string]string
		for _, rec := range rows {
			keep, valid := snowMatch(query, rec)
			if !valid {
				snowError(w, http.StatusBadRequest, "Invalid query", "sysparm_query: "+query)
				return nil, false
			}
			if keep {
				out = append(out, rec)
			}
		}
		return out, true
	}
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !env.BasicOK(r) {
				w.Header().Set("WWW-Authenticate", `BASIC realm="Service-now"`)
				snowError(w, http.StatusUnauthorized, "User Not Authenticated", "Required to provide Auth information")
				return
			}
			h(w, r)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/now/table/{table}", authed(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		rows, ok := filter(w, r.PathValue("table"), q.Get("sysparm_query"))
		if !ok {
			return
		}
		limit, offset := snowDefaultLimit, 0
		if s := q.Get("sysparm_limit"); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n > 0 {
				limit = n
			}
		}
		if s := q.Get("sysparm_offset"); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n >= 0 {
				offset = min(n, len(rows))
			}
		}
		var fields []string
		if s := q.Get("sysparm_fields"); s != "" {
			fields = strings.Split(s, ",")
		}
		end := min(offset+limit, len(rows))
		result := make([]map[string]string, 0, end-offset)
		for _, rec := range rows[offset:end] {
			if fields == nil {
				result = append(result, rec)
				continue
			}
			doc := map[string]string{}
			for _, f := range fields {
				doc[f] = rec[f]
			}
			result = append(result, doc)
		}
		w.Header().Set("X-Total-Count", strconv.Itoa(len(rows)))
		link := func(off int, rel string) string {
			v := url.Values{}
			for k, vals := range q {
				v[k] = vals
			}
			v.Set("sysparm_limit", strconv.Itoa(limit))
			v.Set("sysparm_offset", strconv.Itoa(off))
			return "<" + absolute(r, r.URL.Path) + "?" + v.Encode() + `>;rel="` + rel + `"`
		}
		links := []string{link(0, "first")}
		if end < len(rows) {
			links = append(links, link(end, "next"))
		}
		if offset > 0 {
			links = append(links, link(max(0, offset-limit), "prev"))
		}
		last := 0
		if len(rows) > 0 {
			last = (len(rows) - 1) / limit * limit
		}
		links = append(links, link(last, "last"))
		w.Header().Set("Link", strings.Join(links, ","))
		sim.WriteJSON(w, http.StatusOK, map[string]any{"result": result})
	}))
	mux.HandleFunc("GET /api/now/stats/{table}", authed(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		rows, ok := filter(w, r.PathValue("table"), q.Get("sysparm_query"))
		if !ok {
			return
		}
		stats := map[string]string{}
		if q.Get("sysparm_count") == "true" {
			stats["count"] = strconv.Itoa(len(rows))
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"result": map[string]any{"stats": stats}})
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		snowError(w, http.StatusBadRequest, "Requested URI does not represent any resource", r.URL.Path)
	})
	return mux
}

// REQ-QA-005 REQ-CMDB-022 — simulated Workday REST API: a per-tenant OAuth 2.0 token endpoint
// (/ccx/oauth2/{tenant}/token, client credentials in the form or as HTTP Basic) and the workers resource
// (/ccx/api/v1/{tenant}/workers) with limit (1..100, default 20) and offset paging and the total count.
package saas

import (
	"net/http"
	"strconv"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	workdayDefaultLimit = 20
	workdayMaxLimit     = 100
)

func workdayHandler(env *sim.Env, t *Tenant) http.Handler {
	token := env.Token("workday-" + t.TenantID)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ccx/oauth2/{tenant}/token", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("tenant") != t.TenantID {
			oauthError(w, http.StatusNotFound, "invalid_request", "unknown tenant")
			return
		}
		if err := r.ParseForm(); err != nil || r.PostForm.Get("grant_type") != "client_credentials" {
			oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "grant type not supported")
			return
		}
		id, secret, basic := r.BasicAuth()
		if !basic {
			id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
		}
		if id != env.User || secret != env.Secret {
			oauthError(w, http.StatusUnauthorized, "invalid_client", "Invalid client credentials")
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"access_token": token, "token_type": "Bearer"})
	})
	mux.HandleFunc("GET /ccx/api/v1/{tenant}/workers", func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, token) {
			sim.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid access token"})
			return
		}
		if r.PathValue("tenant") != t.TenantID {
			sim.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "invalid resource or tenant"})
			return
		}
		q := r.URL.Query()
		limit, offset := workdayDefaultLimit, 0
		if s := q.Get("limit"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 1 || n > workdayMaxLimit {
				sim.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be between 1 and 100"})
				return
			}
			limit = n
		}
		if s := q.Get("offset"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 0 {
				sim.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid offset"})
				return
			}
			offset = min(n, t.Users)
		}
		end := min(offset+limit, t.Users)
		data := make([]any, 0, end-offset)
		for i := offset; i < end; i++ {
			n := strconv.Itoa(i + 1)
			id := hexOf("worker|" + n)[:32]
			data = append(data, map[string]any{"id": id, "descriptor": "Worker " + n, "href": absolute(r, "/ccx/api/v1/"+t.TenantID+"/workers/"+id),
				"primaryWorkEmail": "worker" + n + "@" + domain, "isManager": i%workdayMaxLimit == 0})
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"total": t.Users, "data": data})
	})
	return mux
}

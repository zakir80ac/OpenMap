// REQ-QA-005 REQ-CMDB-022 — simulated Microsoft Entra ID token endpoint (v2.0 client credentials) and Microsoft
// Graph v1.0: organization, subscribedSkus, directory/subscriptions (companySubscription terms), and users,
// servicePrincipals and applications with $top/$skiptoken paging, @odata.nextLink, and $count, which Graph
// only honours on directory objects with the ConsistencyLevel: eventual header (advanced query).
package saas

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	graphDefaultTop = 100
	graphMaxTop     = 999
	skipPrefix      = "RFNwdAoAAQ"
	tokenLifetime   = 3599
	// managedIdentities is how many non-Application service principals the tenant also holds, so the
	// collector's servicePrincipalType filter matters.
	managedIdentityRange = 9
)

func graphError(w http.ResponseWriter, status int, code, message string) {
	sim.WriteJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "innerError": map[string]string{"provenance": sim.Provenance}}})
}

func oauthError(w http.ResponseWriter, status int, code, description string) {
	sim.WriteJSON(w, status, map[string]string{"error": code, "error_description": description})
}

func absolute(r *http.Request, path string) string { return "https://" + r.Host + path }

type graphLister struct {
	total int
	item  func(i int) map[string]any
	// keep filters the collection by the $filter value; nil means the collection supports no $filter.
	keep func(filter string, item map[string]any) (bool, bool)
}

// serveList answers a Graph collection request with $top, $skiptoken, $count and $filter.
func serveList(w http.ResponseWriter, r *http.Request, l graphLister) {
	q := r.URL.Query()
	count := q.Get("$count") == "true"
	filter := q.Get("$filter")
	if count && r.Header.Get("ConsistencyLevel") != "eventual" {
		graphError(w, http.StatusBadRequest, "Request_BadRequest", "$count is only supported with the ConsistencyLevel header set to eventual (advanced query).")
		return
	}
	top := graphDefaultTop
	if s := q.Get("$top"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > graphMaxTop {
			graphError(w, http.StatusBadRequest, "Request_BadRequest", "Invalid page size specified: '"+s+"'. Must be between 1 and 999 inclusive.")
			return
		}
		top = n
	}
	var all []map[string]any
	for i := 0; i < l.total; i++ {
		it := l.item(i)
		if filter != "" {
			if l.keep == nil {
				graphError(w, http.StatusBadRequest, "Request_UnsupportedQuery", "Unsupported query.")
				return
			}
			ok, valid := l.keep(filter, it)
			if !valid {
				graphError(w, http.StatusBadRequest, "Request_UnsupportedQuery", "Unsupported or invalid query filter clause specified: "+filter)
				return
			}
			if !ok {
				continue
			}
		}
		all = append(all, it)
	}
	offset := 0
	if s := q.Get("$skiptoken"); s != "" {
		n, err := strconv.Atoi(strings.TrimPrefix(s, skipPrefix))
		if err != nil || n < 0 || n > len(all) {
			graphError(w, http.StatusBadRequest, "Request_BadRequest", "Invalid skip token.")
			return
		}
		offset = n
	}
	end := min(offset+top, len(all))
	body := map[string]any{"@odata.context": absolute(r, "/v1.0/$metadata#"+strings.TrimPrefix(r.URL.Path, "/v1.0/")), "value": all[offset:end]}
	if count {
		body["@odata.count"] = len(all)
	}
	if end < len(all) {
		next := url.Values{}
		for k, v := range q {
			next[k] = v
		}
		next.Set("$skiptoken", skipPrefix+strconv.Itoa(end))
		body["@odata.nextLink"] = absolute(r, r.URL.Path) + "?" + next.Encode()
	}
	sim.WriteJSON(w, http.StatusOK, body)
}

func graphHandler(env *sim.Env, t *Tenant) http.Handler {
	token := env.Token("graph-" + t.TenantID)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /{tenant}/oauth2/v2.0/token", func(w http.ResponseWriter, r *http.Request) {
		if tn := r.PathValue("tenant"); tn != t.TenantID && tn != domain {
			oauthError(w, http.StatusBadRequest, "invalid_request", "AADSTS90002: Tenant '"+tn+"' not found.")
			return
		}
		if err := r.ParseForm(); err != nil {
			oauthError(w, http.StatusBadRequest, "invalid_request", "AADSTS900144: The request body must contain the parameter grant_type.")
			return
		}
		if r.PostForm.Get("grant_type") != "client_credentials" {
			oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "AADSTS70003: The app requested an unsupported grant type.")
			return
		}
		if r.PostForm.Get("client_id") != env.User {
			oauthError(w, http.StatusBadRequest, "unauthorized_client", "AADSTS700016: Application with identifier '"+r.PostForm.Get("client_id")+"' was not found in the directory.")
			return
		}
		if r.PostForm.Get("client_secret") != env.Secret {
			oauthError(w, http.StatusUnauthorized, "invalid_client", "AADSTS7000215: Invalid client secret provided.")
			return
		}
		if r.PostForm.Get("scope") != graphScope {
			oauthError(w, http.StatusBadRequest, "invalid_scope", "AADSTS1002012: The provided value for scope is not valid. Client credential flows must have a scope value with /.default suffixed to the resource identifier.")
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"token_type": "Bearer", "expires_in": tokenLifetime, "ext_expires_in": tokenLifetime, "access_token": token})
	})
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !sim.BearerOK(r, token) {
				graphError(w, http.StatusUnauthorized, "InvalidAuthenticationToken", "Access token validation failure. Invalid audience.")
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /v1.0/organization", authed(func(w http.ResponseWriter, r *http.Request) {
		sim.WriteJSON(w, http.StatusOK, map[string]any{"@odata.context": absolute(r, "/v1.0/$metadata#organization"), "value": []any{map[string]any{
			"id": t.TenantID, "displayName": displayName, "tenantType": "AAD", "countryLetterCode": countryCode, "preferredLanguage": "en",
			"verifiedDomains": []any{
				map[string]any{"name": domain, "isDefault": true, "isInitial": false, "type": "Managed", "capabilities": "Email, OfficeCommunicationsOnline"},
				map[string]any{"name": instanceName + ".onmicrosoft.com", "isDefault": false, "isInitial": true, "type": "Managed", "capabilities": "Email, OfficeCommunicationsOnline"},
			},
			"assignedPlans": []any{},
		}}})
	}))
	mux.HandleFunc("GET /v1.0/subscribedSkus", authed(func(w http.ResponseWriter, r *http.Request) {
		var skus []any
		for _, p := range t.Products {
			status, enabled, warning := "Enabled", p.Seats, 0
			if p.Expired {
				status, enabled, warning = "Warning", 0, p.Seats
			}
			skus = append(skus, map[string]any{
				"accountId": t.TenantID, "accountName": displayName, "appliesTo": "User", "capabilityStatus": status, "consumedUnits": p.Assigned,
				"id": t.TenantID + "_" + guid("sku|"+p.SKU), "skuId": guid("sku|" + p.SKU), "skuPartNumber": p.SKU, "subscriptionIds": []string{guid("subscription|" + p.SKU)},
				"prepaidUnits": map[string]int{"enabled": enabled, "suspended": 0, "warning": warning, "lockedOut": 0}, "servicePlans": []any{},
			})
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"@odata.context": absolute(r, "/v1.0/$metadata#subscribedSkus"), "value": skus})
	}))
	mux.HandleFunc("GET /v1.0/directory/subscriptions", authed(func(w http.ResponseWriter, r *http.Request) {
		var subs []any
		for _, p := range t.Products {
			// nextLifecycleDateTime is when the subscription moves to its next state if not renewed: the term
			// end while Enabled, the end of the 30-day grace while Warning.
			status, next := "Enabled", p.End
			if p.Expired {
				status, next = "Warning", p.End.Add(graceDays*day)
			}
			subs = append(subs, map[string]any{
				"id": guid("subscription|" + p.SKU), "commerceSubscriptionId": guid("commerce|" + p.SKU), "skuId": guid("sku|" + p.SKU), "skuPartNumber": p.SKU,
				"status": status, "totalLicenses": p.Seats, "isTrial": false, "ownerType": "Tenant",
				"createdDateTime": p.Start.Format(time.RFC3339), "nextLifecycleDateTime": next.Format(time.RFC3339),
			})
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"@odata.context": absolute(r, "/v1.0/$metadata#directory/subscriptions"), "value": subs})
	}))
	mux.HandleFunc("GET /v1.0/users", authed(func(w http.ResponseWriter, r *http.Request) {
		serveList(w, r, graphLister{total: t.Users, item: func(i int) map[string]any {
			n := strconv.Itoa(i + 1)
			return map[string]any{"id": guid("user|" + n), "displayName": "User " + n, "userPrincipalName": "user" + n + "@" + domain, "accountEnabled": i < t.Active}
		}})
	}))
	managed := intIn(t.Provider+"|managed", [2]int{1, managedIdentityRange})
	principal := func(i int) map[string]any {
		n := strconv.Itoa(i + 1)
		kind := "Application"
		if i >= t.SSO {
			kind = "ManagedIdentity"
		}
		return map[string]any{"id": guid("sp|" + n), "appId": guid("app|" + n), "displayName": kind + " " + n, "servicePrincipalType": kind}
	}
	mux.HandleFunc("GET /v1.0/servicePrincipals", authed(func(w http.ResponseWriter, r *http.Request) {
		serveList(w, r, graphLister{total: t.SSO + managed, item: principal, keep: func(filter string, it map[string]any) (bool, bool) {
			want, ok := strings.CutPrefix(filter, "servicePrincipalType eq ")
			if !ok || !strings.HasPrefix(want, "'") || !strings.HasSuffix(want, "'") {
				return false, false
			}
			return it["servicePrincipalType"] == strings.Trim(want, "'"), true
		}})
	}))
	mux.HandleFunc("GET /v1.0/applications", authed(func(w http.ResponseWriter, r *http.Request) {
		serveList(w, r, graphLister{total: t.SSO, item: func(i int) map[string]any {
			n := strconv.Itoa(i + 1)
			return map[string]any{"id": guid("application|" + n), "appId": guid("app|" + n), "displayName": "Application " + n, "signInAudience": "AzureADMyOrg"}
		}})
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		graphError(w, http.StatusNotFound, "Request_ResourceNotFound", "Resource '"+r.URL.Path+"' does not exist.")
	})
	return mux
}

// REQ-QA-005 REQ-CMDB-022 — simulated Google OAuth 2.0 token endpoint for service accounts with domain-wide
// delegation (RFC 7523 JWT bearer: RS256 signature checked against the service account's public key; iss, sub,
// aud, iat/exp and the requested scopes checked as Google does) and the Admin SDK Directory API v1: customer,
// users and groups, with maxResults and opaque pageToken paging, each call gated on its directory scope.
package saas

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	jwtBearerGrant    = "urn:ietf:params:oauth:grant-type:jwt-bearer"
	maxAssertionLife  = time.Hour
	clockSkew         = 5 * time.Minute
	googleUsersMax    = 500
	googleUsersDef    = 100
	googleGroupsMax   = 200
	googlePagePrefix  = "Q2hRS0V"
	googleScopeRoot   = "https://www.googleapis.com/auth/admin.directory."
	googleReadOnly    = ".readonly"
	scopeCustomer     = "customer"
	scopeUser         = "user"
	scopeGroup        = "group"
	googleUserIDBase  = 100000000000000000
	googleGroupIDBase = 200000000000000000
)

func googleError(w http.ResponseWriter, status int, reason, message string) {
	sim.WriteJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": message, "errors": []any{map[string]string{"domain": "global", "reason": reason, "message": message}}}})
}

type jwtClaims struct {
	Iss   string `json:"iss"`
	Sub   string `json:"sub"`
	Aud   string `json:"aud"`
	Scope string `json:"scope"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
}

// verifyAssertion checks the JWT the way Google's token endpoint does and returns its claims, or the
// error_description Google answers with.
func verifyAssertion(assertion string, sa *googleAccount, audience string, now time.Time) (*jwtClaims, string) {
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		return nil, "Invalid JWT: Token must be a short-lived token and in a reasonable timeframe"
	}
	headerJSON, err1 := base64.RawURLEncoding.DecodeString(parts[0])
	claimsJSON, err2 := base64.RawURLEncoding.DecodeString(parts[1])
	sig, err3 := base64.RawURLEncoding.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return nil, "Invalid JWT: malformed segment"
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(headerJSON, &header) != nil || header.Alg != "RS256" {
		return nil, "Invalid JWT: unsupported algorithm"
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(&sa.key.PublicKey, crypto.SHA256, digest[:], sig) != nil {
		return nil, "Invalid JWT Signature."
	}
	var c jwtClaims
	if json.Unmarshal(claimsJSON, &c) != nil {
		return nil, "Invalid JWT: malformed claims"
	}
	iat, exp := time.Unix(c.Iat, 0), time.Unix(c.Exp, 0)
	switch {
	case c.Iss != sa.email:
		return nil, "Invalid JWT: unknown issuer " + c.Iss
	case c.Aud != audience:
		return nil, "Invalid JWT: audience must be " + audience
	case iat.After(now.Add(clockSkew)) || !exp.After(now) || exp.Sub(iat) > maxAssertionLife:
		return nil, "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim."
	case c.Sub == "":
		return nil, "Invalid email or User ID"
	case c.Sub != sa.admin:
		return nil, "Invalid email or User ID"
	}
	return &c, ""
}

func googleHandler(env *sim.Env, t *Tenant, sa *googleAccount) http.Handler {
	var mu sync.Mutex
	grants := map[string]map[string]bool{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.PostForm.Get("grant_type") != jwtBearerGrant {
			oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "Invalid grant_type: "+r.PostForm.Get("grant_type"))
			return
		}
		claims, problem := verifyAssertion(r.PostForm.Get("assertion"), sa, absolute(r, "/token"), time.Now())
		if claims == nil {
			oauthError(w, http.StatusBadRequest, "invalid_grant", problem)
			return
		}
		scopes := map[string]bool{}
		for _, s := range strings.Fields(claims.Scope) {
			name, ok := strings.CutPrefix(s, googleScopeRoot)
			if !ok {
				oauthError(w, http.StatusUnauthorized, "unauthorized_client", "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.")
				return
			}
			scopes[strings.TrimSuffix(name, googleReadOnly)] = true
		}
		if len(scopes) == 0 {
			oauthError(w, http.StatusBadRequest, "invalid_scope", "Empty or missing scope not allowed.")
			return
		}
		token := env.Token("google-" + hexOf(claims.Scope)[:sfChunk*2])
		mu.Lock()
		grants[token] = scopes
		mu.Unlock()
		sim.WriteJSON(w, http.StatusOK, map[string]any{"access_token": token, "expires_in": tokenLifetime, "token_type": "Bearer"})
	})
	authed := func(scope string, h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			mu.Lock()
			granted, known := grants[token]
			mu.Unlock()
			if !ok || !known {
				googleError(w, http.StatusUnauthorized, "authError", "Request had invalid authentication credentials. Expected OAuth 2 access token.")
				return
			}
			if !granted[scope] {
				googleError(w, http.StatusForbidden, "insufficientPermissions", "Request had insufficient authentication scopes.")
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /admin/directory/v1/customers/{customer}", authed(scopeCustomer, func(w http.ResponseWriter, r *http.Request) {
		if c := r.PathValue("customer"); c != "my_customer" && c != t.TenantID {
			googleError(w, http.StatusNotFound, "notFound", "Resource Not Found: customer")
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{
			"kind": "admin#directory#customer", "id": t.TenantID, "etag": `"` + hexOf("etag|" + t.TenantID)[:sfChunk*4] + `"`, "customerDomain": domain,
			"alternateEmail": "it-admin@" + domain, "language": "en", "customerCreationTime": t.Products[0].Start.Format(time.RFC3339),
			"postalAddress": map[string]string{"organizationName": displayName, "countryCode": countryCode},
		})
	}))
	page := func(w http.ResponseWriter, r *http.Request, total, defMax, hardMax int, kind, listKey string, item func(i int) map[string]any) {
		q := r.URL.Query()
		if q.Get("customer") != "my_customer" && q.Get("customer") != t.TenantID && q.Get("domain") != domain {
			googleError(w, http.StatusBadRequest, "badRequest", "Bad Request")
			return
		}
		size := defMax
		if s := q.Get("maxResults"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 1 || n > hardMax {
				googleError(w, http.StatusBadRequest, "invalid", "Invalid value for maxResults")
				return
			}
			size = n
		}
		offset := 0
		if s := q.Get("pageToken"); s != "" {
			n, err := strconv.Atoi(strings.TrimPrefix(s, googlePagePrefix))
			if err != nil || n < 0 || n > total {
				googleError(w, http.StatusBadRequest, "invalid", "Invalid page token")
				return
			}
			offset = n
		}
		end := min(offset+size, total)
		items := make([]any, 0, end-offset)
		for i := offset; i < end; i++ {
			items = append(items, item(i))
		}
		body := map[string]any{"kind": kind, "etag": `"` + hexOf(kind)[:sfChunk*4] + `"`, listKey: items}
		if end < total {
			body["nextPageToken"] = googlePagePrefix + strconv.Itoa(end)
		}
		sim.WriteJSON(w, http.StatusOK, body)
	}
	mux.HandleFunc("GET /admin/directory/v1/users", authed(scopeUser, func(w http.ResponseWriter, r *http.Request) {
		page(w, r, t.Users, googleUsersDef, googleUsersMax, "admin#directory#users", "users", func(i int) map[string]any {
			n := strconv.Itoa(i + 1)
			return map[string]any{"kind": "admin#directory#user", "id": strconv.Itoa(googleUserIDBase + i), "primaryEmail": "user" + n + "@" + domain,
				"name": map[string]string{"fullName": "User " + n}, "isAdmin": i == 0, "suspended": i >= t.Active, "orgUnitPath": "/", "customerId": t.TenantID}
		})
	}))
	mux.HandleFunc("GET /admin/directory/v1/groups", authed(scopeGroup, func(w http.ResponseWriter, r *http.Request) {
		page(w, r, t.Groups, googleGroupsMax, googleGroupsMax, "admin#directory#groups", "groups", func(i int) map[string]any {
			n := strconv.Itoa(i + 1)
			return map[string]any{"kind": "admin#directory#group", "id": strconv.Itoa(googleGroupIDBase + i), "email": "group" + n + "@" + domain, "name": "Group " + n}
		})
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		googleError(w, http.StatusNotFound, "notFound", "Not Found")
	})
	return mux
}

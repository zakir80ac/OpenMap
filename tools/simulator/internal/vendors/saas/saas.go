// REQ-QA-005 REQ-CMDB-022 — simulated SaaS tenants for the saas collector: one HTTPS listener per provider, each
// with its real auth flow and paging. Microsoft 365 (Entra v2.0 client-credentials token; Graph organization,
// subscribedSkus, directory/subscriptions, users/servicePrincipals/applications with $count under
// ConsistencyLevel: eventual, $top and @odata.nextLink), Google Workspace (service-account JWT with domain-wide
// delegation, RS256 signature, issuer, subject, audience, lifetime and scopes verified at the token endpoint;
// Directory API customer, users and groups with maxResults/pageToken), Salesforce (OAuth client credentials;
// SOQL query endpoint parsing the SELECT, with batchSize and nextRecordsUrl), ServiceNow (basic auth; Table API
// with encoded queries, sysparm_fields, sysparm_limit/sysparm_offset, X-Total-Count and Link headers; Stats API)
// and Workday (client-credentials token per tenant; workers with limit/offset and total).
//
// The estate in packages/testing/fixtures/synth-small predates the synthetic estate's SaaS layer, so the
// tenants are built here, deterministically (hash-seeded, identical on every run), mirroring
// tools/synth-estate/src/gen/saas.ts: the same five vendors, editions, regions, products and SKUs, seat and
// assignment ranges, active-user share, SSO-application and group ranges, and 365-day terms ending at the same
// offsets from the estate epoch (2026-10-01), one lapsed. Two deliberate differences from the generator: tenant
// ids are shaped as each vendor issues them (Entra GUID, Google customer id, 18-character Salesforce org id,
// ServiceNow instance and Workday tenant names) where the generator uses a UUID for all five, which no
// Google, Salesforce, ServiceNow or Workday tenant can have; and the collector names each tenant by the
// organisation display name the vendor API returns ("Horizon Bank", or the instance or tenant name), where
// the generator names it "<vendor> <edition>". Expectations carry the mirror's identities, so identity drift
// between this SaaS layer and what the collector emits is reported (Microsoft 365 products are named by SKU
// part number, Google Workspace and Workday products by the collector's fixed product name).
package saas

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	providerM365       = "microsoft365"
	providerGoogle     = "google_workspace"
	providerSalesforce = "salesforce"
	providerServiceNow = "servicenow"
	providerWorkday    = "workday"

	displayName = "Horizon Bank"
	domain      = "horizonbank.example"
	// instanceName is the ServiceNow instance and Workday tenant name of the bank.
	instanceName = "horizonbank"
	// countryCode follows the estate organisation's time zone (Asia/Riyadh).
	countryCode = "SA"
	seedPrefix  = "openmap-sim-saas|"
	termDays    = 365
	// graceDays is Microsoft's 30-day Warning state after a subscription lapses (then Suspended).
	graceDays = 30
	rsaBits   = 2048
	day       = 24 * time.Hour

	googleCollectorProduct  = "Google Workspace"
	workdayCollectorProduct = "Workday HCM"
)

// estateEpoch is the synthetic estate's observation instant (tools/synth-estate/src/time.ts ESTATE_EPOCH_MS).
var estateEpoch = time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)

type productDef struct {
	name, sku       string
	seats, assigned [2]float64
}

type tenantDef struct {
	provider, vendor, edition, region, dataClass string
	products                                     []productDef
}

// tenantDefs mirror TENANTS in tools/synth-estate/src/gen/saas.ts.
var tenantDefs = []tenantDef{
	{provider: providerM365, vendor: "Microsoft", edition: "Enterprise", region: "EMEA", dataClass: "internal", products: []productDef{
		{name: "Microsoft 365 E3", sku: "SPE_E3", seats: [2]float64{3200, 4200}, assigned: [2]float64{0.86, 0.97}},
		{name: "Microsoft 365 E5", sku: "SPE_E5", seats: [2]float64{300, 600}, assigned: [2]float64{0.55, 0.8}},
		{name: "Power BI Pro", sku: "POWER_BI_PRO", seats: [2]float64{250, 400}, assigned: [2]float64{0.35, 0.6}},
		{name: "Teams Rooms Pro", sku: "MTR_PREM", seats: [2]float64{40, 80}, assigned: [2]float64{0.9, 1}},
	}},
	{provider: providerGoogle, vendor: "Google", edition: "Business Plus", region: "EU", dataClass: "internal", products: []productDef{
		{name: "Google Workspace Business Plus", sku: "Google-Apps-Unlimited", seats: [2]float64{150, 300}, assigned: [2]float64{0.4, 0.7}},
	}},
	{provider: providerSalesforce, vendor: "Salesforce", edition: "Enterprise", region: "EU", dataClass: "customer", products: []productDef{
		{name: "Sales Cloud Enterprise", sku: "SFDC-SALES-EE", seats: [2]float64{350, 500}, assigned: [2]float64{0.8, 0.95}},
		{name: "Service Cloud Enterprise", sku: "SFDC-SERVICE-EE", seats: [2]float64{200, 320}, assigned: [2]float64{0.85, 1}},
	}},
	{provider: providerServiceNow, vendor: "ServiceNow", edition: "ITSM Professional", region: "EMEA", dataClass: "operational", products: []productDef{
		{name: "IT Service Management Professional", sku: "ITSM-PRO-FULFILLER", seats: [2]float64{150, 220}, assigned: [2]float64{0.9, 1}},
	}},
	{provider: providerWorkday, vendor: "Workday", edition: "Enterprise", region: "EU", dataClass: "personal", products: []productDef{
		{name: "Workday Human Capital Management", sku: "WD-HCM", seats: [2]float64{4000, 5200}, assigned: [2]float64{0.92, 0.99}},
	}},
}

var (
	activeShare = [2]float64{0.72, 0.93}
	ssoApps     = [2]int{12, 140}
	groupRange  = [2]int{40, 400}
	// endOffsets are the generator's END_OFFSETS: days from the estate epoch a term ends (one has lapsed).
	endOffsets = []int{-20, 25, 60, 140, 210, 300}
)

// Product is one subscribed product of a tenant.
type Product struct {
	Name, SKU       string
	Seats, Assigned int
	Start, End      time.Time
	Expired         bool
	CI              *estate.CI
}

// Tenant is one simulated SaaS tenant with its estate CIs.
type Tenant struct {
	Provider, Vendor, Edition, Region, TenantID string
	Users, Active, Groups, SSO                  int
	Products                                    []Product
	CI, VendorCI                                *estate.CI
}

func frac(key string) float64 {
	sum := sha256.Sum256([]byte(seedPrefix + key))
	return float64(binary.BigEndian.Uint64(sum[:8])>>11) / float64(uint64(1)<<53)
}

func between(key string, r [2]float64) float64 { return r[0] + frac(key)*(r[1]-r[0]) }

func intIn(key string, r [2]int) int { return r[0] + int(frac(key)*float64(r[1]-r[0]+1)) }

func hexOf(key string) string {
	sum := sha256.Sum256([]byte(seedPrefix + key))
	return hex.EncodeToString(sum[:])
}

func guid(key string) string {
	h := hexOf(key)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

const (
	alnumLower = "abcdefghijklmnopqrstuvwxyz0123456789"
	alnumMixed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	// sfChecksum is the alphabet of Salesforce's three-character case-safe id suffix.
	sfChecksum     = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
	sfChunk        = 5
	sfBodyLen      = 12
	googleIDLen    = 7
	sfOrgPrefix    = "00D"
	googleIDPrefix = "C0"
)

func pick(key, alphabet string, n int) string {
	sum := sha256.Sum256([]byte(seedPrefix + key))
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteByte(alphabet[int(sum[i])%len(alphabet)])
	}
	return b.String()
}

// salesforceID18 appends the case-safe checksum to a 15-character Salesforce id.
func salesforceID18(id15 string) string {
	var b strings.Builder
	b.WriteString(id15)
	for c := 0; c < len(id15)/sfChunk; c++ {
		bits := 0
		for i := 0; i < sfChunk; i++ {
			if ch := id15[c*sfChunk+i]; ch >= 'A' && ch <= 'Z' {
				bits |= 1 << i
			}
		}
		b.WriteByte(sfChecksum[bits])
	}
	return b.String()
}

func tenantID(provider string) string {
	switch provider {
	case providerM365:
		return guid("tenant|" + provider)
	case providerGoogle:
		return googleIDPrefix + pick("tenant|"+provider, alnumLower, googleIDLen)
	case providerSalesforce:
		return salesforceID18(sfOrgPrefix + pick("tenant|"+provider, alnumMixed, sfBodyLen))
	default:
		return instanceName
	}
}

func dateOnly(t time.Time) string { return t.Format(time.DateOnly) }

// Tenants builds the five tenants (deterministic).
func Tenants() []*Tenant {
	var out []*Tenant
	offset := 0
	for _, d := range tenantDefs {
		k := d.provider + "|"
		users := int(math.Round(between(k+"users", d.products[0].seats)))
		t := &Tenant{Provider: d.provider, Vendor: d.vendor, Edition: d.edition, Region: d.region, TenantID: tenantID(d.provider), Users: users,
			Active: int(math.Round(float64(users) * between(k+"active", activeShare))), Groups: intIn(k+"groups", groupRange), SSO: intIn(k+"sso", ssoApps)}
		t.VendorCI = &estate.CI{Type: "vendor", Identity: map[string]string{"name": d.vendor}, Name: d.vendor, Attributes: map[string]any{"kind": "saas", "source": "saas"}}
		t.CI = &estate.CI{Type: "saas_tenant", Identity: map[string]string{"vendor": d.vendor, "tenantId": t.TenantID}, Name: d.vendor + " " + d.edition, Attributes: map[string]any{
			"vendor": d.vendor, "tenantId": t.TenantID, "displayName": displayName, "domains": []any{domain}, "region": d.region, "edition": d.edition,
			"users": float64(t.Users), "activeUsers": float64(t.Active), "groups": float64(t.Groups), "ssoApplications": float64(t.SSO), "products": float64(len(d.products)),
		}}
		for _, p := range d.products {
			pk := k + p.sku + "|"
			seats := int(math.Round(between(pk+"seats", p.seats)))
			assigned := min(seats, int(math.Round(float64(seats)*between(pk+"assigned", p.assigned))))
			end := endOffsets[offset%len(endOffsets)]
			offset++
			prod := Product{Name: p.name, SKU: p.sku, Seats: seats, Assigned: assigned,
				Start: estateEpoch.Add(time.Duration(end-termDays) * day), End: estateEpoch.Add(time.Duration(end) * day), Expired: end < 0}
			status := "enabled"
			if prod.Expired {
				status = "expired"
			}
			prod.CI = &estate.CI{Type: "saas_application", Identity: map[string]string{"vendor": d.vendor, "product": p.name, "tenantRef": t.TenantID}, Name: p.name, Attributes: map[string]any{
				"vendor": d.vendor, "product": p.name, "sku": p.sku, "seatsTotal": float64(seats), "seatsAssigned": float64(assigned), "status": status,
				"subscriptionStart": dateOnly(prod.Start), "subscriptionEnd": dateOnly(prod.End),
			}}
			t.Products = append(t.Products, prod)
		}
		out = append(out, t)
	}
	return out
}

// collectorTenantName is the tenant name the collector derives from the provider API.
func collectorTenantName(t *Tenant) string {
	switch t.Provider {
	case providerServiceNow, providerWorkday:
		return instanceName
	default:
		return displayName
	}
}

// collectorProductName is the product name the collector emits: Graph's SKU part number, the API's licence
// name for Salesforce and ServiceNow, and the collector's fixed product for Google Workspace and Workday
// (neither API it reads lists licensed products).
func collectorProductName(t *Tenant, p Product) string {
	switch t.Provider {
	case providerM365:
		return p.SKU
	case providerGoogle:
		return googleCollectorProduct
	case providerWorkday:
		return workdayCollectorProduct
	default:
		return p.Name
	}
}

type Vendor struct{}

func (Vendor) ID() string             { return "saas-tenants" }
func (Vendor) Collector() string      { return "saas" }
func (Vendor) Requirements() []string { return []string{"REQ-CMDB-022"} }

func providers() []string {
	out := make([]string, 0, len(tenantDefs))
	for _, d := range tenantDefs {
		out = append(out, d.provider)
	}
	return out
}

// googleAccount is the simulated service account with domain-wide delegation.
type googleAccount struct {
	email, admin string
	key          *rsa.PrivateKey
	keyPEM       string
}

func (Vendor) Start(_ context.Context, _ *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	key, err := rsa.GenerateKey(rand.Reader, rsaBits)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	sa := &googleAccount{email: env.User + "@horizon-bank-sim.iam.gserviceaccount.com", admin: "admin@" + domain, key: key,
		keyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))}
	byProvider := map[string]*Tenant{}
	for _, t := range Tenants() {
		byProvider[t.Provider] = t
	}
	ep, err := sim.ServeEach(env, providers(), true, func(p string) http.Handler {
		t := byProvider[p]
		switch p {
		case providerM365:
			return graphHandler(env, t)
		case providerGoogle:
			return googleHandler(env, t, sa)
		case providerSalesforce:
			return salesforceHandler(env, t)
		case providerServiceNow:
			return serviceNowHandler(env, t)
		default:
			return workdayHandler(env, t)
		}
	})
	if err != nil {
		return nil, err
	}
	ep.State["google"] = sa
	return ep, nil
}

const graphScope = "https://graph.microsoft.com/.default"

// googleScopes are the Directory API read-only scopes the collector's three calls need.
var googleScopes = []string{
	"https://www.googleapis.com/auth/admin.directory.customer.readonly",
	"https://www.googleapis.com/auth/admin.directory.user.readonly",
	"https://www.googleapis.com/auth/admin.directory.group.readonly",
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	sa, _ := ep.State["google"].(*googleAccount)
	var runs []sim.Run
	for _, t := range Tenants() {
		base := ep.Devices[t.Provider]
		opts := map[string]any{"vendor": t.Provider, "apiUrl": base, "verifyTls": true, "caCertPem": env.CA.PEM}
		oauth := &sim.Credential{Type: "oauth_client", Fields: map[string]string{"clientId": env.User, "clientSecret": env.Secret}}
		run := sim.Run{Name: t.Provider, CredentialType: "oauth_client", Credential: oauth}
		switch t.Provider {
		case providerM365:
			opts["tokenUrl"] = base + "/" + t.TenantID + "/oauth2/v2.0/token"
			opts["scope"] = graphScope
			oauth.Fields["tenantId"] = t.TenantID
			run.Targets = []sim.Target{{Kind: "account", Value: domain, Label: "Microsoft 365 (simulated)"}}
		case providerGoogle:
			opts["tokenUrl"] = base + "/token"
			opts["scope"] = strings.Join(googleScopes, " ")
			run.CredentialType = "service_account"
			run.Credential = &sim.Credential{Type: "service_account", Fields: map[string]string{"clientEmail": sa.email, "privateKeyPem": sa.keyPEM, "adminEmail": sa.admin}}
			run.Targets = []sim.Target{{Kind: "account", Value: domain, Label: "Google Workspace (simulated)"}}
		case providerSalesforce:
			opts["tokenUrl"] = base + "/services/oauth2/token"
			run.Targets = []sim.Target{{Kind: "account", Value: instanceName, Label: "Salesforce (simulated)"}}
		case providerServiceNow:
			opts["tenant"] = instanceName
			run.CredentialType = "password"
			run.Credential = &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}}
			run.Targets = []sim.Target{{Kind: "account", Value: instanceName, Label: "ServiceNow (simulated)"}}
		case providerWorkday:
			opts["tokenUrl"] = base + "/ccx/oauth2/" + instanceName + "/token"
			opts["tenant"] = instanceName
			run.Targets = []sim.Target{{Kind: "account", Value: instanceName, Label: "Workday (simulated)"}}
		}
		run.Options = opts
		tenantName := collectorTenantName(t)
		run.Expect.CIs = append(run.Expect.CIs,
			sim.ExpectCI{Type: "vendor", Name: t.Vendor, Identity: t.VendorCI.Identity},
			sim.ExpectCI{Type: "saas_tenant", Name: tenantName, Identity: t.CI.Identity})
		run.Expect.Rel("member_of", "saas_tenant", tenantName, "vendor", t.Vendor)
		for _, p := range t.Products {
			name := collectorProductName(t, p)
			run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: "saas_application", Name: name, Identity: p.CI.Identity})
			run.Expect.Rel("licensed_by", "saas_application", name, "saas_tenant", tenantName)
			run.Expect.Rel("member_of", "saas_application", name, "vendor", t.Vendor)
		}
		runs = append(runs, run)
	}
	return runs
}

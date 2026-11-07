// REQ-CMDB-022 — SaaS asset inventory: one collector with a provider adapter per vendor. Microsoft 365
// (Graph: organization, subscribed SKUs with seats, user and enterprise-app counts), Google Workspace
// (Directory API with a delegated service account: customer, users, groups), Salesforce (OAuth client
// credentials, SOQL: organization, user licences, active users), ServiceNow (Table and Stats APIs:
// instance properties, active users, licence details) and Workday (REST: workers). Each tenant becomes
// a saas_tenant with seat and SSO facts; every licensed product becomes a saas_application; the
// application is licensed_by the tenant and member_of the vendor (the company, named as the vendor catalogue
// names it, so it merges with the supplier record; the adapter key is the provider attribute). Endpoint bases,
// token URLs and scopes are job options because they differ per cloud and region; a private CA bundle
// (caCertPem) pins both the token endpoint and the API; credentials are vault references.
package saas

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/gcp"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "saas"
	version      = "0.1.0"
	evidenceKind = "api_response"
	defaultPort  = 443
	tokenTimeout = 30 * time.Second
	optionVendor = "vendor"
	optionAPI    = "apiUrl"
	optionToken  = "tokenUrl"
	optionScope  = "scope"
	optionTenant = "tenant"
	optionCA     = "caCertPem"
	credClient   = "clientId"
	credSecret   = "clientSecret"
	credTenantID = "tenantId"
	credEmail    = "clientEmail"
	credKey      = "privateKeyPem"
	credAdmin    = "adminEmail"
	credUser     = "username"
	credPassword = "password"

	vendorM365       = "microsoft365"
	vendorGoogle     = "google_workspace"
	vendorSalesforce = "salesforce"
	vendorServiceNow = "servicenow"
	vendorWorkday    = "workday"
	grantJWTBearer   = "urn:ietf:params:oauth:grant-type:jwt-bearer"

	typeTenant      = "saas_tenant"
	typeApplication = "saas_application"
	typeVendor      = "vendor"
	relLicensedBy   = "licensed_by"
	relMemberOf     = "member_of"
	relSecuredBy    = "secured_by"

	graphUsersPage   = 999
	googleUsersPage  = 500
	googleGroupsPage = 200
	soqlVersionPath  = "/services/data/v60.0"
	snowStatsPath    = "/api/now/stats/"
	snowTablePath    = "/api/now/table/"
	workdayPageOne   = 1
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "saas", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"oauth_client", "service_account", "password"},
		TargetKinds: []string{"account"}, Emits: []string{typeTenant, typeApplication, typeVendor},
		ContractVersion: contract.Version,
	}
}

// vendorNames maps each provider adapter to the company the vendor catalogue knows, so the vendor CI the
// collector emits is the same CI as the supplier record (contracts, support, renewals).
var vendorNames = map[string]string{
	vendorM365: "Microsoft", vendorGoogle: "Google", vendorSalesforce: "Salesforce", vendorServiceNow: "ServiceNow", vendorWorkday: "Workday",
}

// Product is one licensed SaaS product (SKU, licence, module) inside a tenant.
type Product struct {
	Name          string
	SKU           string
	SeatsTotal    int64
	SeatsAssigned int64
	Status        string
	// Subscription term as the vendor's commerce API reports it (RFC 3339); empty when the vendor exposes none.
	StartsAt string
	EndsAt   string
}

// Tenant is what one adapter learned about a SaaS tenant.
type Tenant struct {
	Vendor      string
	TenantID    string
	DisplayName string
	Domains     []string
	Region      string
	Edition     string
	Users       int64
	ActiveUsers int64
	Groups      int64
	SSOApps     int64
	Products    []Product
	Facts       map[string]any
	Raw         [][]byte
}

// clientCredentials performs an OAuth 2.0 client-credentials grant and returns the bearer token.
func clientCredentials(ctx context.Context, tokenURL, clientID, secret, scope, caPem string) (string, error) {
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {clientID}, "client_secret": {secret}}
	if scope != "" {
		form.Set("scope", scope)
	}
	return tokenGrant(ctx, tokenURL, form, caPem)
}

// jwtBearer exchanges a signed service-account assertion for a bearer token (RFC 7523).
func jwtBearer(ctx context.Context, tokenURL, assertion, caPem string) (string, error) {
	return tokenGrant(ctx, tokenURL, url.Values{"grant_type": {grantJWTBearer}, "assertion": {assertion}}, caPem)
}

// tokenGrant posts a token request with TLS verified against the system pool or the job's private CA bundle.
func tokenGrant(ctx context.Context, tokenURL string, form url.Values, caPem string) (string, error) {
	transport, err := restjson.TransportFor(true, caPem)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: tokenTimeout, Transport: transport}
	res, err := client.Do(req)
	if err != nil {
		return "", collector.Errorf(contract.ErrUnreachable, true, "token endpoint: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "token endpoint answered %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", collector.Errorf(contract.ErrParse, false, "token endpoint returned no access_token")
	}
	return out.AccessToken, nil
}

// --- Microsoft 365 -------------------------------------------------------------------------------------------------

type graphList[T any] struct {
	Count    int64  `json:"@odata.count"`
	NextLink string `json:"@odata.nextLink"`
	Value    []T    `json:"value"`
}

type graphOrganization struct {
	ID              string `json:"id"`
	DisplayName     string `json:"displayName"`
	TenantType      string `json:"tenantType"`
	VerifiedDomains []struct {
		Name      string `json:"name"`
		IsDefault bool   `json:"isDefault"`
	} `json:"verifiedDomains"`
	AssignedPlans []struct {
		Service          string `json:"service"`
		CapabilityStatus string `json:"capabilityStatus"`
	} `json:"assignedPlans"`
}

// graphSubscription is Microsoft Graph's companySubscription (GET /v1.0/directory/subscriptions): the commercial term
// behind a SKU, with the date the next lifecycle event (renewal or expiry) falls on.
type graphSubscription struct {
	SkuID                 string `json:"skuId"`
	SkuPartNumber         string `json:"skuPartNumber"`
	Status                string `json:"status"`
	CreatedDateTime       string `json:"createdDateTime"`
	NextLifecycleDateTime string `json:"nextLifecycleDateTime"`
	TotalLicenses         int64  `json:"totalLicenses"`
}

type graphSku struct {
	SkuPartNumber string `json:"skuPartNumber"`
	SkuID         string `json:"skuId"`
	ConsumedUnits int64  `json:"consumedUnits"`
	PrepaidUnits  struct {
		Enabled   int64 `json:"enabled"`
		Suspended int64 `json:"suspended"`
		Warning   int64 `json:"warning"`
	} `json:"prepaidUnits"`
	CapabilityStatus string `json:"capabilityStatus"`
}

func microsoft365(ctx context.Context, c *restjson.Client, counting *restjson.Client) (*Tenant, error) {
	var orgs graphList[graphOrganization]
	if err := c.Get(ctx, "/v1.0/organization", &orgs); err != nil {
		return nil, err
	}
	if len(orgs.Value) == 0 {
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "Graph returned no organization")
	}
	org := orgs.Value[0]
	t := &Tenant{Vendor: vendorM365, TenantID: org.ID, DisplayName: org.DisplayName, Edition: org.TenantType, Facts: map[string]any{}}
	for _, d := range org.VerifiedDomains {
		t.Domains = append(t.Domains, d.Name)
	}
	var skus graphList[graphSku]
	if err := c.Get(ctx, "/v1.0/subscribedSkus", &skus); err != nil {
		return nil, err
	}
	for _, s := range skus.Value {
		t.Products = append(t.Products, Product{Name: s.SkuPartNumber, SKU: s.SkuID, SeatsTotal: s.PrepaidUnits.Enabled, SeatsAssigned: s.ConsumedUnits, Status: strings.ToLower(s.CapabilityStatus)})
	}
	// The commercial term per SKU (REQ-CMDB-042): a tenant whose app registration lacks the permission simply has none.
	var terms graphList[graphSubscription]
	if err := c.Get(ctx, "/v1.0/directory/subscriptions", &terms); err == nil {
		for _, term := range terms.Value {
			for i := range t.Products {
				if t.Products[i].SKU == term.SkuID && term.NextLifecycleDateTime != "" {
					t.Products[i].StartsAt = term.CreatedDateTime
					t.Products[i].EndsAt = term.NextLifecycleDateTime
				}
			}
		}
	} else if !restjson.IsNotFound(err) && !restjson.IsForbidden(err) {
		return nil, err
	}
	// $count needs ConsistencyLevel: eventual, which the counting client carries.
	var users graphList[json.RawMessage]
	if err := counting.Get(ctx, "/v1.0/users?$count=true&$top=1", &users); err == nil {
		t.Users = users.Count
	} else if !restjson.IsNotFound(err) {
		return nil, err
	}
	var apps graphList[json.RawMessage]
	if err := counting.Get(ctx, "/v1.0/servicePrincipals?$count=true&$top=1&$filter=servicePrincipalType%20eq%20'Application'", &apps); err == nil {
		t.SSOApps = apps.Count
	} else if !restjson.IsNotFound(err) {
		return nil, err
	}
	t.Raw = append(c.Raw(), counting.Raw()...)
	return t, nil
}

// --- Google Workspace ----------------------------------------------------------------------------------------------

type googleCustomer struct {
	ID             string `json:"id"`
	CustomerDomain string `json:"customerDomain"`
	Language       string `json:"language"`
	PostalAddress  struct {
		OrganizationName string `json:"organizationName"`
		CountryCode      string `json:"countryCode"`
	} `json:"postalAddress"`
}

func googleWorkspace(ctx context.Context, c *restjson.Client) (*Tenant, error) {
	var cust googleCustomer
	if err := c.Get(ctx, "/admin/directory/v1/customers/my_customer", &cust); err != nil {
		return nil, err
	}
	t := &Tenant{Vendor: vendorGoogle, TenantID: cust.ID, DisplayName: firstNonEmpty(cust.PostalAddress.OrganizationName, cust.CustomerDomain), Domains: []string{cust.CustomerDomain}, Region: cust.PostalAddress.CountryCode, Facts: map[string]any{"language": cust.Language}}
	pageToken := ""
	for {
		q := "?customer=my_customer&maxResults=" + strconv.Itoa(googleUsersPage) + "&projection=basic"
		if pageToken != "" {
			q += "&pageToken=" + url.QueryEscape(pageToken)
		}
		var page struct {
			Users []struct {
				Suspended bool `json:"suspended"`
			} `json:"users"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := c.Get(ctx, "/admin/directory/v1/users"+q, &page); err != nil {
			return nil, err
		}
		for _, u := range page.Users {
			t.Users++
			if !u.Suspended {
				t.ActiveUsers++
			}
		}
		if page.NextPageToken == "" {
			break
		}
		pageToken = page.NextPageToken
	}
	// Groups page like users: a customer with more groups than one page holds is counted in full.
	pageToken = ""
	for {
		q := "?customer=my_customer&maxResults=" + strconv.Itoa(googleGroupsPage)
		if pageToken != "" {
			q += "&pageToken=" + url.QueryEscape(pageToken)
		}
		var page struct {
			Groups        []json.RawMessage `json:"groups"`
			NextPageToken string            `json:"nextPageToken"`
		}
		if err := c.Get(ctx, "/admin/directory/v1/groups"+q, &page); err != nil {
			if restjson.IsNotFound(err) {
				break
			}
			return nil, err
		}
		t.Groups += int64(len(page.Groups))
		if page.NextPageToken == "" {
			break
		}
		pageToken = page.NextPageToken
	}
	t.Products = []Product{{Name: "Google Workspace", SKU: "workspace", SeatsTotal: t.Users, SeatsAssigned: t.ActiveUsers, Status: "enabled"}}
	t.Raw = c.Raw()
	return t, nil
}

// --- Salesforce -----------------------------------------------------------------------------------------------------

type soqlResult[T any] struct {
	TotalSize int64 `json:"totalSize"`
	Records   []T   `json:"records"`
}

func soql(ctx context.Context, c *restjson.Client, query string, out any) error {
	return c.Get(ctx, soqlVersionPath+"/query?q="+url.QueryEscape(query), out)
}

func salesforce(ctx context.Context, c *restjson.Client) (*Tenant, error) {
	var org soqlResult[struct {
		ID               string `json:"Id"`
		Name             string `json:"Name"`
		OrganizationType string `json:"OrganizationType"`
		InstanceName     string `json:"InstanceName"`
		IsSandbox        bool   `json:"IsSandbox"`
	}]
	if err := soql(ctx, c, "SELECT Id, Name, OrganizationType, InstanceName, IsSandbox FROM Organization", &org); err != nil {
		return nil, err
	}
	if len(org.Records) == 0 {
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "Salesforce returned no Organization record")
	}
	o := org.Records[0]
	t := &Tenant{Vendor: vendorSalesforce, TenantID: o.ID, DisplayName: o.Name, Edition: o.OrganizationType, Region: o.InstanceName, Facts: map[string]any{"sandbox": o.IsSandbox}}
	var licences soqlResult[struct {
		Name          string `json:"Name"`
		TotalLicenses int64  `json:"TotalLicenses"`
		UsedLicenses  int64  `json:"UsedLicenses"`
		Status        string `json:"Status"`
	}]
	if err := soql(ctx, c, "SELECT Name, TotalLicenses, UsedLicenses, Status FROM UserLicense", &licences); err != nil {
		return nil, err
	}
	for _, l := range licences.Records {
		t.Products = append(t.Products, Product{Name: l.Name, SKU: l.Name, SeatsTotal: l.TotalLicenses, SeatsAssigned: l.UsedLicenses, Status: strings.ToLower(l.Status)})
	}
	var active soqlResult[json.RawMessage]
	if err := soql(ctx, c, "SELECT COUNT() FROM User WHERE IsActive = true", &active); err != nil {
		return nil, err
	}
	t.ActiveUsers = active.TotalSize
	var all soqlResult[json.RawMessage]
	if err := soql(ctx, c, "SELECT COUNT() FROM User", &all); err == nil {
		t.Users = all.TotalSize
	}
	t.Raw = c.Raw()
	return t, nil
}

// --- ServiceNow -----------------------------------------------------------------------------------------------------

func serviceNow(ctx context.Context, c *restjson.Client, instance string) (*Tenant, error) {
	var props struct {
		Result []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"result"`
	}
	if err := c.Get(ctx, snowTablePath+"sys_properties?sysparm_query=nameINinstance_name,glide.war,glide.buildtag,glide.installation.production&sysparm_fields=name,value", &props); err != nil {
		return nil, err
	}
	facts := map[string]any{}
	name := instance
	for _, p := range props.Result {
		facts[p.Name] = p.Value
		if p.Name == "instance_name" && p.Value != "" {
			name = p.Value
		}
	}
	t := &Tenant{Vendor: vendorServiceNow, TenantID: name, DisplayName: name, Facts: facts}
	if v, ok := facts["glide.war"].(string); ok {
		t.Edition = v
	}
	var active struct {
		Result struct {
			Stats struct {
				Count string `json:"count"`
			} `json:"stats"`
		} `json:"result"`
	}
	if err := c.Get(ctx, snowStatsPath+"sys_user?sysparm_count=true&sysparm_query=active=true", &active); err != nil {
		return nil, err
	}
	t.ActiveUsers, _ = strconv.ParseInt(active.Result.Stats.Count, 10, 64)
	var all struct {
		Result struct {
			Stats struct {
				Count string `json:"count"`
			} `json:"stats"`
		} `json:"result"`
	}
	if err := c.Get(ctx, snowStatsPath+"sys_user?sysparm_count=true", &all); err == nil {
		t.Users, _ = strconv.ParseInt(all.Result.Stats.Count, 10, 64)
	}
	var licences struct {
		Result []struct {
			Name           string `json:"name"`
			PurchasedCount string `json:"purchased_count"`
			AllocatedCount string `json:"allocated_count"`
			State          string `json:"state"`
		} `json:"result"`
	}
	if err := c.Get(ctx, snowTablePath+"license_details?sysparm_fields=name,purchased_count,allocated_count,state", &licences); err == nil {
		for _, l := range licences.Result {
			total, _ := strconv.ParseInt(l.PurchasedCount, 10, 64)
			used, _ := strconv.ParseInt(l.AllocatedCount, 10, 64)
			t.Products = append(t.Products, Product{Name: l.Name, SKU: l.Name, SeatsTotal: total, SeatsAssigned: used, Status: strings.ToLower(l.State)})
		}
	} else if !restjson.IsNotFound(err) {
		return nil, err
	}
	if len(t.Products) == 0 {
		t.Products = []Product{{Name: "ServiceNow platform", SKU: "platform", SeatsTotal: t.Users, SeatsAssigned: t.ActiveUsers, Status: "active"}}
	}
	t.Raw = c.Raw()
	return t, nil
}

// --- Workday --------------------------------------------------------------------------------------------------------

func workday(ctx context.Context, c *restjson.Client, tenant string) (*Tenant, error) {
	var workers struct {
		Total int64             `json:"total"`
		Data  []json.RawMessage `json:"data"`
	}
	if err := c.Get(ctx, "/ccx/api/v1/"+url.PathEscape(tenant)+"/workers?limit="+strconv.Itoa(workdayPageOne), &workers); err != nil {
		return nil, err
	}
	t := &Tenant{Vendor: vendorWorkday, TenantID: tenant, DisplayName: tenant, Users: workers.Total, ActiveUsers: workers.Total, Facts: map[string]any{}}
	t.Products = []Product{{Name: "Workday HCM", SKU: "hcm", SeatsTotal: workers.Total, SeatsAssigned: workers.Total, Status: "active"}}
	t.Raw = c.Raw()
	return t, nil
}

// Emit converts a tenant into observations.
func Emit(t *Tenant, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range t.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	company := firstNonEmpty(vendorNames[t.Vendor], t.Vendor)
	vendorIdentity := map[string]string{"name": company}
	vendorRef := contract.CiRef{Type: typeVendor, Identity: vendorIdentity}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVendor, Identity: vendorIdentity, Name: company, Attributes: map[string]any{"kind": "saas", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	tenantIdentity := map[string]string{"vendor": company, "tenantId": t.TenantID}
	tenantRef := contract.CiRef{Type: typeTenant, Identity: tenantIdentity}
	seats, assigned := int64(0), int64(0)
	for _, p := range t.Products {
		seats += p.SeatsTotal
		assigned += p.SeatsAssigned
	}
	attrs := map[string]any{"vendor": company, "provider": t.Vendor, "tenantId": t.TenantID, "displayName": t.DisplayName, "domains": t.Domains, "region": t.Region, "edition": t.Edition, "users": t.Users, "activeUsers": t.ActiveUsers, "groups": t.Groups, "ssoApplications": t.SSOApps, "seatsTotal": seats, "seatsAssigned": assigned, "products": len(t.Products), "source": collectorID, "health": "healthy"}
	for k, v := range t.Facts {
		attrs[k] = v
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeTenant, Identity: tenantIdentity, Name: firstNonEmpty(t.DisplayName, t.TenantID), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: t.Vendor, ID: t.TenantID}}, ObservedAt: at})
	obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: tenantRef, To: vendorRef, Attributes: map[string]any{}, ObservedAt: at})
	for _, p := range t.Products {
		identity := map[string]string{"vendor": company, "product": p.Name, "tenantRef": t.TenantID}
		pAttrs := map[string]any{"vendor": company, "provider": t.Vendor, "product": p.Name, "sku": p.SKU, "seatsTotal": p.SeatsTotal, "seatsAssigned": p.SeatsAssigned, "status": p.Status, "source": collectorID}
		if p.EndsAt != "" {
			pAttrs["subscriptionEnd"] = p.EndsAt
			if p.StartsAt != "" {
				pAttrs["subscriptionStart"] = p.StartsAt
			}
		}
		if p.SeatsTotal > 0 {
			pAttrs["seatUtilisationPercent"] = p.SeatsAssigned * 100 / p.SeatsTotal
		}
		switch p.Status {
		case "enabled", "active":
			pAttrs["health"] = "healthy"
		// Salesforce reports a lapsed user licence as Disabled.
		case "warning", "suspended", "expired", "inactive", "disabled":
			pAttrs["health"] = "degraded"
		}
		ref := contract.CiRef{Type: typeApplication, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeApplication, Identity: identity, Name: p.Name, Attributes: pAttrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: t.Vendor, ID: p.SKU}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relLicensedBy, From: ref, To: tenantRef, Attributes: map[string]any{"seatsTotal": p.SeatsTotal, "seatsAssigned": p.SeatsAssigned}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: vendorRef, Attributes: map[string]any{}, ObservedAt: at})
	}
	return obs
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func requiredOption(options map[string]any, key string) (string, error) {
	v := restjson.StringOption(options, key)
	if v == "" {
		return "", collector.Errorf(contract.ErrInternal, false, "saas job must set the %s option", key)
	}
	return v, nil
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	vendor, err := requiredOption(options, optionVendor)
	if err != nil {
		return collector.Observation{}, err
	}
	api, err := requiredOption(options, optionAPI)
	if err != nil {
		return collector.Observation{}, err
	}
	if cred == nil {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "saas requires a credential")
	}
	caPem := restjson.StringOption(options, optionCA)
	opts := restjson.Options{VerifyTLS: true, CAPem: caPem}
	var tenant *Tenant
	switch vendor {
	case vendorM365, vendorSalesforce, vendorWorkday:
		if cred.Type != "oauth_client" || cred.Fields[credClient] == "" || cred.Fields[credSecret] == "" {
			return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "%s requires an oauth_client credential", vendor)
		}
		tokenURL, err := requiredOption(options, optionToken)
		if err != nil {
			return collector.Observation{}, err
		}
		token, err := clientCredentials(ctx, tokenURL, cred.Fields[credClient], cred.Fields[credSecret], restjson.StringOption(options, optionScope), caPem)
		if err != nil {
			return collector.Observation{}, err
		}
		c, err := restjson.New(api, defaultPort, restjson.Auth{Bearer: token}, opts)
		if err != nil {
			return collector.Observation{}, err
		}
		switch vendor {
		case vendorM365:
			counting, err := restjson.New(api, defaultPort, restjson.Auth{Bearer: token}, restjson.Options{VerifyTLS: true, CAPem: caPem, Headers: map[string]string{"ConsistencyLevel": "eventual"}})
			if err != nil {
				return collector.Observation{}, err
			}
			tenant, err = microsoft365(ctx, c, counting)
		case vendorSalesforce:
			tenant, err = salesforce(ctx, c)
		default:
			tenant, err = workday(ctx, c, firstNonEmpty(restjson.StringOption(options, optionTenant), target.Value))
		}
		if err != nil {
			return collector.Observation{}, restjson.Classify(target.Value, err)
		}
	case vendorGoogle:
		if cred.Type != "service_account" || cred.Fields[credEmail] == "" || cred.Fields[credKey] == "" || cred.Fields[credAdmin] == "" {
			return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "google_workspace requires a service_account credential with clientEmail, privateKeyPem and adminEmail (domain-wide delegation)")
		}
		tokenURL, err := requiredOption(options, optionToken)
		if err != nil {
			return collector.Observation{}, err
		}
		scope, err := requiredOption(options, optionScope)
		if err != nil {
			return collector.Observation{}, err
		}
		assertion, err := gcp.SignedDelegatedJWT(cred.Fields[credEmail], cred.Fields[credKey], scope, tokenURL, cred.Fields[credAdmin], time.Now())
		if err != nil {
			return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "service account key: %v", err)
		}
		token, err := jwtBearer(ctx, tokenURL, assertion, caPem)
		if err != nil {
			return collector.Observation{}, err
		}
		c, err := restjson.New(api, defaultPort, restjson.Auth{Bearer: token}, opts)
		if err != nil {
			return collector.Observation{}, err
		}
		if tenant, err = googleWorkspace(ctx, c); err != nil {
			return collector.Observation{}, restjson.Classify(target.Value, err)
		}
	case vendorServiceNow:
		if cred.Type != "password" || cred.Fields[credUser] == "" {
			return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "servicenow requires a password credential")
		}
		c, err := restjson.New(api, defaultPort, restjson.Auth{User: cred.Fields[credUser], Pass: cred.Fields[credPassword]}, opts)
		if err != nil {
			return collector.Observation{}, err
		}
		if tenant, err = serviceNow(ctx, c, firstNonEmpty(restjson.StringOption(options, optionTenant), target.Value)); err != nil {
			return collector.Observation{}, restjson.Classify(target.Value, err)
		}
	default:
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "saas vendor %q is not one of microsoft365, google_workspace, salesforce, servicenow, workday", vendor)
	}
	if tenant.TenantID == "" {
		tenant.TenantID = target.Value
	}
	return Emit(tenant, time.Now().UTC()), nil
}

// T-440 REQ-QA-005 REQ-CMDB-022 — the real saas collector, TLS pinned to the simulated-mode CA on both the token
// endpoint and the API, signs in to each simulated provider with its real flow (Entra client credentials, Google
// JWT bearer with domain-wide delegation, Salesforce client credentials, ServiceNow basic, Workday client
// credentials) and reconstructs each tenant: the vendor, the tenant and every subscribed product with their
// licensed_by and member_of relationships; then the tenant counts, seat assignments and subscription terms are
// checked against the mirrored SaaS layer.
package saas

import (
	"context"
	"encoding/json"
	"os/exec"
	"testing"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/simtest"
	"github.com/openmap/openmap/tools/simulator/internal/verify"
)

func TestSimulatedSaaSTenants(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	if len(reports) != len(tenantDefs) {
		t.Fatalf("expected one run per provider, got %d", len(reports))
	}
	for _, r := range reports {
		t.Logf("%s: %d requests so far (the request log is shared by the runs)", r.Run, r.Requests)
		for _, d := range r.IdentityDrift {
			t.Logf("%s identity drift: %s %q estate %v collector %v", r.Run, d.Type, d.Name, d.Estate, d.Collector)
		}
	}
}

func TestSimulatedSaaSAttributes(t *testing.T) {
	e := simtest.Estate(t)
	ctx := context.Background()
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	repo, err := verify.RepoRoot()
	if err != nil {
		t.Fatal(err)
	}
	v := Vendor{}
	bin, err := verify.NewBinaries(repo, t.TempDir()).Path(ctx, v.Collector())
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.CommandContext(ctx, bin, "--manifest").Output()
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		ContractVersion string `json:"contractVersion"`
	}
	if err := json.Unmarshal(out, &manifest); err != nil {
		t.Fatal(err)
	}
	ep, err := v.Start(ctx, e, env)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ep.Close() }()
	tenants := map[string]*Tenant{}
	for _, tn := range Tenants(e) {
		tenants[tn.Provider] = tn
	}
	for _, run := range v.Runs(e, ep, env) {
		tn := tenants[run.Name]
		res, stderr, err := verify.Execute(ctx, bin, verify.Invocation(e, v.Collector(), manifest.ContractVersion, run), time.Minute)
		if err != nil || res.Status != "success" {
			t.Fatalf("%s: %v %v: %s", run.Name, err, res, stderr)
		}
		apps := map[string]map[string]any{}
		var tenant map[string]any
		for _, c := range res.Cis {
			switch c.Type {
			case "saas_tenant":
				tenant = c.Attributes
			case "saas_application":
				apps[c.Name] = c.Attributes
			}
		}
		if tenant == nil {
			t.Fatalf("%s: no tenant", run.Name)
		}
		num := func(a map[string]any, k string) int {
			f, _ := a[k].(float64)
			return int(f)
		}
		if tenant["vendor"] != tn.Vendor || tenant["provider"] != tn.Provider || tenant["tenantId"] != tn.TenantID {
			t.Errorf("%s tenant identity attributes: %v %v %v", run.Name, tenant["vendor"], tenant["provider"], tenant["tenantId"])
		}
		switch tn.Provider {
		case providerM365:
			if num(tenant, "users") != tn.Users || num(tenant, "ssoApplications") != tn.SSO {
				t.Errorf("m365 counts: users %d/%d sso %d/%d", num(tenant, "users"), tn.Users, num(tenant, "ssoApplications"), tn.SSO)
			}
		case providerGoogle:
			if num(tenant, "users") != tn.Users || num(tenant, "activeUsers") != tn.Active || num(tenant, "groups") != tn.Groups || tenant["region"] != countryCode {
				t.Errorf("google counts: users %d/%d active %d/%d groups %d/%d", num(tenant, "users"), tn.Users, num(tenant, "activeUsers"), tn.Active, num(tenant, "groups"), tn.Groups)
			}
		case providerSalesforce, providerServiceNow:
			if num(tenant, "users") != tn.Users || num(tenant, "activeUsers") != tn.Active {
				t.Errorf("%s counts: users %d/%d active %d/%d", run.Name, num(tenant, "users"), tn.Users, num(tenant, "activeUsers"), tn.Active)
			}
		case providerWorkday:
			if num(tenant, "users") != tn.Users {
				t.Errorf("workday workers %d/%d", num(tenant, "users"), tn.Users)
			}
		}
		if tn.Provider == providerGoogle || tn.Provider == providerWorkday {
			continue
		}
		for _, p := range tn.Products {
			a, ok := apps[collectorProductName(tn, p)]
			if !ok {
				t.Errorf("%s: product %s missing", run.Name, p.Name)
				continue
			}
			if num(a, "seatsAssigned") != p.Assigned {
				t.Errorf("%s %s seatsAssigned %d, estate %d", run.Name, p.Name, num(a, "seatsAssigned"), p.Assigned)
			}
			if p.Expired {
				if a["health"] != "degraded" {
					t.Errorf("%s %s: a lapsed product must be degraded, got %v", run.Name, p.Name, a["health"])
				}
				continue
			}
			if num(a, "seatsTotal") != p.Seats {
				t.Errorf("%s %s seatsTotal %d, estate %d", run.Name, p.Name, num(a, "seatsTotal"), p.Seats)
			}
			if tn.Provider == providerM365 && a["subscriptionEnd"] != p.End.Format(time.RFC3339) {
				t.Errorf("m365 %s subscriptionEnd %v, estate %s", p.SKU, a["subscriptionEnd"], dateOnly(p.End))
			}
		}
	}
}

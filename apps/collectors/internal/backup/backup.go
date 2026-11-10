// REQ-INT-017 — backup and DR awareness (ADR-075). One job = one backup server: Veeam Backup & Replication (REST v1),
// Commvault (Command Center REST) or Rubrik CDM (REST v1/v2). The collector reports every backup policy (a Veeam job, a
// Commvault plan or the storage policy of a subclient without one, a Rubrik SLA domain) as a backup_policy CI, and every
// object the policy protects as a backed_by edge from that object's CI to the policy, carrying the last good backup, the
// restore points, the RPO and the retention (packages/contracts/src/protection.ts). Objects are matched to CMDB CIs
// through the job's `inventory` option, the CMDB's own identities with every spelling a backup product names a CI by;
// an unmatched object with a DNS name is named by FQDN, any other is counted on its policy as unmatched.
package backup

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "backup"
	version      = "0.1.0"
	evidenceKind = "api_response"
	loginTimeout = 30 * time.Second

	optionVendor    = "vendor"
	optionAPI       = "apiVersion"
	optionVerify    = "verifyTls"
	optionCA        = "caCertPem"
	optionInventory = "inventory"
	optionAPIPath   = "apiPath"

	credUser   = "username"
	credPass   = "password"
	credClient = "clientId"
	credSecret = "clientSecret"

	VendorVeeam     = "veeam"
	VendorCommvault = "commvault"
	VendorRubrik    = "rubrik"

	typePolicy = "backup_policy"
	typeVM     = "vm"
	typeHost   = "host"
	relBacked  = "backed_by"

	KindJob           = "job"
	KindPlan          = "plan"
	KindStoragePolicy = "storage_policy"
	KindSLADomain     = "sla_domain"

	ResultSuccess = "success"
	ResultWarning = "warning"
	ResultFailed  = "failed"
	ResultRunning = "running"
	ResultNone    = "none"

	// unmatchedNamesMax mirrors BACKUP_AWARENESS.unmatchedNamesMax: a policy lists at most this many unmatched names.
	unmatchedNamesMax = 20

	minutesPerHour  = 60
	minutesPerDay   = 1440
	minutesPerWeek  = 10080
	minutesPerMonth = 43200  // 30 days
	minutesPerYear  = 525600 // 365 days
	daysPerWeek     = 7
	daysPerMonth    = 30
	daysPerYear     = 365
	hoursPerDay     = 24
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "backup", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password", "oauth_client"},
		TargetKinds: []string{"host"}, Emits: []string{typePolicy},
		ContractVersion: contract.Version,
	}
}

// Object is one thing a policy protects, as the backup product names it, with what it reports of its backups.
type Object struct {
	// Kind is the CI type to assume when the object is not in the inventory (vm or host).
	Kind         string
	Name         string
	FQDN         string
	IP           string
	InstanceUUID string
	VCenter      string
	MoRef        string

	LastGoodBackupAt *time.Time
	LastBackupAt     *time.Time
	LastResult       string
	RestorePoints    int
	Agents           []string
	Subclients       []string
}

// Policy is one backup policy and the objects it protects.
type Policy struct {
	ID              string
	Name            string
	Kind            string
	RpoMinutes      int
	RetentionDays   int
	RetentionPoints int
	Enabled         bool
	LastRunAt       *time.Time
	LastResult      string
	Objects         []Object
}

// Adapter reads one backup server.
type Adapter interface {
	// Read returns the server's own id, its policies and the raw response bodies.
	Read(ctx context.Context) (string, []Policy, [][]byte, error)
}

// InventoryEntry is one CMDB candidate (backupInventoryEntrySchema).
type InventoryEntry struct {
	Type     string
	Identity map[string]string
	Keys     []string
}

// Inventory maps lower-case keys to the one candidate they name; a key naming several candidates is dropped.
type Inventory struct {
	byKey map[string]*InventoryEntry
}

// ParseInventory reads the job's inventory option.
func ParseInventory(options map[string]any) *Inventory {
	inv := &Inventory{byKey: map[string]*InventoryEntry{}}
	raw, _ := options[optionInventory].([]any)
	ambiguous := map[string]bool{}
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		e := &InventoryEntry{Type: str(m["type"]), Identity: map[string]string{}}
		if e.Type != typeVM && e.Type != typeHost {
			continue
		}
		if id, ok := m["identity"].(map[string]any); ok {
			for k, v := range id {
				if s := str(v); s != "" {
					e.Identity[k] = s
				}
			}
		}
		if len(e.Identity) == 0 {
			continue
		}
		keys, _ := m["keys"].([]any)
		for _, k := range keys {
			key := norm(str(k))
			if key == "" || ambiguous[key] {
				continue
			}
			if prev, ok := inv.byKey[key]; ok && prev != e {
				delete(inv.byKey, key)
				ambiguous[key] = true
				continue
			}
			inv.byKey[key] = e
			e.Keys = append(e.Keys, key)
		}
	}
	return inv
}

// Len is the number of usable keys.
func (inv *Inventory) Len() int { return len(inv.byKey) }

// VCenterKey is the key Veeam and Rubrik name a vCenter VM by (vcenterObjectKey in protection.ts).
func VCenterKey(vcenter, moRef string) string {
	return norm(strings.TrimSpace(vcenter) + ":" + strings.TrimSpace(moRef))
}

// candidateKeys lists an object's keys in matching precedence: instance UUID, vCenter object, FQDN, name, address.
func (o Object) candidateKeys() []string {
	var out []string
	add := func(s string) {
		if s = norm(s); s != "" {
			out = append(out, s)
		}
	}
	add(o.InstanceUUID)
	if o.VCenter != "" && o.MoRef != "" {
		add(VCenterKey(o.VCenter, o.MoRef))
	}
	add(o.FQDN)
	add(o.Name)
	add(o.IP)
	return out
}

// Resolve names the object's CI: the inventory candidate of its most specific key, else its FQDN under the object's
// kind, else nothing.
func (inv *Inventory) Resolve(o Object) (contract.CiRef, bool) {
	for _, k := range o.candidateKeys() {
		if e, ok := inv.byKey[k]; ok {
			return contract.CiRef{Type: e.Type, Identity: copyMap(e.Identity)}, true
		}
	}
	fqdn := norm(o.FQDN)
	if fqdn == "" && strings.Contains(o.Name, ".") && !isAddress(o.Name) {
		fqdn = norm(o.Name)
	}
	if fqdn != "" && strings.Contains(fqdn, ".") {
		kind := o.Kind
		if kind != typeVM {
			kind = typeHost
		}
		return contract.CiRef{Type: kind, Identity: map[string]string{"fqdn": fqdn}}, true
	}
	return contract.CiRef{}, false
}

func isAddress(s string) bool {
	for _, r := range s {
		if !(r == '.' || r == ':' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func copyMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func norm(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func str(v any) string {
	s, _ := v.(string)
	return s
}

func rfc(t *time.Time) string { return t.UTC().Format(time.RFC3339) }

func later(a, b *time.Time) *time.Time {
	switch {
	case a == nil:
		return b
	case b == nil:
		return a
	case b.After(*a):
		return b
	}
	return a
}

// Emit turns a server's policies into observations.
func Emit(vendor, serverID, server string, policies []Policy, inv *Inventory, raw [][]byte, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	for _, p := range policies {
		identity := map[string]string{"vendor": vendor, "serverId": serverID, "policyId": p.ID}
		policyRef := contract.CiRef{Type: typePolicy, Identity: identity}
		// One edge per CI: an object a policy reports twice (two backups of one job) keeps its newest backup.
		type cover struct {
			ref contract.CiRef
			o   Object
		}
		covers := map[string]*cover{}
		order := []string{}
		var unmatched []string
		for _, o := range p.Objects {
			ref, ok := inv.Resolve(o)
			if !ok {
				unmatched = append(unmatched, o.Name)
				continue
			}
			key := ref.Type + "|" + canonical(ref.Identity)
			if c, seen := covers[key]; seen {
				c.o = merge(c.o, o)
				continue
			}
			covers[key] = &cover{ref: ref, o: o}
			order = append(order, key)
		}
		sort.Strings(unmatched)
		names := unmatched
		if len(names) > unmatchedNamesMax {
			names = names[:unmatchedNamesMax]
		}
		attrs := map[string]any{
			"vendor": vendor, "serverId": serverID, "server": server, "policyId": p.ID, "policyKind": p.Kind,
			"enabled": p.Enabled, "lastResult": nonEmpty(p.LastResult, ResultNone),
			"protectedObjects": len(order), "unmatchedObjects": len(unmatched), "unmatchedNames": names,
		}
		if p.RpoMinutes > 0 {
			attrs["rpoMinutes"] = p.RpoMinutes
		}
		if p.RetentionDays > 0 {
			attrs["retentionDays"] = p.RetentionDays
		}
		if p.RetentionPoints > 0 {
			attrs["retentionPoints"] = p.RetentionPoints
		}
		if p.LastRunAt != nil {
			attrs["lastRunAt"] = rfc(p.LastRunAt)
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{
			Type: typePolicy, Identity: identity, Name: nonEmpty(p.Name, p.ID), Attributes: attrs,
			Tags: []string{"backup", vendor}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: p.ID}}, ObservedAt: at,
		})
		for _, key := range order {
			c := covers[key]
			o := c.o
			edge := map[string]any{"vendor": vendor, "objectName": o.Name, "lastResult": nonEmpty(o.LastResult, ResultNone), "restorePoints": o.RestorePoints}
			if o.LastGoodBackupAt != nil {
				edge["lastGoodBackupAt"] = rfc(o.LastGoodBackupAt)
			}
			if o.LastBackupAt != nil {
				edge["lastBackupAt"] = rfc(o.LastBackupAt)
			}
			if p.RpoMinutes > 0 {
				edge["rpoMinutes"] = p.RpoMinutes
			}
			if p.RetentionDays > 0 {
				edge["retentionDays"] = p.RetentionDays
			}
			if len(o.Agents) > 0 {
				edge["agents"] = o.Agents
			}
			if len(o.Subclients) > 0 {
				edge["subclients"] = o.Subclients
			}
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relBacked, From: c.ref, To: policyRef, Attributes: edge, ObservedAt: at})
		}
	}
	return obs
}

func merge(a, b Object) Object {
	a.LastGoodBackupAt = later(a.LastGoodBackupAt, b.LastGoodBackupAt)
	if lb := later(a.LastBackupAt, b.LastBackupAt); lb != a.LastBackupAt {
		a.LastBackupAt, a.LastResult = lb, b.LastResult
	}
	a.RestorePoints += b.RestorePoints
	a.Agents = union(a.Agents, b.Agents)
	a.Subclients = union(a.Subclients, b.Subclients)
	return a
}

func union(a, b []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range append(append([]string{}, a...), b...) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

func canonical(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k + "=" + norm(m[k]) + ";")
	}
	return b.String()
}

func nonEmpty(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// tlsOptions carries the job's TLS policy to the login endpoints and the API clients.
type tlsOptions struct {
	verify bool
	caPem  string
}

func (t tlsOptions) client(base string, port int, auth restjson.Auth, headers map[string]string) (*restjson.Client, error) {
	return restjson.New(base, port, auth, restjson.Options{VerifyTLS: t.verify, CAPem: t.caPem, Headers: headers})
}

// login posts body to u and decodes the JSON answer into out; 401/403 (and 400 on bad grants) are auth failures.
func login(ctx context.Context, u string, contentType string, body io.Reader, headers map[string]string, tls tlsOptions, out any) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	transport, err := restjson.TransportFor(tls.verify, tls.caPem)
	if err != nil {
		return nil, err
	}
	res, err := (&http.Client{Timeout: loginTimeout, Transport: transport}).Do(req)
	if err != nil {
		return nil, restjson.Classify(req.URL.Host, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusBadRequest:
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential (%d)", req.URL.Host, res.StatusCode)
	case res.StatusCode == http.StatusNotFound:
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s has no login endpoint %s", req.URL.Host, req.URL.Path)
	case res.StatusCode >= http.StatusInternalServerError:
		return nil, collector.Errorf(contract.ErrUnreachable, true, "%s returned %d on login", req.URL.Host, res.StatusCode)
	case res.StatusCode >= http.StatusMultipleChoices:
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "%s returned %d on login", req.URL.Host, res.StatusCode)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return nil, collector.Errorf(contract.ErrParse, false, "%s: invalid login response: %v", req.URL.Host, err)
	}
	return raw, nil
}

// baseURL renders the target as an https URL with the vendor's default port when none is given.
func baseURL(target string, port int) (string, string, error) {
	c, err := restjson.New(target, port, restjson.Auth{}, restjson.Options{})
	if err != nil {
		return "", "", err
	}
	u := *c.Base
	u.Path, u.RawQuery = "", ""
	return strings.TrimSuffix(u.String(), "/"), strings.ToLower(u.Hostname()), nil
}

func formBody(values url.Values) io.Reader { return strings.NewReader(values.Encode()) }

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	tls := tlsOptions{verify: restjson.BoolOption(options, optionVerify), caPem: restjson.StringOption(options, optionCA)}
	vendor := restjson.StringOption(options, optionVendor)
	var adapter Adapter
	var err error
	switch vendor {
	case VendorVeeam:
		adapter, err = newVeeam(ctx, target.Value, restjson.StringOption(options, optionAPI), cred, tls)
	case VendorCommvault:
		adapter, err = newCommvault(ctx, target.Value, restjson.StringOption(options, optionAPIPath), cred, tls)
	case VendorRubrik:
		adapter, err = newRubrik(ctx, target.Value, cred, tls)
	default:
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "unknown backup vendor %q (veeam, commvault, rubrik)", vendor)
	}
	if err != nil {
		return collector.Observation{}, err
	}
	serverID, policies, raw, err := adapter.Read(ctx)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(vendor, serverID, target.Value, policies, ParseInventory(options), raw, time.Now().UTC()), nil
}

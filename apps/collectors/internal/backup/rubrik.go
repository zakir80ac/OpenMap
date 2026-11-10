// REQ-INT-017 — Rubrik CDM REST API adapter (ADR-075), as Rubrik's published reference describes it: a service account
// session (POST /api/v1/service_account/session with the account id and secret) returns a bearer token; /v1/cluster/me
// names the cluster; /v2/sla_domain lists the SLA domains with their snapshot frequencies and retention; /v1/vmware/vm
// and /v1/fileset list the VMs and filesets with their effective SLA domain (limit/offset paging with hasMore); each
// object's newest snapshot is its last good backup (a snapshot exists only once a backup completed). A policy is an SLA
// domain: its most frequent snapshot gives the RPO, its longest retention the days kept.
package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	rubrikPort    = 443
	rubrikSession = "/api/v1/service_account/session"
	rubrikPage    = 200
	// Rubrik's pseudo SLA domains: an object explicitly left unprotected, or inheriting none.
	rubrikUnprotected = "UNPROTECTED"
	rubrikInherit     = "INHERIT"
)

type rubrik struct {
	c *restjson.Client
}

func newRubrik(ctx context.Context, target string, cred *contract.Credential, tls tlsOptions) (Adapter, error) {
	if cred == nil || cred.Fields[credClient] == "" || cred.Fields[credSecret] == "" {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "rubrik requires an oauth_client credential with the service account id and secret")
	}
	base, _, err := baseURL(target, rubrikPort)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(map[string]string{"serviceAccountId": cred.Fields[credClient], "secret": cred.Fields[credSecret]})
	if err != nil {
		return nil, err
	}
	var out struct {
		Token string `json:"token"`
	}
	if _, err := login(ctx, base+rubrikSession, "application/json", bytes.NewReader(body), nil, tls, &out); err != nil {
		return nil, err
	}
	if out.Token == "" {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "rubrik returned no session token")
	}
	c, err := tls.client(base, rubrikPort, restjson.Auth{Bearer: out.Token}, nil)
	if err != nil {
		return nil, err
	}
	return &rubrik{c: c}, nil
}

type rubrikPageOf[T any] struct {
	Data    []T  `json:"data"`
	HasMore bool `json:"hasMore"`
	Total   int  `json:"total"`
}

func rubrikAll[T any](ctx context.Context, c *restjson.Client, path string, out *[]T) error {
	offset := 0
	for {
		q := url.Values{"limit": {strconv.Itoa(rubrikPage)}, "offset": {strconv.Itoa(offset)}}
		var page rubrikPageOf[T]
		if err := c.Get(ctx, path+"?"+q.Encode(), &page); err != nil {
			return err
		}
		*out = append(*out, page.Data...)
		offset += len(page.Data)
		if !page.HasMore || len(page.Data) == 0 {
			return nil
		}
	}
}

type rubrikFrequency struct {
	Frequency int `json:"frequency"`
	Retention int `json:"retention"`
}

type rubrikSLA struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Frequencies struct {
		Hourly  *rubrikFrequency `json:"hourly"`
		Daily   *rubrikFrequency `json:"daily"`
		Weekly  *rubrikFrequency `json:"weekly"`
		Monthly *rubrikFrequency `json:"monthly"`
		Yearly  *rubrikFrequency `json:"yearly"`
	} `json:"frequencies"`
}

// RubrikRpoAndRetention is an SLA domain's most frequent snapshot interval in minutes and its longest retention in days
// (hourly retention is in hours, daily in days, weekly in weeks, monthly in months, yearly in years).
func RubrikRpoAndRetention(s rubrikSLA) (int, int) {
	rpo, days := 0, 0
	consider := func(f *rubrikFrequency, minutes int, retentionDays func(int) int) {
		if f == nil || f.Frequency <= 0 {
			return
		}
		if m := f.Frequency * minutes; rpo == 0 || m < rpo {
			rpo = m
		}
		if d := retentionDays(f.Retention); d > days {
			days = d
		}
	}
	consider(s.Frequencies.Hourly, minutesPerHour, func(r int) int { return (r + hoursPerDay - 1) / hoursPerDay })
	consider(s.Frequencies.Daily, minutesPerDay, func(r int) int { return r })
	consider(s.Frequencies.Weekly, minutesPerWeek, func(r int) int { return r * daysPerWeek })
	consider(s.Frequencies.Monthly, minutesPerMonth, func(r int) int { return r * daysPerMonth })
	consider(s.Frequencies.Yearly, minutesPerYear, func(r int) int { return r * daysPerYear })
	return rpo, days
}

type rubrikVcenter struct {
	ID       string `json:"id"`
	Hostname string `json:"hostname"`
}

type rubrikVM struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Moid                   string `json:"moid"`
	VcenterID              string `json:"vcenterId"`
	IPAddress              string `json:"ipAddress"`
	EffectiveSLADomainID   string `json:"effectiveSlaDomainId"`
	EffectiveSLADomainName string `json:"effectiveSlaDomainName"`
}

type rubrikFileset struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	HostName               string `json:"hostName"`
	EffectiveSLADomainID   string `json:"effectiveSlaDomainId"`
	EffectiveSLADomainName string `json:"effectiveSlaDomainName"`
}

type rubrikSnapshot struct {
	ID   string `json:"id"`
	Date string `json:"date"`
}

func protectedBy(slaID string) bool {
	return slaID != "" && slaID != rubrikUnprotected && slaID != rubrikInherit
}

func newestSnapshot(snaps []rubrikSnapshot) *time.Time {
	var newest *time.Time
	for _, s := range snaps {
		newest = later(newest, parseTime(s.Date))
	}
	return newest
}

func (r *rubrik) Read(ctx context.Context) (string, []Policy, [][]byte, error) {
	var me struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := r.c.Get(ctx, "/api/v1/cluster/me", &me); err != nil {
		return "", nil, nil, err
	}
	var slas []rubrikSLA
	if err := rubrikAll(ctx, r.c, "/api/v2/sla_domain", &slas); err != nil {
		return "", nil, nil, err
	}
	policies := map[string]*Policy{}
	order := []string{}
	for _, s := range slas {
		rpo, days := RubrikRpoAndRetention(s)
		policies[s.ID] = &Policy{ID: s.ID, Name: s.Name, Kind: KindSLADomain, RpoMinutes: rpo, RetentionDays: days, Enabled: true, LastResult: ResultNone}
		order = append(order, s.ID)
	}
	policy := func(id, name string) *Policy {
		p, ok := policies[id]
		if !ok {
			p = &Policy{ID: id, Name: nonEmpty(name, id), Kind: KindSLADomain, Enabled: true, LastResult: ResultNone}
			policies[id] = p
			order = append(order, id)
		}
		return p
	}
	add := func(p *Policy, o Object) {
		if o.LastGoodBackupAt != nil {
			o.LastResult = ResultSuccess
			if p.LastRunAt == nil || o.LastGoodBackupAt.After(*p.LastRunAt) {
				p.LastRunAt, p.LastResult = o.LastGoodBackupAt, ResultSuccess
			}
		}
		p.Objects = append(p.Objects, o)
	}
	var vcenters []rubrikVcenter
	if err := rubrikAll(ctx, r.c, "/api/v1/vmware/vcenter", &vcenters); err != nil && !restjson.IsNotFound(err) {
		return "", nil, nil, err
	}
	vcenterHost := map[string]string{}
	for _, v := range vcenters {
		vcenterHost[v.ID] = v.Hostname
	}
	var vms []rubrikVM
	if err := rubrikAll(ctx, r.c, "/api/v1/vmware/vm", &vms); err != nil && !restjson.IsNotFound(err) {
		return "", nil, nil, err
	}
	for _, vm := range vms {
		if !protectedBy(vm.EffectiveSLADomainID) {
			continue
		}
		var snaps []rubrikSnapshot
		if err := rubrikAll(ctx, r.c, "/api/v1/vmware/vm/"+url.PathEscape(vm.ID)+"/snapshot", &snaps); err != nil {
			return "", nil, nil, err
		}
		newest := newestSnapshot(snaps)
		add(policy(vm.EffectiveSLADomainID, vm.EffectiveSLADomainName), Object{
			Kind: typeVM, Name: vm.Name, IP: vm.IPAddress, VCenter: vcenterHost[vm.VcenterID], MoRef: vm.Moid,
			LastGoodBackupAt: newest, LastBackupAt: newest, RestorePoints: len(snaps), LastResult: ResultNone,
		})
	}
	var filesets []rubrikFileset
	if err := rubrikAll(ctx, r.c, "/api/v1/fileset", &filesets); err != nil && !restjson.IsNotFound(err) {
		return "", nil, nil, err
	}
	// One object per host and SLA domain: a host's filesets in one domain are one cover.
	type hostCover struct {
		p *Policy
		o Object
	}
	covers := map[string]*hostCover{}
	coverOrder := []string{}
	for _, fs := range filesets {
		if !protectedBy(fs.EffectiveSLADomainID) {
			continue
		}
		var detail struct {
			Snapshots []rubrikSnapshot `json:"snapshots"`
		}
		if err := r.c.Get(ctx, "/api/v1/fileset/"+url.PathEscape(fs.ID), &detail); err != nil {
			return "", nil, nil, err
		}
		newest := newestSnapshot(detail.Snapshots)
		key := fs.EffectiveSLADomainID + "|" + norm(fs.HostName)
		o := Object{Kind: typeHost, Name: fs.HostName, FQDN: fs.HostName, LastGoodBackupAt: newest, LastBackupAt: newest,
			RestorePoints: len(detail.Snapshots), LastResult: ResultNone, Subclients: []string{fs.Name}}
		if isAddress(fs.HostName) {
			o.FQDN, o.IP = "", fs.HostName
		}
		if c, ok := covers[key]; ok {
			c.o = merge(c.o, o)
			continue
		}
		covers[key] = &hostCover{p: policy(fs.EffectiveSLADomainID, fs.EffectiveSLADomainName), o: o}
		coverOrder = append(coverOrder, key)
	}
	for _, key := range coverOrder {
		add(covers[key].p, covers[key].o)
	}
	out := make([]Policy, 0, len(order))
	for _, id := range order {
		p := *policies[id]
		sort.SliceStable(p.Objects, func(a, b int) bool { return strings.ToLower(p.Objects[a].Name) < strings.ToLower(p.Objects[b].Name) })
		out = append(out, p)
	}
	return nonEmpty(me.ID, me.Name), out, r.c.Raw(), nil
}

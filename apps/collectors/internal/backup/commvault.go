// REQ-INT-017 — Commvault Command Center REST API adapter (ADR-075), as Commvault's published reference describes it: a
// login at /Login with the password Base64-encoded returns a QSDK token sent as the Authtoken header; /Client lists the
// clients with their host names, /Subclient?clientId= each client's subclients with their agent (appName), plan and
// storage policy, /v2/Plan the plans with their RPO and retention, and /Job?clientId=&jobFilter=Backup the client's
// backup job history. A policy is a plan, or the storage policy of a subclient that has no plan. One protected object
// per client and policy: its agents, its subclients, the newest job that completed (with or without warnings) as the
// last good backup and the good jobs in the history as restore points.
package backup

import (
	"bytes"
	"context"
	"encoding/base64"
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
	commvaultPort    = 443
	commvaultAPIPath = "/webconsole/api"
	commvaultHeader  = "Authtoken"
	planPrefix       = "plan:"
	storagePrefix    = "sp:"
)

type commvault struct {
	c        *restjson.Client
	prefix   string
	serverID string
}

func newCommvault(ctx context.Context, target, apiPath string, cred *contract.Credential, tls tlsOptions) (Adapter, error) {
	if cred == nil || cred.Fields[credUser] == "" || cred.Fields[credPass] == "" {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "commvault requires a password credential with username and password")
	}
	prefix := "/" + strings.Trim(nonEmpty(apiPath, commvaultAPIPath), "/")
	base, host, err := baseURL(target, commvaultPort)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(map[string]string{"username": cred.Fields[credUser], "password": base64.StdEncoding.EncodeToString([]byte(cred.Fields[credPass]))})
	if err != nil {
		return nil, err
	}
	var out struct {
		Token   string `json:"token"`
		ErrList []struct {
			ErrLogMessage string `json:"errLogMessage"`
		} `json:"errList"`
	}
	if _, err := login(ctx, base+prefix+"/Login", "application/json", bytes.NewReader(body), nil, tls, &out); err != nil {
		return nil, err
	}
	// Commvault answers a wrong password with 200 and an errList instead of a token.
	if out.Token == "" {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "commvault rejected the credential")
	}
	c, err := tls.client(base, commvaultPort, restjson.Auth{}, map[string]string{commvaultHeader: out.Token})
	if err != nil {
		return nil, err
	}
	return &commvault{c: c, prefix: prefix, serverID: host}, nil
}

type commvaultClient struct {
	Client struct {
		ClientEntity struct {
			ClientID    int    `json:"clientId"`
			ClientName  string `json:"clientName"`
			HostName    string `json:"hostName"`
			DisplayName string `json:"displayName"`
		} `json:"clientEntity"`
	} `json:"client"`
}

type commvaultSubclient struct {
	SubClientEntity struct {
		SubclientID   int    `json:"subclientId"`
		SubclientName string `json:"subclientName"`
		BackupsetName string `json:"backupsetName"`
		AppName       string `json:"appName"`
		ClientName    string `json:"clientName"`
	} `json:"subClientEntity"`
	PlanEntity *struct {
		PlanID   int    `json:"planId"`
		PlanName string `json:"planName"`
	} `json:"planEntity"`
	CommonProperties struct {
		EnableBackup  *bool `json:"enableBackup"`
		StorageDevice struct {
			DataBackupStoragePolicy struct {
				StoragePolicyID   int    `json:"storagePolicyId"`
				StoragePolicyName string `json:"storagePolicyName"`
			} `json:"dataBackupStoragePolicy"`
		} `json:"storageDevice"`
	} `json:"commonProperties"`
}

type commvaultPlan struct {
	Plan struct {
		PlanID   int    `json:"planId"`
		PlanName string `json:"planName"`
	} `json:"plan"`
	RpoInMinutes int `json:"rpoInMinutes"`
	Storage      struct {
		Copy []struct {
			RetentionRules struct {
				RetainBackupDataForDays int `json:"retainBackupDataForDays"`
			} `json:"retentionRules"`
		} `json:"copy"`
	} `json:"storage"`
}

type commvaultJob struct {
	JobSummary struct {
		JobID        int    `json:"jobId"`
		Status       string `json:"status"`
		JobType      string `json:"jobType"`
		JobStartTime int64  `json:"jobStartTime"`
		JobEndTime   int64  `json:"jobEndTime"`
		Subclient    struct {
			SubclientID int `json:"subclientId"`
		} `json:"subclient"`
	} `json:"jobSummary"`
}

// CommvaultResult maps a Commvault job status to the normalised result.
func CommvaultResult(status string) string {
	s := strings.ToLower(strings.TrimSpace(status))
	switch {
	case s == "completed":
		return ResultSuccess
	case strings.HasPrefix(s, "completed w/"), strings.HasPrefix(s, "completed with"):
		return ResultWarning
	case strings.HasPrefix(s, "failed"), s == "killed", strings.HasPrefix(s, "committed"):
		return ResultFailed
	case s == "running", s == "pending", s == "waiting", s == "queued", s == "suspended":
		return ResultRunning
	}
	return ResultNone
}

func unix(sec int64) *time.Time {
	if sec <= 0 {
		return nil
	}
	t := time.Unix(sec, 0).UTC()
	return &t
}

func (cv *commvault) Read(ctx context.Context) (string, []Policy, [][]byte, error) {
	var plans struct {
		Plans []commvaultPlan `json:"plans"`
	}
	if err := cv.c.Get(ctx, cv.prefix+"/v2/Plan", &plans); err != nil && !restjson.IsNotFound(err) {
		return "", nil, nil, err
	}
	planByID := map[int]commvaultPlan{}
	for _, p := range plans.Plans {
		planByID[p.Plan.PlanID] = p
	}
	var clients struct {
		ClientProperties []commvaultClient `json:"clientProperties"`
	}
	if err := cv.c.Get(ctx, cv.prefix+"/Client", &clients); err != nil {
		return "", nil, nil, err
	}
	policies := map[string]*Policy{}
	order := []string{}
	policyFor := func(sc commvaultSubclient) *Policy {
		var id, name, kind string
		var rpo, retention int
		if sc.PlanEntity != nil && sc.PlanEntity.PlanID > 0 {
			id, name, kind = planPrefix+strconv.Itoa(sc.PlanEntity.PlanID), sc.PlanEntity.PlanName, KindPlan
			if p, ok := planByID[sc.PlanEntity.PlanID]; ok {
				rpo = p.RpoInMinutes
				name = nonEmpty(p.Plan.PlanName, name)
				for _, c := range p.Storage.Copy {
					if c.RetentionRules.RetainBackupDataForDays > retention {
						retention = c.RetentionRules.RetainBackupDataForDays
					}
				}
			}
		} else {
			sp := sc.CommonProperties.StorageDevice.DataBackupStoragePolicy
			if sp.StoragePolicyID == 0 && sp.StoragePolicyName == "" {
				return nil
			}
			id, name, kind = storagePrefix+strconv.Itoa(sp.StoragePolicyID), sp.StoragePolicyName, KindStoragePolicy
		}
		p, ok := policies[id]
		if !ok {
			p = &Policy{ID: id, Name: name, Kind: kind, RpoMinutes: rpo, RetentionDays: retention, LastResult: ResultNone}
			policies[id] = p
			order = append(order, id)
		}
		return p
	}
	for _, cl := range clients.ClientProperties {
		ce := cl.Client.ClientEntity
		var subs struct {
			SubClientProperties []commvaultSubclient `json:"subClientProperties"`
		}
		if err := cv.c.Get(ctx, cv.prefix+"/Subclient?"+url.Values{"clientId": {strconv.Itoa(ce.ClientID)}}.Encode(), &subs); err != nil {
			if restjson.IsNotFound(err) {
				continue
			}
			return "", nil, nil, err
		}
		if len(subs.SubClientProperties) == 0 {
			continue
		}
		var jobs struct {
			Jobs []commvaultJob `json:"jobs"`
		}
		if err := cv.c.Get(ctx, cv.prefix+"/Job?"+url.Values{"clientId": {strconv.Itoa(ce.ClientID)}, "jobFilter": {"Backup"}}.Encode(), &jobs); err != nil && !restjson.IsNotFound(err) {
			return "", nil, nil, err
		}
		jobsBySub := map[int][]commvaultJob{}
		for _, j := range jobs.Jobs {
			jobsBySub[j.JobSummary.Subclient.SubclientID] = append(jobsBySub[j.JobSummary.Subclient.SubclientID], j)
		}
		// One object per (client, policy).
		objects := map[string]*Object{}
		for _, sc := range subs.SubClientProperties {
			p := policyFor(sc)
			if p == nil {
				continue
			}
			enabled := sc.CommonProperties.EnableBackup == nil || *sc.CommonProperties.EnableBackup
			p.Enabled = p.Enabled || enabled
			o, ok := objects[p.ID]
			if !ok {
				o = &Object{Kind: typeHost, Name: nonEmpty(ce.ClientName, ce.HostName), FQDN: ce.HostName, LastResult: ResultNone}
				if isAddress(ce.HostName) {
					o.FQDN, o.IP = "", ce.HostName
				}
				objects[p.ID] = o
			}
			e := sc.SubClientEntity
			o.Agents = union(o.Agents, []string{e.AppName})
			o.Subclients = union(o.Subclients, []string{strings.Join([]string{e.AppName, e.BackupsetName, e.SubclientName}, "/")})
			for _, j := range jobsBySub[e.SubclientID] {
				js := j.JobSummary
				result := CommvaultResult(js.Status)
				end := unix(js.JobEndTime)
				at := later(end, unix(js.JobStartTime))
				if result == ResultSuccess || result == ResultWarning {
					o.LastGoodBackupAt = later(o.LastGoodBackupAt, end)
					o.RestorePoints++
				}
				if at != nil && (o.LastBackupAt == nil || at.After(*o.LastBackupAt)) {
					o.LastBackupAt, o.LastResult = at, result
				}
				if at != nil && (p.LastRunAt == nil || at.After(*p.LastRunAt)) {
					p.LastRunAt, p.LastResult = at, result
				}
			}
		}
		ids := make([]string, 0, len(objects))
		for id := range objects {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			policies[id].Objects = append(policies[id].Objects, *objects[id])
		}
	}
	// Plans that protect nothing yet are policies too.
	for _, p := range plans.Plans {
		id := planPrefix + strconv.Itoa(p.Plan.PlanID)
		if _, ok := policies[id]; ok || p.Plan.PlanID == 0 {
			continue
		}
		retention := 0
		for _, c := range p.Storage.Copy {
			if c.RetentionRules.RetainBackupDataForDays > retention {
				retention = c.RetentionRules.RetainBackupDataForDays
			}
		}
		policies[id] = &Policy{ID: id, Name: p.Plan.PlanName, Kind: KindPlan, RpoMinutes: p.RpoInMinutes, RetentionDays: retention, LastResult: ResultNone}
		order = append(order, id)
	}
	out := make([]Policy, 0, len(order))
	for _, id := range order {
		out = append(out, *policies[id])
	}
	return cv.serverID, out, cv.c.Raw(), nil
}

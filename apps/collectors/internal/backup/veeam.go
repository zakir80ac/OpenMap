// REQ-INT-017 — Veeam Backup & Replication REST API v1 adapter (ADR-075), as Veeam's published reference describes it:
// an OAuth 2.0 password grant at /api/oauth2/token, the x-api-version header on every call, skip/limit paging with a
// `pagination` block. Policies are backup jobs: their schedule gives the RPO, their retention policy the days or restore
// points kept, /jobs/states the last run. A job's protected objects are the VMs it includes and the objects of its
// backups; each backup object's newest restore point is its last good backup (restore points exist only for runs that
// succeeded or finished with a warning).
package backup

import (
	"context"
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
	veeamPort       = 9419
	veeamAPIVersion = "1.1-rev2"
	veeamHeader     = "x-api-version"
	veeamToken      = "/api/oauth2/token"
	veeamPrefix     = "/api/v1"
	veeamPage       = 200
	veeamVM         = "VirtualMachine"
	veeamDays       = "Days"
	veeamPoints     = "RestorePoints"
	veeamHours      = "Hours"
	veeamMinutes    = "Minutes"
	veeamPathSep    = "\\"
)

type veeam struct {
	c *restjson.Client
}

func newVeeam(ctx context.Context, target, apiVersion string, cred *contract.Credential, tls tlsOptions) (Adapter, error) {
	if cred == nil || cred.Fields[credUser] == "" || cred.Fields[credPass] == "" {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "veeam requires a password credential with username and password")
	}
	apiVersion = nonEmpty(apiVersion, veeamAPIVersion)
	base, _, err := baseURL(target, veeamPort)
	if err != nil {
		return nil, err
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	form := url.Values{"grant_type": {"password"}, "username": {cred.Fields[credUser]}, "password": {cred.Fields[credPass]}}
	if _, err := login(ctx, base+veeamToken, "application/x-www-form-urlencoded", formBody(form), map[string]string{veeamHeader: apiVersion}, tls, &tok); err != nil {
		return nil, err
	}
	if tok.AccessToken == "" {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "veeam returned no access_token")
	}
	c, err := tls.client(base, veeamPort, restjson.Auth{Bearer: tok.AccessToken}, map[string]string{veeamHeader: apiVersion})
	if err != nil {
		return nil, err
	}
	return &veeam{c: c}, nil
}

type veeamPageOf[T any] struct {
	Data       []T `json:"data"`
	Pagination struct {
		Total int `json:"total"`
		Count int `json:"count"`
		Skip  int `json:"skip"`
		Limit int `json:"limit"`
	} `json:"pagination"`
}

func veeamAll[T any](ctx context.Context, c *restjson.Client, path string, out *[]T) error {
	skip := 0
	for {
		q := url.Values{"skip": {strconv.Itoa(skip)}, "limit": {strconv.Itoa(veeamPage)}}
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		var page veeamPageOf[T]
		if err := c.Get(ctx, path+sep+q.Encode(), &page); err != nil {
			return err
		}
		*out = append(*out, page.Data...)
		skip += len(page.Data)
		if len(page.Data) == 0 || skip >= page.Pagination.Total {
			return nil
		}
	}
}

type veeamInventoryObject struct {
	Type     string `json:"type"`
	HostName string `json:"hostName"`
	Name     string `json:"name"`
	ObjectID string `json:"objectId"`
}

type veeamJob struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	IsDisabled      bool   `json:"isDisabled"`
	VirtualMachines struct {
		Includes []struct {
			InventoryObject veeamInventoryObject `json:"inventoryObject"`
		} `json:"includes"`
	} `json:"virtualMachines"`
	Storage struct {
		RetentionPolicy struct {
			Type     string `json:"type"`
			Quantity int    `json:"quantity"`
		} `json:"retentionPolicy"`
	} `json:"storage"`
	Schedule struct {
		RunAutomatically bool `json:"runAutomatically"`
		Daily            struct {
			IsEnabled bool `json:"isEnabled"`
		} `json:"daily"`
		Monthly struct {
			IsEnabled bool `json:"isEnabled"`
		} `json:"monthly"`
		Periodically struct {
			IsEnabled        bool   `json:"isEnabled"`
			PeriodicallyKind string `json:"periodicallyKind"`
			Frequency        int    `json:"frequency"`
		} `json:"periodically"`
	} `json:"schedule"`
}

type veeamJobState struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	LastRun    string `json:"lastRun"`
	LastResult string `json:"lastResult"`
}

type veeamBackup struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	JobID string `json:"jobId"`
}

type veeamBackupObject struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Type               string `json:"type"`
	ViType             string `json:"viType"`
	ObjectID           string `json:"objectId"`
	Path               string `json:"path"`
	RestorePointsCount int    `json:"restorePointsCount"`
}

type veeamRestorePoint struct {
	ID           string `json:"id"`
	CreationTime string `json:"creationTime"`
}

// VeeamRpoMinutes is the interval a job's schedule runs at: periodic runs every N hours or minutes, daily, monthly.
func VeeamRpoMinutes(j veeamJob) int {
	s := j.Schedule
	switch {
	case s.Periodically.IsEnabled && s.Periodically.Frequency > 0 && strings.EqualFold(s.Periodically.PeriodicallyKind, veeamMinutes):
		return s.Periodically.Frequency
	case s.Periodically.IsEnabled && s.Periodically.Frequency > 0 && strings.EqualFold(s.Periodically.PeriodicallyKind, veeamHours):
		return s.Periodically.Frequency * minutesPerHour
	case s.Daily.IsEnabled:
		return minutesPerDay
	case s.Monthly.IsEnabled:
		return minutesPerMonth
	}
	return 0
}

// VeeamResult maps Veeam's job result and status to the normalised result.
func VeeamResult(result, status string) string {
	if strings.EqualFold(status, "Running") || strings.EqualFold(status, "Starting") || strings.EqualFold(status, "Stopping") {
		return ResultRunning
	}
	switch strings.ToLower(result) {
	case "success":
		return ResultSuccess
	case "warning":
		return ResultWarning
	case "failed":
		return ResultFailed
	}
	return ResultNone
}

func parseTime(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			u := t.UTC()
			return &u
		}
	}
	return nil
}

// vcenterOf is the first segment of a Veeam object path ("vc01.corp\Datacenter\Cluster\vm").
func vcenterOf(path string) string {
	first, _, _ := strings.Cut(strings.TrimLeft(path, veeamPathSep), veeamPathSep)
	return first
}

func (v *veeam) Read(ctx context.Context) (string, []Policy, [][]byte, error) {
	var info struct {
		VbrID string `json:"vbrId"`
		Name  string `json:"name"`
	}
	if err := v.c.Get(ctx, veeamPrefix+"/serverInfo", &info); err != nil {
		return "", nil, nil, err
	}
	serverID := nonEmpty(info.VbrID, info.Name)
	var jobs []veeamJob
	if err := veeamAll(ctx, v.c, veeamPrefix+"/jobs", &jobs); err != nil {
		return "", nil, nil, err
	}
	var states []veeamJobState
	if err := veeamAll(ctx, v.c, veeamPrefix+"/jobs/states", &states); err != nil {
		return "", nil, nil, err
	}
	stateByJob := map[string]veeamJobState{}
	for _, s := range states {
		stateByJob[s.ID] = s
	}
	var backups []veeamBackup
	if err := veeamAll(ctx, v.c, veeamPrefix+"/backups", &backups); err != nil {
		return "", nil, nil, err
	}
	objectsByJob := map[string][]Object{}
	for _, b := range backups {
		if b.JobID == "" {
			continue
		}
		var objs []veeamBackupObject
		if err := veeamAll(ctx, v.c, veeamPrefix+"/backups/"+url.PathEscape(b.ID)+"/objects", &objs); err != nil {
			return "", nil, nil, err
		}
		for _, o := range objs {
			var points []veeamRestorePoint
			if err := veeamAll(ctx, v.c, veeamPrefix+"/backupObjects/"+url.PathEscape(o.ID)+"/restorePoints", &points); err != nil {
				return "", nil, nil, err
			}
			var newest *time.Time
			for _, p := range points {
				newest = later(newest, parseTime(p.CreationTime))
			}
			kind := typeHost
			if o.ViType == veeamVM || strings.EqualFold(o.Type, "VM") {
				kind = typeVM
			}
			objectsByJob[b.JobID] = append(objectsByJob[b.JobID], Object{
				Kind: kind, Name: o.Name, VCenter: vcenterOf(o.Path), MoRef: o.ObjectID,
				LastGoodBackupAt: newest, LastBackupAt: newest, RestorePoints: len(points),
			})
		}
	}
	policies := make([]Policy, 0, len(jobs))
	for _, j := range jobs {
		st := stateByJob[j.ID]
		p := Policy{ID: j.ID, Name: j.Name, Kind: KindJob, RpoMinutes: VeeamRpoMinutes(j), Enabled: !j.IsDisabled,
			LastRunAt: parseTime(st.LastRun), LastResult: VeeamResult(st.LastResult, st.Status)}
		switch {
		case strings.EqualFold(j.Storage.RetentionPolicy.Type, veeamDays):
			p.RetentionDays = j.Storage.RetentionPolicy.Quantity
		case strings.EqualFold(j.Storage.RetentionPolicy.Type, veeamPoints):
			p.RetentionPoints = j.Storage.RetentionPolicy.Quantity
		}
		seen := map[string]bool{}
		for _, o := range objectsByJob[j.ID] {
			o.LastResult = p.LastResult
			if o.LastGoodBackupAt == nil {
				o.LastResult = ResultNone
			}
			seen[VCenterKey(o.VCenter, o.MoRef)] = true
			seen[norm(o.Name)] = true
			p.Objects = append(p.Objects, o)
		}
		// VMs the job includes that none of its backups holds yet: covered, never backed up.
		for _, inc := range j.VirtualMachines.Includes {
			obj := inc.InventoryObject
			if obj.Type != veeamVM || seen[VCenterKey(obj.HostName, obj.ObjectID)] || seen[norm(obj.Name)] {
				continue
			}
			p.Objects = append(p.Objects, Object{Kind: typeVM, Name: obj.Name, VCenter: obj.HostName, MoRef: obj.ObjectID, LastResult: ResultNone})
		}
		sort.SliceStable(p.Objects, func(a, b int) bool { return p.Objects[a].Name < p.Objects[b].Name })
		policies = append(policies, p)
	}
	return serverID, policies, v.c.Raw(), nil
}

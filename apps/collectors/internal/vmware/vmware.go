// REQ-DISC-005 — VMware vCenter collector over the vSphere Automation REST API (7.0+ `/api`, with
// the 6.5–6.7 `/rest` envelope as a fallback). One target = one vCenter. Emits clusters, ESXi
// hypervisors, VMs with guest OS, NIC MACs and IPs, VMFS/NFS/vSAN datastores, and the
// member_of / runs_on / installed_on / uses_ip / mounted_on relationships between them.
package vmware

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID         = "vmware"
	version             = "0.1.0"
	platform            = "vmware"
	httpTimeout         = 60 * time.Second
	defaultPort         = 443
	defaultDetailFanOut = 8
	optionPort          = "port"
	optionVerify        = "verifyTls"
	optionFanOut        = "detailConcurrency"
	credUser            = "username"
	credPassword        = "password"
	evidenceKind        = "api_response"
	sessionHeader       = "vmware-api-session-id"

	typeCluster    = "vm_cluster"
	typeHypervisor = "hypervisor"
	typeVM         = "vm"
	typeOS         = "operating_system"
	typeIP         = "ip_address"
	typeLun        = "lun"
	typeNas        = "nas_share"
	relMemberOf    = "member_of"
	relRunsOn      = "runs_on"
	relInstalledOn = "installed_on"
	relUsesIP      = "uses_ip"
	relMountedOn   = "mounted_on"
	relHostedOn    = "hosted_on"

	datastoreNFS   = "NFS"
	datastoreNFS41 = "NFS41"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "vmware", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeCluster, typeHypervisor, typeVM, typeOS, typeIP, typeLun, typeNas},
		ContractVersion: contract.Version,
	}
}

// Client talks to one vCenter. `legacy` is set when the server only speaks the /rest envelope.
type Client struct {
	base   *url.URL
	http   *http.Client
	user   string
	pass   string
	token  string
	legacy bool
	mu     sync.Mutex
	raw    [][]byte
}

func NewClient(host string, port int, user, pass string, verifyTLS bool) *Client {
	base := &url.URL{Scheme: "https", Host: net.JoinHostPort(host, strconv.Itoa(port))}
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: !verifyTLS, MinVersion: tls.VersionTLS12}} //nolint:gosec // vCenter appliances commonly run the VMCA self-signed chain; verifyTls=true enforces it.
	return &Client{base: base, http: &http.Client{Timeout: httpTimeout, Transport: tr}, user: user, pass: pass}
}

func (c *Client) record(raw []byte) {
	c.mu.Lock()
	c.raw = append(c.raw, raw)
	c.mu.Unlock()
}

// path maps a 7.0 `/api/...` path onto the legacy `/rest/...` namespace when needed.
func (c *Client) path(p string) string {
	if !c.legacy {
		return p
	}
	if p == "/api/session" {
		return "/rest/com/vmware/cis/session"
	}
	return "/rest" + strings.TrimPrefix(p, "/api")
}

func (c *Client) do(ctx context.Context, method, p string, body []byte, out any) ([]byte, int, error) {
	rel, err := url.Parse(c.path(p))
	if err != nil {
		return nil, 0, err
	}
	u := c.base.ResolveReference(rel)
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rdr)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set(sessionHeader, c.token)
	} else {
		req.SetBasicAuth(c.user, c.pass)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	if res.StatusCode >= http.StatusBadRequest {
		return raw, res.StatusCode, nil
	}
	c.record(raw)
	if out != nil && len(raw) > 0 {
		payload := raw
		if c.legacy {
			var env struct {
				Value json.RawMessage `json:"value"`
			}
			if err := json.Unmarshal(raw, &env); err == nil && len(env.Value) > 0 {
				payload = env.Value
			}
		}
		if err := json.Unmarshal(payload, out); err != nil {
			return raw, res.StatusCode, collector.Errorf(contract.ErrParse, false, "%s: invalid JSON at %s: %v", c.base.Host, p, err)
		}
	}
	return raw, res.StatusCode, nil
}

// Login creates an API session, trying the 7.0 endpoint and then the legacy envelope.
func (c *Client) Login(ctx context.Context) error {
	for _, legacy := range []bool{false, true} {
		c.legacy = legacy
		var token string
		_, status, err := c.do(ctx, http.MethodPost, "/api/session", []byte("{}"), &token)
		if err != nil {
			return err
		}
		switch {
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential (%d)", c.base.Host, status)
		case status == http.StatusNotFound:
			continue
		case status >= http.StatusBadRequest:
			return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d on session create", c.base.Host, status)
		}
		if token == "" {
			return collector.Errorf(contract.ErrParse, false, "%s returned an empty session token", c.base.Host)
		}
		c.token = token
		return nil
	}
	return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s exposes neither /api nor /rest vSphere Automation endpoints", c.base.Host)
}

func (c *Client) Logout(ctx context.Context) {
	if c.token == "" {
		return
	}
	_, _, _ = c.do(ctx, http.MethodDelete, "/api/session", nil, nil)
	c.token = ""
}

func (c *Client) get(ctx context.Context, p string, out any) error {
	_, status, err := c.do(ctx, http.MethodGet, p, nil, out)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return collector.Errorf(contract.ErrPermissionDenied, false, "%s denied %s (%d)", c.base.Host, p, status)
	}
	if status >= http.StatusBadRequest {
		return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d for %s", c.base.Host, status, p)
	}
	return nil
}

type ClusterSummary struct {
	Cluster    string `json:"cluster"`
	Name       string `json:"name"`
	DrsEnabled bool   `json:"drs_enabled"`
	HaEnabled  bool   `json:"ha_enabled"`
}

type HostSummary struct {
	Host            string `json:"host"`
	Name            string `json:"name"`
	ConnectionState string `json:"connection_state"`
	PowerState      string `json:"power_state"`
}

type VMSummary struct {
	VM            string `json:"vm"`
	Name          string `json:"name"`
	PowerState    string `json:"power_state"`
	CPUCount      int    `json:"cpu_count"`
	MemorySizeMiB int    `json:"memory_size_MiB"`
}

type VMDetail struct {
	GuestOS  string `json:"guest_OS"`
	Hardware struct {
		Version string `json:"version"`
	} `json:"hardware"`
	Identity struct {
		Name         string `json:"name"`
		InstanceUUID string `json:"instance_uuid"`
		BiosUUID     string `json:"bios_uuid"`
	} `json:"identity"`
	Nics map[string]struct {
		MacAddress string `json:"mac_address"`
		State      string `json:"state"`
		Backing    struct {
			Network     string `json:"network"`
			NetworkName string `json:"network_name"`
		} `json:"backing"`
	} `json:"nics"`
	Disks map[string]struct {
		Capacity int64 `json:"capacity"`
		Backing  struct {
			VmdkFile string `json:"vmdk_file"`
		} `json:"backing"`
	} `json:"disks"`
	CPU struct {
		Count int `json:"count"`
	} `json:"cpu"`
	Memory struct {
		SizeMiB int `json:"size_MiB"`
	} `json:"memory"`
}

type GuestIdentity struct {
	Name     string `json:"name"`
	Family   string `json:"family"`
	FullName struct {
		DefaultMessage string `json:"default_message"`
	} `json:"full_name"`
	HostName  string `json:"host_name"`
	IPAddress string `json:"ip_address"`
}

type GuestInterface struct {
	MacAddress string `json:"mac_address"`
	IP         struct {
		IPAddresses []struct {
			IPAddress    string `json:"ip_address"`
			PrefixLength int    `json:"prefix_length"`
		} `json:"ip_addresses"`
	} `json:"ip"`
}

type DatastoreSummary struct {
	Datastore string `json:"datastore"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Capacity  int64  `json:"capacity"`
	FreeSpace int64  `json:"free_space"`
}

type VersionInfo struct {
	Version string `json:"version"`
	Build   string `json:"build"`
	Product string `json:"product"`
}

type VMRecord struct {
	Summary VMSummary
	Detail  VMDetail
	Guest   *GuestIdentity
	Ifaces  []GuestInterface
	Host    string
}

// Inventory is one vCenter's content as gathered by Walk.
type Inventory struct {
	Version     VersionInfo
	Clusters    []ClusterSummary
	Hosts       []HostSummary
	HostCluster map[string]string // host moRef → cluster moRef
	VMs         []VMRecord
	Datastores  []DatastoreSummary
	Raw         [][]byte
}

// Walk lists clusters, hosts per cluster, VMs per host (keeps every list under the API's item cap),
// and datastores; VM detail calls fan out with bounded concurrency.
func (c *Client) Walk(ctx context.Context, fanOut int) (*Inventory, error) {
	inv := &Inventory{HostCluster: map[string]string{}}
	_ = c.get(ctx, "/api/appliance/system/version", &inv.Version) // optional: needs the appliance privilege
	if err := c.get(ctx, "/api/vcenter/cluster", &inv.Clusters); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, cl := range inv.Clusters {
		var hosts []HostSummary
		if err := c.get(ctx, "/api/vcenter/host?clusters="+url.QueryEscape(cl.Cluster), &hosts); err != nil {
			return nil, err
		}
		for _, h := range hosts {
			inv.HostCluster[h.Host] = cl.Cluster
			if !seen[h.Host] {
				seen[h.Host] = true
				inv.Hosts = append(inv.Hosts, h)
			}
		}
	}
	var standalone []HostSummary
	if err := c.get(ctx, "/api/vcenter/host", &standalone); err != nil {
		return nil, err
	}
	for _, h := range standalone {
		if !seen[h.Host] {
			seen[h.Host] = true
			inv.Hosts = append(inv.Hosts, h)
		}
	}
	if err := c.get(ctx, "/api/vcenter/datastore", &inv.Datastores); err != nil {
		return nil, err
	}
	var summaries []VMRecord
	for _, h := range inv.Hosts {
		var vms []VMSummary
		if err := c.get(ctx, "/api/vcenter/vm?hosts="+url.QueryEscape(h.Host), &vms); err != nil {
			return nil, err
		}
		for _, vm := range vms {
			summaries = append(summaries, VMRecord{Summary: vm, Host: h.Host})
		}
	}
	if fanOut < 1 {
		fanOut = defaultDetailFanOut
	}
	sem := make(chan struct{}, fanOut)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for i := range summaries {
		wg.Add(1)
		sem <- struct{}{}
		go func(rec *VMRecord) {
			defer wg.Done()
			defer func() { <-sem }()
			id := rec.Summary.VM
			if err := c.get(ctx, "/api/vcenter/vm/"+id, &rec.Detail); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
				return
			}
			var guest GuestIdentity
			if err := c.get(ctx, "/api/vcenter/vm/"+id+"/guest/identity", &guest); err == nil && guest.Name != "" {
				rec.Guest = &guest
			}
			var ifaces []GuestInterface
			if err := c.get(ctx, "/api/vcenter/vm/"+id+"/guest/networking/interfaces", &ifaces); err == nil {
				rec.Ifaces = ifaces
			}
		}(&summaries[i])
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	inv.VMs = summaries
	c.mu.Lock()
	inv.Raw = c.raw
	c.mu.Unlock()
	return inv, nil
}

// datastoreName extracts "datastore1" from "[datastore1] folder/disk.vmdk".
func datastoreName(vmdk string) string {
	if !strings.HasPrefix(vmdk, "[") {
		return ""
	}
	end := strings.Index(vmdk, "]")
	if end < 0 {
		return ""
	}
	return vmdk[1:end]
}

func datastoreRef(vcenter string, d DatastoreSummary) (string, map[string]string) {
	switch d.Type {
	case datastoreNFS, datastoreNFS41:
		return typeNas, map[string]string{"arrayRef": vcenter, "protocol": "nfs", "path": d.Name}
	default:
		return typeLun, map[string]string{"arrayRef": vcenter, "wwn": vcenter + ":" + d.Datastore}
	}
}

// Emit converts an inventory into contract observations. The target address anchors every
// moRef-based identity so two vCenters never collide.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	vcenter := target.Value
	for _, raw := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: raw})
	}
	clusterRef := map[string]contract.CiRef{}
	for _, cl := range inv.Clusters {
		identity := map[string]string{"platform": platform, "clusterId": vcenter + ":" + cl.Cluster}
		clusterRef[cl.Cluster] = contract.CiRef{Type: typeCluster, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeCluster, Identity: identity, Name: cl.Name,
			Attributes: map[string]any{"platform": platform, "vcenter": vcenter, "moRef": cl.Cluster, "drsEnabled": cl.DrsEnabled, "haEnabled": cl.HaEnabled, "vcenterVersion": inv.Version.Version, "vcenterBuild": inv.Version.Build},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: cl.Cluster}}, ObservedAt: at})
	}
	hostRef := map[string]contract.CiRef{}
	for _, h := range inv.Hosts {
		identity := map[string]string{"platform": platform, "hostRef": h.Name, "moRef": vcenter + ":" + h.Host}
		hostRef[h.Host] = contract.CiRef{Type: typeHypervisor, Identity: identity}
		attrs := map[string]any{"platform": platform, "vcenter": vcenter, "moRef": h.Host, "connectionState": h.ConnectionState, "powerState": h.PowerState, "fqdn": h.Name}
		if cl, ok := inv.HostCluster[h.Host]; ok {
			attrs["clusterMoRef"] = cl
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHypervisor, Identity: identity, Name: h.Name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: h.Host}}, ObservedAt: at})
		// The ESXi hypervisor is hosted on the physical server that SNMP, Redfish or SSH report by fqdn.
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: hostRef[h.Host], To: contract.CiRef{Type: "host", Identity: map[string]string{"fqdn": h.Name}}, Attributes: map[string]any{}, ObservedAt: at})
		if cl, ok := inv.HostCluster[h.Host]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: hostRef[h.Host], To: clusterRef[cl], Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	dsByName := map[string]contract.CiRef{}
	for _, d := range inv.Datastores {
		t, identity := datastoreRef(vcenter, d)
		ref := contract.CiRef{Type: t, Identity: identity}
		dsByName[d.Name] = ref
		used := d.Capacity - d.FreeSpace
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: t, Identity: identity, Name: d.Name,
			Attributes: map[string]any{"platform": platform, "vcenter": vcenter, "moRef": d.Datastore, "datastoreType": d.Type, "capacityBytes": d.Capacity, "freeBytes": d.FreeSpace, "usedBytes": used},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: d.Datastore}}, ObservedAt: at})
	}
	for _, rec := range inv.VMs {
		s, d := rec.Summary, rec.Detail
		hv := hostRef[rec.Host]
		hvName := hv.Identity["hostRef"]
		identity := map[string]string{"hypervisorRef": hvName}
		if d.Identity.InstanceUUID != "" {
			identity["instanceUuid"] = strings.ToLower(d.Identity.InstanceUUID)
		} else {
			identity["instanceUuid"] = vcenter + ":" + s.VM
		}
		var macs []string
		var networks []string
		for _, n := range d.Nics {
			if n.MacAddress != "" {
				macs = append(macs, strings.ToLower(n.MacAddress))
			}
			if n.Backing.NetworkName != "" {
				networks = append(networks, n.Backing.NetworkName)
			}
		}
		var diskBytes int64
		datastores := map[string]bool{}
		for _, disk := range d.Disks {
			diskBytes += disk.Capacity
			if name := datastoreName(disk.Backing.VmdkFile); name != "" {
				datastores[name] = true
			}
		}
		attrs := map[string]any{
			"platform": platform, "vcenter": vcenter, "moRef": s.VM, "powerState": s.PowerState, "cpuCount": firstPositive(d.CPU.Count, s.CPUCount),
			"memoryMb": firstPositive(d.Memory.SizeMiB, s.MemorySizeMiB), "guestOsId": d.GuestOS, "hardwareVersion": d.Hardware.Version, "biosUuid": strings.ToLower(d.Identity.BiosUUID),
			"macAddresses": macs, "networks": networks, "diskBytes": diskBytes, "hypervisor": hvName, "diskCount": len(d.Disks),
		}
		name := s.Name
		if rec.Guest != nil {
			attrs["guestHostName"] = rec.Guest.HostName
			attrs["guestFullName"] = rec.Guest.FullName.DefaultMessage
			attrs["guestFamily"] = rec.Guest.Family
			if rec.Guest.HostName != "" {
				identity["fqdn"] = strings.ToLower(rec.Guest.HostName)
			}
		}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: platform, ID: s.VM}}, ObservedAt: at})
		if hv.Type != "" {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: vmRef, To: hv, Attributes: map[string]any{}, ObservedAt: at})
		}
		for dsName := range datastores {
			if ds, ok := dsByName[dsName]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMountedOn, From: vmRef, To: ds, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
		if rec.Guest != nil && rec.Guest.Family != "" {
			osIdentity := map[string]string{"hostRef": identity["instanceUuid"], "family": strings.ToLower(rec.Guest.Family), "version": firstNonEmpty(rec.Guest.FullName.DefaultMessage, rec.Guest.Name, d.GuestOS)}
			osRef := contract.CiRef{Type: typeOS, Identity: osIdentity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: osIdentity["version"], Attributes: map[string]any{"family": osIdentity["family"], "guestOsId": d.GuestOS, "source": "vmware-tools"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: osRef, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, iface := range rec.Ifaces {
			for _, ip := range iface.IP.IPAddresses {
				if ip.IPAddress == "" {
					continue
				}
				ipIdentity := map[string]string{"address": ip.IPAddress, "vrfRef": "default"}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: ip.IPAddress, Attributes: map[string]any{"prefixLength": ip.PrefixLength, "mac": strings.ToLower(iface.MacAddress), "assignedTo": name}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
	}
	return obs
}

func firstPositive(values ...int) int {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func intOption(options map[string]any, key string, fallback int) int {
	if v, ok := options[key]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(v)); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil || cred.Type != "password" || cred.Fields[credUser] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "vmware requires a password credential with a username")
	}
	verify, _ := options[optionVerify].(bool)
	c := NewClient(target.Value, intOption(options, optionPort, defaultPort), cred.Fields[credUser], cred.Fields[credPassword], verify)
	if err := c.Login(ctx); err != nil {
		return collector.Observation{}, classify(target, err)
	}
	defer c.Logout(ctx)
	inv, err := c.Walk(ctx, intOption(options, optionFanOut, defaultDetailFanOut))
	if err != nil {
		return collector.Observation{}, classify(target, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}

func classify(target contract.Target, err error) error {
	var te *collector.TargetError
	if errors.As(err, &te) {
		return err
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return collector.Errorf(contract.ErrTimeout, true, "%s timed out", target.Value)
	}
	return collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
}

// REQ-DISC-014 REQ-DISC-016 — NetApp ONTAP collector over the ONTAP REST API (9.6+): cluster and
// nodes, SVMs, aggregates, volumes, LUNs with igroup maps (presented_to hosts), NFS/CIFS shares as
// nas_share CIs and data LIF addresses. One target = one cluster management LIF.
package ontap

import (
	"context"
	"encoding/hex"
	"net/url"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "storage"
	version      = "0.1.0"
	vendor       = "netapp_ontap"
	evidenceKind = "api_response"
	defaultPort  = 443
	optionVerify = "verifyTls"
	optionCA     = "caCertPem"
	credUser     = "username"
	credPassword = "password"
	naaPrefix    = "naa.600a0980" // NetApp OUI; the hex-encoded LUN serial follows
	maxRecords   = 1000
	defaultVrf   = "default"

	typeArray    = "storage_array"
	typeLun      = "lun"
	typeShare    = "nas_share"
	typeHost     = "host"
	typeIP       = "ip_address"
	relContains  = "contains"
	relPresented = "presented_to"
	relUsesIP    = "uses_ip"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "storage", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeArray, typeLun, typeShare, typeHost, typeIP},
		ContractVersion: contract.Version,
	}
}

type named struct {
	Name string `json:"name"`
	UUID string `json:"uuid"`
}

type records[T any] struct {
	Records []T `json:"records"`
	Links   struct {
		Next struct {
			Href string `json:"href"`
		} `json:"next"`
	} `json:"_links"`
}

type clusterDoc struct {
	Name    string `json:"name"`
	UUID    string `json:"uuid"`
	Version struct {
		Full       string `json:"full"`
		Generation int    `json:"generation"`
		Major      int    `json:"major"`
		Minor      int    `json:"minor"`
	} `json:"version"`
}

type nodeDoc struct {
	Name         string `json:"name"`
	UUID         string `json:"uuid"`
	SerialNumber string `json:"serial_number"`
	Model        string `json:"model"`
	State        string `json:"state"`
	HA           struct {
		Partners []named `json:"partners"`
	} `json:"ha"`
}

type svmDoc struct {
	Name  string `json:"name"`
	UUID  string `json:"uuid"`
	State string `json:"state"`
	NFS   struct {
		Enabled bool `json:"enabled"`
	} `json:"nfs"`
	CIFS struct {
		Enabled bool `json:"enabled"`
	} `json:"cifs"`
	ISCSI struct {
		Enabled bool `json:"enabled"`
	} `json:"iscsi"`
	FCP struct {
		Enabled bool `json:"enabled"`
	} `json:"fcp"`
}

type space struct {
	Size      int64 `json:"size"`
	Used      int64 `json:"used"`
	Available int64 `json:"available"`
}

type aggregateDoc struct {
	Name  string `json:"name"`
	UUID  string `json:"uuid"`
	State string `json:"state"`
	Node  named  `json:"node"`
	Space struct {
		BlockStorage space `json:"block_storage"`
	} `json:"space"`
}

type volumeDoc struct {
	Name       string  `json:"name"`
	UUID       string  `json:"uuid"`
	State      string  `json:"state"`
	Type       string  `json:"type"`
	Style      string  `json:"style"`
	SVM        named   `json:"svm"`
	Aggregates []named `json:"aggregates"`
	Space      space   `json:"space"`
	NAS        struct {
		Path          string `json:"path"`
		SecurityStyle string `json:"security_style"`
		ExportPolicy  named  `json:"export_policy"`
	} `json:"nas"`
}

type lunDoc struct {
	Name         string `json:"name"`
	UUID         string `json:"uuid"`
	SerialNumber string `json:"serial_number"`
	OSType       string `json:"os_type"`
	Enabled      bool   `json:"enabled"`
	SVM          named  `json:"svm"`
	Space        space  `json:"space"`
	Status       struct {
		State  string `json:"state"`
		Mapped bool   `json:"mapped"`
	} `json:"status"`
	Location struct {
		Volume named `json:"volume"`
	} `json:"location"`
}

type lunMapDoc struct {
	Lun struct {
		Name string `json:"name"`
		UUID string `json:"uuid"`
	} `json:"lun"`
	Igroup struct {
		Name string `json:"name"`
		UUID string `json:"uuid"`
	} `json:"igroup"`
	LogicalUnitNumber int `json:"logical_unit_number"`
}

type igroupDoc struct {
	Name       string `json:"name"`
	UUID       string `json:"uuid"`
	OSType     string `json:"os_type"`
	Protocol   string `json:"protocol"`
	Initiators []struct {
		Name string `json:"name"`
	} `json:"initiators"`
}

type cifsShareDoc struct {
	Name string `json:"name"`
	Path string `json:"path"`
	SVM  named  `json:"svm"`
}

type ipInterfaceDoc struct {
	Name string `json:"name"`
	IP   struct {
		Address string `json:"address"`
		Netmask string `json:"netmask"`
	} `json:"ip"`
	SVM      named    `json:"svm"`
	Services []string `json:"services"`
	State    string   `json:"state"`
}

// Inventory is one cluster's content.
type Inventory struct {
	Cluster    clusterDoc
	Nodes      []nodeDoc
	SVMs       []svmDoc
	Aggregates []aggregateDoc
	Volumes    []volumeDoc
	Luns       []lunDoc
	LunMaps    []lunMapDoc
	Igroups    []igroupDoc
	CifsShares []cifsShareDoc
	Interfaces []ipInterfaceDoc
	Raw        [][]byte
}

func listAll[T any](ctx context.Context, c *restjson.Client, path string, fields string, out *[]T) error {
	q := url.Values{}
	q.Set("fields", fields)
	q.Set("max_records", "1000")
	next := path + "?" + q.Encode()
	for next != "" {
		var page records[T]
		if err := c.Get(ctx, next, &page); err != nil {
			return err
		}
		*out = append(*out, page.Records...)
		next = page.Links.Next.Href
	}
	return nil
}

// Walk reads the cluster; SAN and CIFS lists are optional (licence or role may hide them).
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	inv := &Inventory{}
	if err := c.Get(ctx, "/api/cluster?fields=name,uuid,version", &inv.Cluster); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, "/api/cluster/nodes", "name,uuid,serial_number,model,state,ha.partners", &inv.Nodes); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, "/api/svm/svms", "name,uuid,state,nfs.enabled,cifs.enabled,iscsi.enabled,fcp.enabled", &inv.SVMs); err != nil {
		return nil, err
	}
	_ = listAll(ctx, c, "/api/storage/aggregates", "name,uuid,state,node,space.block_storage", &inv.Aggregates)
	if err := listAll(ctx, c, "/api/storage/volumes", "name,uuid,state,type,style,svm,aggregates,space,nas.path,nas.security_style,nas.export_policy", &inv.Volumes); err != nil {
		return nil, err
	}
	_ = listAll(ctx, c, "/api/storage/luns", "name,uuid,serial_number,os_type,enabled,svm,space,status,location.volume", &inv.Luns)
	_ = listAll(ctx, c, "/api/protocols/san/lun-maps", "lun,igroup,logical_unit_number", &inv.LunMaps)
	_ = listAll(ctx, c, "/api/protocols/san/igroups", "name,uuid,os_type,protocol,initiators", &inv.Igroups)
	_ = listAll(ctx, c, "/api/protocols/cifs/shares", "name,path,svm", &inv.CifsShares)
	_ = listAll(ctx, c, "/api/network/ip/interfaces", "name,ip,svm,services,state", &inv.Interfaces)
	inv.Raw = c.Raw()
	return inv, nil
}

// WWN renders an ONTAP LUN serial as the NAA identifier hosts see.
func WWN(serial string) string {
	return naaPrefix + hex.EncodeToString([]byte(serial))
}

// Serial is the array identity: the first node serial, else the cluster UUID.
func Serial(inv *Inventory) string {
	for _, n := range inv.Nodes {
		if n.SerialNumber != "" {
			return n.SerialNumber
		}
	}
	return inv.Cluster.UUID
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	serial := Serial(inv)
	arrayIdentity := map[string]string{"serialNumber": serial}
	arrayRef := contract.CiRef{Type: typeArray, Identity: arrayIdentity}
	nodes := []map[string]any{}
	model := ""
	for _, n := range inv.Nodes {
		nodes = append(nodes, map[string]any{"name": n.Name, "serial": n.SerialNumber, "model": n.Model, "state": n.State})
		model = n.Model
	}
	var capacity, used int64
	aggregates := []map[string]any{}
	for _, a := range inv.Aggregates {
		capacity += a.Space.BlockStorage.Size
		used += a.Space.BlockStorage.Used
		aggregates = append(aggregates, map[string]any{"name": a.Name, "node": a.Node.Name, "state": a.State, "sizeBytes": a.Space.BlockStorage.Size, "usedBytes": a.Space.BlockStorage.Used})
	}
	svms := []map[string]any{}
	svmProtocols := map[string][]string{}
	for _, s := range inv.SVMs {
		protos := []string{}
		if s.NFS.Enabled {
			protos = append(protos, "nfs")
		}
		if s.CIFS.Enabled {
			protos = append(protos, "cifs")
		}
		if s.ISCSI.Enabled {
			protos = append(protos, "iscsi")
		}
		if s.FCP.Enabled {
			protos = append(protos, "fcp")
		}
		svmProtocols[s.Name] = protos
		svms = append(svms, map[string]any{"name": s.Name, "state": s.State, "protocols": protos})
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeArray, Identity: arrayIdentity, Name: inv.Cluster.Name,
		Attributes: map[string]any{"vendor": vendor, "model": model, "version": inv.Cluster.Version.Full, "clusterUuid": inv.Cluster.UUID, "nodes": nodes, "nodeCount": len(inv.Nodes), "aggregates": aggregates, "capacityBytes": capacity, "usedBytes": used, "svms": svms, "volumeCount": len(inv.Volumes), "lunCount": len(inv.Luns), "managementIp": target.Value},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: inv.Cluster.UUID}}, ObservedAt: at})

	for _, i := range inv.Interfaces {
		if i.IP.Address == "" {
			continue
		}
		ipIdentity := map[string]string{"address": i.IP.Address, "vrfRef": defaultVrf}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: i.IP.Address, Attributes: map[string]any{"lif": i.Name, "svm": i.SVM.Name, "services": i.Services, "state": i.State, "assignedTo": inv.Cluster.Name, "netmask": i.IP.Netmask}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: arrayRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{"lif": i.Name}, ObservedAt: at})
	}

	volumeByName := map[string]volumeDoc{}
	for _, v := range inv.Volumes {
		volumeByName[v.SVM.Name+"/"+v.Name] = v
		if v.NAS.Path == "" || v.NAS.Path == "/" || v.Type == "dp" {
			continue
		}
		if contains(svmProtocols[v.SVM.Name], "nfs") {
			identity := map[string]string{"arrayRef": serial, "protocol": "nfs", "path": v.NAS.Path}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeShare, Identity: identity, Name: v.SVM.Name + ":" + v.NAS.Path,
				Attributes: map[string]any{"vendor": vendor, "svm": v.SVM.Name, "volume": v.Name, "exportPolicy": v.NAS.ExportPolicy.Name, "securityStyle": v.NAS.SecurityStyle, "sizeBytes": v.Space.Size, "usedBytes": v.Space.Used, "state": v.State, "aggregates": names(v.Aggregates)},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: v.UUID}}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: arrayRef, To: contract.CiRef{Type: typeShare, Identity: identity}, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, s := range inv.CifsShares {
		if s.Path == "" || s.Path == "/" || strings.HasSuffix(s.Name, "$") {
			continue
		}
		identity := map[string]string{"arrayRef": serial, "protocol": "smb", "path": "\\\\" + s.SVM.Name + "\\" + s.Name}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeShare, Identity: identity, Name: s.SVM.Name + "\\" + s.Name,
			Attributes: map[string]any{"vendor": vendor, "svm": s.SVM.Name, "share": s.Name, "junctionPath": s.Path},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: arrayRef, To: contract.CiRef{Type: typeShare, Identity: identity}, Attributes: map[string]any{}, ObservedAt: at})
	}

	igroupByName := map[string]igroupDoc{}
	for _, g := range inv.Igroups {
		igroupByName[g.Name] = g
	}
	lunRef := map[string]contract.CiRef{}
	for _, l := range inv.Luns {
		identity := map[string]string{"arrayRef": serial, "wwn": WWN(l.SerialNumber)}
		ref := contract.CiRef{Type: typeLun, Identity: identity}
		lunRef[l.UUID] = ref
		lunRef[l.Name] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLun, Identity: identity, Name: l.Name,
			Attributes: map[string]any{"vendor": vendor, "svm": l.SVM.Name, "volume": l.Location.Volume.Name, "serial": l.SerialNumber, "osType": l.OSType, "provisionedBytes": l.Space.Size, "usedBytes": l.Space.Used, "state": l.Status.State, "mapped": l.Status.Mapped, "enabled": l.Enabled},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: l.UUID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: arrayRef, To: ref, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, m := range inv.LunMaps {
		ref, ok := lunRef[m.Lun.UUID]
		if !ok {
			ref, ok = lunRef[m.Lun.Name]
		}
		if !ok {
			continue
		}
		g := igroupByName[m.Igroup.Name]
		initiators := []string{}
		for _, i := range g.Initiators {
			initiators = append(initiators, strings.ToLower(strings.ReplaceAll(i.Name, ":", "")))
		}
		hostIdentity := map[string]string{"fqdn": strings.ToLower(m.Igroup.Name)}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relPresented, From: ref, To: contract.CiRef{Type: typeHost, Identity: hostIdentity}, Attributes: map[string]any{"lun": m.LogicalUnitNumber, "igroup": m.Igroup.Name, "protocol": g.Protocol, "osType": g.OSType, "initiators": initiators}, ObservedAt: at})
	}
	return obs
}

func names(list []named) []string {
	out := make([]string, 0, len(list))
	for _, n := range list {
		out = append(out, n.Name)
	}
	return out
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil || cred.Type != "password" || cred.Fields[credUser] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "ontap requires a password credential with a username")
	}
	c, err := restjson.New(target.Value, defaultPort, restjson.Auth{User: cred.Fields[credUser], Pass: cred.Fields[credPassword]}, restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA)})
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}

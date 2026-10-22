// REQ-DISC-014 — Pure Storage FlashArray collector over the REST 2.x API: api-token login, array
// and chassis facts, controllers, volumes (as LUNs with their NAA identifiers), hosts and host
// groups, and the connections that present each volume to a host. One target = one array.
package purestorage

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "storage_pure"
	version      = "0.1.0"
	vendor       = "pure_storage"
	evidenceKind = "api_response"
	defaultPort  = 443
	optionVerify = "verifyTls"
	optionCA     = "caCertPem"
	optionAPI    = "apiVersion"
	defaultAPI   = "2.36"
	credToken    = "token"
	authHeader   = "x-auth-token"
	apiTokenHdr  = "api-token"
	pageLimit    = 1000
	naaPrefix    = "naa.624a9370" // Pure's IEEE OUI prefix; the volume serial follows
	bytesPerTiB  = 1 << 40

	typeArray    = "storage_array"
	typeLun      = "lun"
	typeHost     = "host"
	relPresented = "presented_to"
	relContains  = "contains"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "storage", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"api_token"},
		TargetKinds: []string{"host"}, Emits: []string{typeArray, typeLun, typeHost},
		ContractVersion: contract.Version,
	}
}

type items[T any] struct {
	Items             []T    `json:"items"`
	ContinuationToken string `json:"continuation_token"`
}

type arrayDoc struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	OS       string `json:"os"`
	Version  string `json:"version"`
	Capacity int64  `json:"capacity"`
	Space    struct {
		TotalPhysical int64   `json:"total_physical"`
		DataReduction float64 `json:"data_reduction"`
		Unique        int64   `json:"unique"`
		Snapshots     int64   `json:"snapshots"`
		Shared        int64   `json:"shared"`
	} `json:"space"`
}

type hardwareDoc struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Serial string `json:"serial"`
	Model  string `json:"model"`
	Status string `json:"status"`
}

type controllerDoc struct {
	Name    string `json:"name"`
	Model   string `json:"model"`
	Status  string `json:"status"`
	Mode    string `json:"mode"`
	Version string `json:"version"`
}

type volumeDoc struct {
	Name        string `json:"name"`
	Serial      string `json:"serial"`
	Provisioned int64  `json:"provisioned"`
	Created     int64  `json:"created"`
	Destroyed   bool   `json:"destroyed"`
	Space       struct {
		TotalPhysical int64 `json:"total_physical"`
		Unique        int64 `json:"unique"`
		Snapshots     int64 `json:"snapshots"`
	} `json:"space"`
	Pod *struct {
		Name string `json:"name"`
	} `json:"pod"`
	VolumeGroup *struct {
		Name string `json:"name"`
	} `json:"volume_group"`
	Source *struct {
		Name string `json:"name"`
	} `json:"source"`
}

type hostDoc struct {
	Name        string   `json:"name"`
	Wwns        []string `json:"wwns"`
	Iqns        []string `json:"iqns"`
	Nqns        []string `json:"nqns"`
	Personality string   `json:"personality"`
	HostGroup   *struct {
		Name string `json:"name"`
	} `json:"host_group"`
}

type connectionDoc struct {
	Host struct {
		Name string `json:"name"`
	} `json:"host"`
	Volume struct {
		Name string `json:"name"`
	} `json:"volume"`
	Lun int `json:"lun"`
}

// Inventory is one array's content.
type Inventory struct {
	Array       arrayDoc
	Hardware    []hardwareDoc
	Controllers []controllerDoc
	Volumes     []volumeDoc
	Hosts       []hostDoc
	Connections []connectionDoc
	Raw         [][]byte
}

// Login exchanges an API token for a session token.
func Login(ctx context.Context, base string, apiVersion string, apiToken string, verify bool) (string, error) {
	u := strings.TrimSuffix(base, "/") + "/api/" + apiVersion + "/login"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set(apiTokenHdr, apiToken)
	client := &http.Client{Timeout: restjsonTimeout, Transport: restjson.Transport(verify)}
	res, err := client.Do(req)
	if err != nil {
		return "", restjson.Classify(base, err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the API token (%d)", base, res.StatusCode)
	}
	if res.StatusCode >= http.StatusBadRequest {
		return "", collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d on login (not a FlashArray REST %s endpoint?)", base, res.StatusCode, apiVersion)
	}
	token := res.Header.Get(authHeader)
	if token == "" {
		return "", collector.Errorf(contract.ErrParse, false, "%s returned no session token", base)
	}
	return token, nil
}

const restjsonTimeout = 30 * time.Second

func listAll[T any](ctx context.Context, c *restjson.Client, path string, out *[]T) error {
	token := ""
	for {
		q := url.Values{}
		q.Set("limit", strconv.Itoa(pageLimit))
		if token != "" {
			q.Set("continuation_token", token)
		}
		var page items[T]
		if err := c.Get(ctx, path+"?"+q.Encode(), &page); err != nil {
			return err
		}
		*out = append(*out, page.Items...)
		if page.ContinuationToken == "" || len(page.Items) == 0 {
			return nil
		}
		token = page.ContinuationToken
	}
}

// Walk reads the array through the versioned API prefix.
func Walk(ctx context.Context, c *restjson.Client, apiVersion string) (*Inventory, error) {
	inv := &Inventory{}
	prefix := "/api/" + apiVersion
	var arrays items[arrayDoc]
	if err := c.Get(ctx, prefix+"/arrays", &arrays); err != nil {
		return nil, err
	}
	if len(arrays.Items) == 0 {
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "arrays endpoint returned nothing")
	}
	inv.Array = arrays.Items[0]
	_ = listAll(ctx, c, prefix+"/hardware", &inv.Hardware)
	_ = listAll(ctx, c, prefix+"/controllers", &inv.Controllers)
	if err := listAll(ctx, c, prefix+"/volumes", &inv.Volumes); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, prefix+"/hosts", &inv.Hosts); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, prefix+"/connections", &inv.Connections); err != nil {
		return nil, err
	}
	inv.Raw = c.Raw()
	return inv, nil
}

// Serial returns the chassis serial (the array identity) or the array id when hardware is hidden.
func Serial(inv *Inventory) string {
	for _, h := range inv.Hardware {
		if strings.EqualFold(h.Type, "chassis") && h.Serial != "" {
			return h.Serial
		}
	}
	return inv.Array.ID
}

// WWN renders a Pure volume serial as its NAA identifier as seen by hosts and FC fabrics.
func WWN(volumeSerial string) string {
	return naaPrefix + strings.ToLower(volumeSerial)
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
	controllers := []map[string]any{}
	model := ""
	for _, c := range inv.Controllers {
		controllers = append(controllers, map[string]any{"name": c.Name, "model": c.Model, "status": c.Status, "mode": c.Mode, "version": c.Version})
		model = c.Model
	}
	a := inv.Array
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeArray, Identity: arrayIdentity, Name: a.Name,
		Attributes: map[string]any{"vendor": vendor, "model": model, "os": a.OS, "version": a.Version, "arrayId": a.ID, "capacityBytes": a.Capacity, "usedBytes": a.Space.TotalPhysical, "dataReduction": a.Space.DataReduction, "snapshotBytes": a.Space.Snapshots, "controllers": controllers, "volumeCount": len(inv.Volumes), "hostCount": len(inv.Hosts), "managementIp": target.Value},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: a.ID}}, ObservedAt: at})
	hostByName := map[string]hostDoc{}
	for _, h := range inv.Hosts {
		hostByName[h.Name] = h
	}
	lunByVolume := map[string]contract.CiRef{}
	for _, v := range inv.Volumes {
		if v.Destroyed {
			continue
		}
		identity := map[string]string{"arrayRef": serial, "wwn": WWN(v.Serial)}
		ref := contract.CiRef{Type: typeLun, Identity: identity}
		lunByVolume[v.Name] = ref
		attrs := map[string]any{"vendor": vendor, "array": a.Name, "volume": v.Name, "serial": v.Serial, "provisionedBytes": v.Provisioned, "usedBytes": v.Space.TotalPhysical, "uniqueBytes": v.Space.Unique, "snapshotBytes": v.Space.Snapshots, "createdAt": time.UnixMilli(v.Created).UTC().Format(time.RFC3339)}
		if v.Pod != nil {
			attrs["pod"] = v.Pod.Name
		}
		if v.VolumeGroup != nil {
			attrs["volumeGroup"] = v.VolumeGroup.Name
		}
		if v.Source != nil {
			attrs["clonedFrom"] = v.Source.Name
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLun, Identity: identity, Name: v.Name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: a.ID + "/" + v.Name}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: arrayRef, To: ref, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, conn := range inv.Connections {
		lun, ok := lunByVolume[conn.Volume.Name]
		if !ok {
			continue
		}
		h := hostByName[conn.Host.Name]
		hostIdentity := map[string]string{"fqdn": strings.ToLower(conn.Host.Name)}
		attrs := map[string]any{"lun": conn.Lun, "initiatorWwns": lowerAll(h.Wwns), "initiatorIqns": h.Iqns, "initiatorNqns": h.Nqns, "personality": h.Personality, "array": a.Name}
		if h.HostGroup != nil {
			attrs["hostGroup"] = h.HostGroup.Name
		}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relPresented, From: lun, To: contract.CiRef{Type: typeHost, Identity: hostIdentity}, Attributes: attrs, ObservedAt: at})
	}
	return obs
}

func lowerAll(list []string) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		out = append(out, strings.ToLower(strings.ReplaceAll(s, ":", "")))
	}
	return out
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil || cred.Type != "api_token" || cred.Fields[credToken] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "pure storage requires an api_token credential")
	}
	verify := restjson.BoolOption(options, optionVerify)
	apiVersion := firstNonEmpty(restjson.StringOption(options, optionAPI), defaultAPI)
	base := target.Value
	if !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}
	session, err := Login(ctx, base, apiVersion, cred.Fields[credToken], verify)
	if err != nil {
		return collector.Observation{}, err
	}
	c, err := restjson.New(base, defaultPort, restjson.Auth{}, restjson.Options{VerifyTLS: verify, CAPem: restjson.StringOption(options, optionCA), Headers: map[string]string{authHeader: session}})
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, c, apiVersion)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

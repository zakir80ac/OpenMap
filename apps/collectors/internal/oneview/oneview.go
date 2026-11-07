// REQ-DISC-013 — HPE OneView collector over its REST API: enclosures (chassis), server hardware
// (blades and rack servers with their iLO), interconnect modules and server profiles. One target =
// one OneView appliance; a login session is opened with the credential and closed afterwards.
package oneview

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID   = "hpe_oneview"
	version       = "0.1.0"
	vendor        = "hpe"
	evidenceKind  = "api_response"
	defaultPort   = 443
	optionVerify  = "verifyTls"
	optionCA      = "caCertPem"
	optionAPI     = "apiVersion"
	defaultAPI    = "6000"
	credUser      = "username"
	credPassword  = "password"
	credDomain    = "authLoginDomain"
	sessionHeader = "Auth"
	apiHeader     = "X-Api-Version"
	pageCount     = 500

	typeChassis = "chassis"
	typeBlade   = "blade"
	typeHost    = "host"
	typeBmc     = "bmc"
	typeSwitch  = "network_device"
	relContains = "contains"
	relManages  = "manages"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "ipmi_redfish", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeChassis, typeBlade, typeHost, typeBmc, typeSwitch},
		ContractVersion: contract.Version,
	}
}

type page[T any] struct {
	Members  []T    `json:"members"`
	NextPage string `json:"nextPageUri"`
}

type Enclosure struct {
	URI            string `json:"uri"`
	Name           string `json:"name"`
	SerialNumber   string `json:"serialNumber"`
	EnclosureType  string `json:"enclosureType"`
	Model          string `json:"enclosureModel"`
	PartNumber     string `json:"partNumber"`
	Status         string `json:"status"`
	State          string `json:"state"`
	DeviceBayCount int    `json:"deviceBayCount"`
	RackName       string `json:"rackName"`
	FwBaseline     string `json:"fwBaselineName"`
}

type ServerHardware struct {
	URI            string `json:"uri"`
	Name           string `json:"name"`
	ServerName     string `json:"serverName"`
	SerialNumber   string `json:"serialNumber"`
	Model          string `json:"model"`
	ShortModel     string `json:"shortModel"`
	Position       int    `json:"position"`
	LocationURI    string `json:"locationUri"`
	Status         string `json:"status"`
	PowerState     string `json:"powerState"`
	UUID           string `json:"uuid"`
	ProcessorCount int    `json:"processorCount"`
	ProcessorCore  int    `json:"processorCoreCount"` // cores per processor
	ProcessorType  string `json:"processorType"`
	MemoryMb       int64  `json:"memoryMb"`
	RomVersion     string `json:"romVersion"`
	MpFirmware     string `json:"mpFirmwareVersion"`
	MpModel        string `json:"mpModel"`
	MpHost         struct {
		IPAddresses []struct {
			Address string `json:"address"`
			Type    string `json:"type"`
		} `json:"mpIpAddresses"`
		HostName string `json:"mpHostName"`
	} `json:"mpHostInfo"`
	ServerProfileURI string `json:"serverProfileUri"`
	PortMap          struct {
		DeviceSlots []struct {
			DeviceName    string `json:"deviceName"`
			PhysicalPorts []struct {
				Mac  string `json:"mac"`
				Wwn  string `json:"wwn"`
				Type string `json:"type"`
			} `json:"physicalPorts"`
		} `json:"deviceSlots"`
	} `json:"portMap"`
}

type Interconnect struct {
	URI          string `json:"uri"`
	Name         string `json:"name"`
	SerialNumber string `json:"serialNumber"`
	Model        string `json:"model"`
	Status       string `json:"status"`
	State        string `json:"state"`
	Firmware     string `json:"firmwareVersion"`
	EnclosureURI string `json:"enclosureUri"`
	Bay          int    `json:"interconnectLocation.locationEntries"`
	IP           string `json:"interconnectIP"`
}

type Profile struct {
	URI               string `json:"uri"`
	Name              string `json:"name"`
	ServerHardwareURI string `json:"serverHardwareUri"`
	Status            string `json:"status"`
}

// Inventory is one appliance's content.
type Inventory struct {
	Enclosures    []Enclosure
	Servers       []ServerHardware
	Interconnects []Interconnect
	Profiles      []Profile
	Raw           [][]byte
}

// Login opens a session; the returned token goes into the Auth header.
func Login(ctx context.Context, c *restjson.Client, user, password, domain string) (string, error) {
	body := map[string]string{"userName": user, "password": password}
	if domain != "" {
		body["authLoginDomain"] = domain
	}
	var res struct {
		SessionID string `json:"sessionID"`
	}
	if err := c.Post(ctx, "/rest/login-sessions", body, &res); err != nil {
		return "", err
	}
	if res.SessionID == "" {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "login returned no session")
	}
	return res.SessionID, nil
}

// Logout deletes the session (DELETE /rest/login-sessions with the session in the Auth header), so a
// discovery sweep never leaves sessions open against the appliance's session limit.
func Logout(ctx context.Context, c *restjson.Client) {
	_, _ = c.Do(ctx, http.MethodDelete, "/rest/login-sessions", nil, nil)
}

func listAll[T any](ctx context.Context, c *restjson.Client, path string, out *[]T) error {
	next := path + "?count=" + strconv.Itoa(pageCount)
	for next != "" {
		var p page[T]
		if err := c.Get(ctx, next, &p); err != nil {
			return err
		}
		*out = append(*out, p.Members...)
		next = p.NextPage
	}
	return nil
}

// Walk reads enclosures, server hardware, interconnects and profiles.
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	inv := &Inventory{}
	if err := listAll(ctx, c, "/rest/enclosures", &inv.Enclosures); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, "/rest/server-hardware", &inv.Servers); err != nil {
		return nil, err
	}
	_ = listAll(ctx, c, "/rest/interconnects", &inv.Interconnects)
	_ = listAll(ctx, c, "/rest/server-profiles", &inv.Profiles)
	inv.Raw = c.Raw()
	return inv, nil
}

func healthOf(status string) string {
	switch strings.ToUpper(status) {
	case "OK":
		return "healthy"
	case "WARNING":
		return "degraded"
	case "CRITICAL":
		return "down"
	default:
		return "unknown"
	}
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	appliance := strings.ToLower(target.Value)
	enclosureByURI := map[string]Enclosure{}
	chassisRef := map[string]contract.CiRef{}
	for _, e := range inv.Enclosures {
		enclosureByURI[e.URI] = e
		identity := map[string]string{"serialNumber": e.SerialNumber}
		chassisRef[e.URI] = contract.CiRef{Type: typeChassis, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeChassis, Identity: identity, Name: e.Name,
			Attributes: map[string]any{"vendor": vendor, "model": firstNonEmpty(e.Model, e.EnclosureType), "partNumber": e.PartNumber, "health": healthOf(e.Status), "state": e.State, "bays": e.DeviceBayCount, "rack": e.RackName, "firmwareBaseline": e.FwBaseline, "appliance": appliance},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: e.URI}}, ObservedAt: at})
	}
	profileByServer := map[string]Profile{}
	for _, p := range inv.Profiles {
		profileByServer[p.ServerHardwareURI] = p
	}
	for _, s := range inv.Servers {
		enclosure, inEnclosure := enclosureByURI[s.LocationURI]
		macs := []string{}
		wwns := []string{}
		for _, slot := range s.PortMap.DeviceSlots {
			for _, port := range slot.PhysicalPorts {
				if port.Mac != "" {
					macs = append(macs, strings.ToLower(port.Mac))
				}
				if port.Wwn != "" {
					wwns = append(wwns, strings.ToLower(port.Wwn))
				}
			}
		}
		hostIdentity := map[string]string{"serialNumber": s.SerialNumber}
		if s.UUID != "" {
			hostIdentity["systemUuid"] = strings.ToLower(s.UUID)
		}
		if len(macs) > 0 {
			hostIdentity["primaryMac"] = macs[0]
		}
		attrs := map[string]any{"vendor": vendor, "model": firstNonEmpty(s.Model, s.ShortModel), "powerState": s.PowerState, "health": healthOf(s.Status), "cpuSockets": s.ProcessorCount, "cpuCores": s.ProcessorCount * s.ProcessorCore, "cpuModel": s.ProcessorType, "memoryMb": s.MemoryMb, "biosVersion": s.RomVersion, "macAddresses": macs, "hbaWwns": wwns, "appliance": appliance, "oneviewName": s.Name, "hostname": s.ServerName}
		if p, ok := profileByServer[s.URI]; ok {
			attrs["serverProfile"] = p.Name
		}
		hostRef := contract.CiRef{Type: typeHost, Identity: hostIdentity}
		// serverName is the operating system's host name; mpHostName names the iLO, never the server.
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: hostIdentity, Name: firstNonEmpty(s.ServerName, s.Name), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: s.URI}}, ObservedAt: at})
		if inEnclosure {
			bladeIdentity := map[string]string{"chassisRef": enclosure.SerialNumber, "bay": strconv.Itoa(s.Position), "serialNumber": s.SerialNumber}
			bladeRef := contract.CiRef{Type: typeBlade, Identity: bladeIdentity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeBlade, Identity: bladeIdentity, Name: enclosure.Name + " bay " + strconv.Itoa(s.Position), Attributes: map[string]any{"vendor": vendor, "model": s.ShortModel, "bay": s.Position, "enclosure": enclosure.Name, "health": healthOf(s.Status)}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: chassisRef[s.LocationURI], To: bladeRef, Attributes: map[string]any{"bay": s.Position}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: bladeRef, To: hostRef, Attributes: map[string]any{}, ObservedAt: at})
		}
		var bmcIP string
		for _, ip := range s.MpHost.IPAddresses {
			if ip.Address != "" && (bmcIP == "" || strings.Contains(strings.ToLower(ip.Type), "static")) {
				bmcIP = ip.Address
			}
		}
		if bmcIP != "" {
			bmcIdentity := map[string]string{"managementIp": bmcIP}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeBmc, Identity: bmcIdentity, Name: firstNonEmpty(s.MpModel, "iLO") + " @ " + bmcIP, Attributes: map[string]any{"vendor": vendor, "model": s.MpModel, "firmware": s.MpFirmware, "managementIp": bmcIP, "hostName": s.MpHost.HostName}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relManages, From: contract.CiRef{Type: typeBmc, Identity: bmcIdentity}, To: hostRef, Attributes: map[string]any{"protocol": "ilo"}, ObservedAt: at})
		}
	}
	for _, ic := range inv.Interconnects {
		if ic.SerialNumber == "" {
			continue
		}
		identity := map[string]string{"serialNumber": ic.SerialNumber}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSwitch, Identity: identity, Name: ic.Name,
			Attributes: map[string]any{"vendor": vendor, "model": ic.Model, "firmware": ic.Firmware, "health": healthOf(ic.Status), "state": ic.State, "managementIp": ic.IP, "role": "interconnect", "appliance": appliance},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: ic.URI}}, ObservedAt: at})
		if ch, ok := chassisRef[ic.EnclosureURI]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: ch, To: contract.CiRef{Type: typeSwitch, Identity: identity}, Attributes: map[string]any{}, ObservedAt: at})
		}
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

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil || cred.Type != "password" || cred.Fields[credUser] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "oneview requires a password credential with a username")
	}
	apiVersion := firstNonEmpty(restjson.StringOption(options, optionAPI), defaultAPI)
	opts := restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA), Headers: map[string]string{apiHeader: apiVersion}}
	c, err := restjson.New(target.Value, defaultPort, restjson.Auth{}, opts)
	if err != nil {
		return collector.Observation{}, err
	}
	session, err := Login(ctx, c, cred.Fields[credUser], cred.Fields[credPassword], cred.Fields[credDomain])
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	opts.Headers = map[string]string{apiHeader: apiVersion, sessionHeader: session}
	c, err = restjson.New(target.Value, defaultPort, restjson.Auth{}, opts)
	if err != nil {
		return collector.Observation{}, err
	}
	defer Logout(context.WithoutCancel(ctx), c)
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}

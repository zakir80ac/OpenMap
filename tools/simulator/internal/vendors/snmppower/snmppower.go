// REQ-QA-005 REQ-DISC-026 — simulated power and cooling equipment over SNMP, each unit its own agent (snmpd):
//   - APC / Schneider rack PDUs (AP89xx, rPDU2 "metered by outlet with switching"): PowerNet-MIB rPDUIdent,
//     rPDULoadStatus, rPDUOutletStatus and rPDU2OutletMeteredStatus, over SNMPv1 or v2c (both run);
//   - Schneider Galaxy UPS behind an APC network management card: RFC 1628 UPS-MIB plus PowerNet-MIB upsBasic
//     and upsAdv identity, battery and load, over SNMPv3 authPriv;
//   - Vertiv Liebert UPS behind a Unity card: UPS-MIB plus the LIEBERT-GP-AGENT-MIB agent identity, over v2c;
//   - Vertiv Liebert CRAC/CRAH units: LIEBERT-GP-AGENT-MIB identity and LIEBERT-GP-ENVIRONMENTAL-MIB state,
//     capacity and temperature table, over v2c.
//
// Rendered from the estate: identity, model, firmware, outlet count, rating, measured kW (split over the
// outlets feeding the estate's powered_by devices), UPS load and runtime, CRAC supply/return temperatures and
// fan speed (served as cooling capacity). Derived deterministically where the estate is silent, and said so
// where it happens: the per-outlet share of the PDU's measured power, outlet names for empty outlets
// ("Outlet n"), sysName for units the estate gives no SNMP name (the unit name in hostname form).
//
// Not simulated, because the snmp collector reads no MIB those products publish (collector gaps, not
// simulator gaps): Vertiv Geist rPDUs (GEIST-V5/VERTIV-V5-MIB) and Schneider Uniflair cooling units
// (PowerNet-MIB airIR/coolingUnit tables). Raritan and Eaton units are supported by the collector but absent
// from the estate. Standard ENTITY-SENSOR-MIB is not served: Liebert cards do not publish it.
package snmppower

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	g "github.com/gosnmp/gosnmp"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/snmpd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	oidSysDescr    = ".1.3.6.1.2.1.1.1.0"
	oidSysObjectID = ".1.3.6.1.2.1.1.2.0"
	oidSysUpTime   = ".1.3.6.1.2.1.1.3.0"
	oidSysContact  = ".1.3.6.1.2.1.1.4.0"
	oidSysName     = ".1.3.6.1.2.1.1.5.0"
	oidSysLocation = ".1.3.6.1.2.1.1.6.0"
	oidSysServices = ".1.3.6.1.2.1.1.7.0"

	// PowerNet-MIB (enterprise 318).
	apcEnterprise         = 318
	oidApcRPDU2SysObject  = ".1.3.6.1.4.1.318.1.3.4.6"
	oidApcUpsSysObject    = ".1.3.6.1.4.1.318.1.3.27"
	oidRPDUIdent          = ".1.3.6.1.4.1.318.1.1.12.1"
	oidRPDULoadStatusLoad = ".1.3.6.1.4.1.318.1.1.12.2.3.1.1"
	oidRPDUOutletStatus   = ".1.3.6.1.4.1.318.1.1.12.3.5.1.1"
	oidRPDU2OutletMetered = ".1.3.6.1.4.1.318.1.1.26.9.4.3.1"
	oidUpsBasicIdent      = ".1.3.6.1.4.1.318.1.1.1.1.1"
	oidUpsAdvIdent        = ".1.3.6.1.4.1.318.1.1.1.1.2"
	oidUpsBasicBattery    = ".1.3.6.1.4.1.318.1.1.1.2.1.1.0"
	oidUpsAdvOutputLoad   = ".1.3.6.1.4.1.318.1.1.1.4.2.3.0"
	// UPS-MIB (RFC 1628).
	oidUpsIdent   = ".1.3.6.1.2.1.33.1.1"
	oidUpsBattery = ".1.3.6.1.2.1.33.1.2"
	oidUpsInput   = ".1.3.6.1.2.1.33.1.3"
	oidUpsOutput  = ".1.3.6.1.2.1.33.1.4"
	// LIEBERT-GP-AGENT-MIB / LIEBERT-GP-ENVIRONMENTAL-MIB (enterprise 476).
	liebertEnterprise    = 476
	oidLiebertSysObject  = ".1.3.6.1.4.1.476.1.42"
	oidLgpAgentIdent     = ".1.3.6.1.4.1.476.1.42.2.1"
	oidLgpEnvState       = ".1.3.6.1.4.1.476.1.42.3.4.3"
	oidLgpEnvTempMeasure = ".1.3.6.1.4.1.476.1.42.3.4.1.2.3.1.3"

	outletOn          = 1
	upsBatteryNormal  = 2
	upsSourceNormal   = 3
	lgpOn             = 1
	lgpOff            = 2
	fullCharge        = 100
	upsOutputLines    = 3
	upsOutputVolts    = 230
	upsFrequencyTenth = 500
	defaultVoltage    = 230
	wattsPerKw        = 1000
	tenthsPerUnit     = 10
	percent           = 100
	ticksPerSecond    = 100
	ticksWrap         = 1 << 32
	sysServicesPower  = 72
	macLen            = 6
	weightSpread      = 64
	weightFloor       = 32
	engineBoots       = 1
	// uptimeSeconds is the agent uptime simulated units report: the estate carries none for facility gear.
	uptimeSeconds = 3_888_000

	kindPDU     = "pdu"
	kindUPS     = "ups"
	kindCooling = "cooling_unit"
	optionPort  = "port"
	optionVer   = "snmpVersion"
	credV2c     = "snmp_v2c"
	credV3      = "snmp_v3"
	privSuffix  = "priv"
	communityOf = "snmp-community"
)

// Vendor simulates the estate's PDUs, UPSs and cooling units.
type Vendor struct{}

func (Vendor) ID() string             { return "snmp-power" }
func (Vendor) Collector() string      { return "snmp" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-026"} }

type protocol int

const (
	protoV1 protocol = iota
	protoV2c
	protoV3
)

type outlet struct {
	name  string
	watts int
}

type unit struct {
	ci      *estate.CI
	kind    string
	family  string // apc-pdu | apc-ups | liebert-ups | liebert-crac
	sysName string
	proto   protocol
	outlets []outlet
	total   int
	tenths  int
	lines   []int // UPS output watts per line
}

func seed(parts ...string) []byte {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return sum[:]
}

var nonHost = regexp.MustCompile(`[^a-z0-9]+`)

// hostname turns a unit name into the sysName an administrator would give it ("RYD-DH01 UPS-A" →
// "ryd-dh01-ups-a"), the convention the estate's PDU snmpSysName values follow.
func hostname(name string) string {
	return strings.Trim(nonHost.ReplaceAllString(strings.ToLower(name), "-"), "-")
}

func family(c *estate.CI) string {
	m := strings.ToLower(c.Str("manufacturer") + " " + c.Str("model"))
	switch {
	case c.Type == kindPDU && strings.Contains(m, "apc"):
		return "apc-pdu"
	case c.Type == kindUPS && strings.Contains(m, "galaxy"):
		return "apc-ups"
	case c.Type == kindUPS && strings.Contains(m, "liebert"):
		return "liebert-ups"
	case c.Type == kindCooling && strings.Contains(m, "liebert"):
		return "liebert-crac"
	}
	return ""
}

func units(e *estate.Estate) []*unit {
	var out []*unit
	for _, kind := range []string{kindPDU, kindUPS, kindCooling} {
		for _, c := range e.OfType(kind, nil) {
			fam := family(c)
			if fam == "" {
				continue
			}
			u := &unit{ci: c, kind: kind, family: fam, sysName: c.Str("snmpSysName")}
			if u.sysName == "" {
				u.sysName = hostname(c.Name)
			}
			switch fam {
			case "apc-pdu":
				// APC rack PDUs are commonly polled over v1 and v2c; the serial picks one so both run.
				u.proto = protoV1
				if seed("snmp-version", c.ID("serialNumber"))[0]%2 == 1 {
					u.proto = protoV2c
				}
				u.pdu(e)
			case "apc-ups":
				u.proto = protoV3
				u.ups()
			case "liebert-ups":
				u.proto = protoV2c
				u.ups()
			default:
				u.proto = protoV2c
			}
			out = append(out, u)
		}
	}
	return out
}

// pdu assigns outlets to the devices the estate powers from this PDU and splits the measured power over them.
func (u *unit) pdu(e *estate.Estate) {
	n := int(u.ci.Num("outlets", 0))
	fed := e.To(u.ci, "powered_by")
	sort.SliceStable(fed, func(i, j int) bool { return fed[i].Name < fed[j].Name })
	if len(fed) > n {
		// More devices than outlets: the remainder hang off a neighbouring PDU in practice.
		fed = fed[:n]
	}
	u.total = int(math.Round(u.ci.Num("measuredKw", 0) * wattsPerKw))
	volts := u.ci.Num("inputVoltage", defaultVoltage)
	u.tenths = int(math.Round(float64(u.total) / volts * tenthsPerUnit))
	weights := make([]int, len(fed))
	sum := 0
	for i, d := range fed {
		weights[i] = weightFloor + int(seed("outlet-load", u.ci.ID("serialNumber"), d.Name)[0])%weightSpread
		sum += weights[i]
	}
	left := u.total
	for i := 0; i < n; i++ {
		o := outlet{name: "Outlet " + strconv.Itoa(i+1)}
		if i < len(fed) {
			o.name = fed[i].Name
			if i == len(fed)-1 {
				o.watts = left
			} else {
				o.watts = u.total * weights[i] / sum
				left -= o.watts
			}
		}
		u.outlets = append(u.outlets, o)
	}
}

func (u *unit) ups() {
	load := u.ci.Num("loadPercent", 0)
	total := u.ci.Num("ratedKw", 0) * wattsPerKw * load / percent
	per := int(math.Round(total / upsOutputLines))
	for i := 0; i < upsOutputLines; i++ {
		u.lines = append(u.lines, per)
	}
}

func uptime() func() uint32 {
	started := time.Now()
	return func() uint32 {
		return uint32(uint64((uptimeSeconds+time.Since(started).Seconds())*ticksPerSecond) % ticksWrap)
	}
}

func (u *unit) mib() *snmpd.MIB {
	m := snmpd.NewMIB()
	c := u.ci
	serial, model, fw := c.ID("serialNumber"), c.Str("model"), c.Str("firmware")
	m.TicksFunc(oidSysUpTime, uptime())
	m.Str(oidSysContact, "")
	m.Str(oidSysName, u.sysName)
	m.Str(oidSysLocation, c.Name)
	m.Int(oidSysServices, sysServicesPower)
	switch u.family {
	case "apc-pdu":
		apcModel := strings.TrimSpace(strings.TrimPrefix(model, "APC"))
		m.Str(oidSysDescr, "APC Web/SNMP Management Card (MB:v4.1.0 PF:v"+fw+" PN:apc_hw05_aos_"+strings.ReplaceAll(fw, ".", "")+".bin AF1:v"+fw+" AN1:apc_hw05_rpdu2g_"+strings.ReplaceAll(fw, ".", "")+".bin MN:"+apcModel+" HR:02 SN: "+serial+" MD:01/15/2021)")
		m.OID(oidSysObjectID, oidApcRPDU2SysObject)
		m.Str(oidRPDUIdent+".1.0", u.sysName)
		m.Str(oidRPDUIdent+".2.0", "02")
		m.Str(oidRPDUIdent+".3.0", "v"+fw)
		m.Str(oidRPDUIdent+".5.0", apcModel)
		m.Str(oidRPDUIdent+".6.0", serial)
		m.Int(oidRPDUIdent+".7.0", int(c.Num("ratedAmps", 0)))
		m.Int(oidRPDUIdent+".16.0", u.total)
		m.Int(snmpd.Index(oidRPDULoadStatusLoad+".1", 1), 1)
		m.Gauge(snmpd.Index(oidRPDULoadStatusLoad+".2", 1), uint32(u.tenths))
		for i, o := range u.outlets {
			m.Int(snmpd.Index(oidRPDUOutletStatus+".1", i+1), i+1)
			m.Str(snmpd.Index(oidRPDUOutletStatus+".2", i+1), o.name)
			m.Int(snmpd.Index(oidRPDUOutletStatus+".4", i+1), outletOn)
			m.Int(snmpd.Index(oidRPDU2OutletMetered+".1", i+1), i+1)
			m.Str(snmpd.Index(oidRPDU2OutletMetered+".3", i+1), o.name)
			m.Int(snmpd.Index(oidRPDU2OutletMetered+".7", i+1), o.watts)
		}
	case "apc-ups":
		m.Str(oidSysDescr, "APC Web/SNMP Management Card (MB:v4.2.1 PF:v2.5.0.6 PN:apc_hw21_aos_2.5.0.6.bin AF1:v2.5.0.6 AN1:apc_hw21_su_2.5.0.6.bin MN:AP9641 HR:05 SN: "+serial+" MD:06/02/2022)")
		m.OID(oidSysObjectID, oidApcUpsSysObject)
		u.upsMIB(m, "Schneider Electric")
		m.Str(oidUpsBasicIdent+".1.0", model)
		m.Str(oidUpsBasicIdent+".2.0", u.sysName)
		m.Str(oidUpsAdvIdent+".1.0", fw)
		m.Str(oidUpsAdvIdent+".3.0", serial)
		m.Int(oidUpsBasicBattery, upsBatteryNormal)
		m.Gauge(oidUpsAdvOutputLoad, uint32(c.Num("loadPercent", 0)))
	case "liebert-ups":
		m.Str(oidSysDescr, "Liebert Unity card, "+model)
		m.OID(oidSysObjectID, oidLiebertSysObject)
		u.upsMIB(m, "Vertiv")
		u.liebertIdent(m)
	case "liebert-crac":
		m.Str(oidSysDescr, "Liebert Unity card, "+model)
		m.OID(oidSysObjectID, oidLiebertSysObject)
		u.liebertIdent(m)
		m.Int(oidLgpEnvState+".1.0", lgpOn)
		m.Int(oidLgpEnvState+".2.0", lgpOn)
		m.Int(oidLgpEnvState+".3.0", lgpOff)
		m.Int(oidLgpEnvState+".4.0", lgpOff)
		m.Int(oidLgpEnvState+".5.0", lgpOff)
		// The estate's fan speed stands in for the unit's cooling capacity in use.
		m.Int(oidLgpEnvState+".9.0", int(c.Num("fanSpeedPercent", 0)))
		for i, t := range u.temperatures() {
			m.Int(snmpd.Index(oidLgpEnvTempMeasure, i+1), t)
		}
	}
	return m
}

// temperatures are the return and supply air readings in whole degrees Celsius.
func (u *unit) temperatures() []int {
	return []int{int(math.Round(u.ci.Num("returnTempC", 0))), int(math.Round(u.ci.Num("supplyTempC", 0)))}
}

func (u *unit) liebertIdent(m *snmpd.MIB) {
	m.Str(oidLgpAgentIdent+".1.0", "Vertiv")
	m.Str(oidLgpAgentIdent+".2.0", u.ci.Str("model"))
	if fw := u.ci.Str("firmware"); fw != "" {
		m.Str(oidLgpAgentIdent+".3.0", fw)
	}
	m.Str(oidLgpAgentIdent+".4.0", u.ci.ID("serialNumber"))
}

func (u *unit) upsMIB(m *snmpd.MIB, mfg string) {
	c := u.ci
	m.Str(oidUpsIdent+".1.0", mfg)
	m.Str(oidUpsIdent+".2.0", c.Str("model"))
	m.Str(oidUpsIdent+".3.0", c.Str("firmware"))
	m.Str(oidUpsIdent+".4.0", c.Str("firmware"))
	m.Str(oidUpsIdent+".5.0", c.Name)
	m.Int(oidUpsBattery+".1.0", upsBatteryNormal)
	m.Int(oidUpsBattery+".2.0", 0)
	m.Int(oidUpsBattery+".3.0", int(c.Num("batteryRuntimeMinutes", 0)))
	m.Int(oidUpsBattery+".4.0", fullCharge)
	m.Counter(oidUpsInput+".1.0", 0)
	m.Int(oidUpsInput+".2.0", upsOutputLines)
	m.Int(oidUpsOutput+".1.0", upsSourceNormal)
	m.Int(oidUpsOutput+".2.0", upsFrequencyTenth)
	m.Int(oidUpsOutput+".3.0", len(u.lines))
	for i, w := range u.lines {
		line := i + 1
		m.Int(snmpd.Index(oidUpsOutput+".4.1.2", line), upsOutputVolts)
		m.Int(snmpd.Index(oidUpsOutput+".4.1.3", line), w*tenthsPerUnit/upsOutputVolts)
		m.Int(snmpd.Index(oidUpsOutput+".4.1.4", line), w)
		m.Int(snmpd.Index(oidUpsOutput+".4.1.5", line), int(c.Num("loadPercent", 0)))
	}
}

func (u *unit) enterprise() uint32 {
	if strings.HasPrefix(u.family, "apc") {
		return apcEnterprise
	}
	return liebertEnterprise
}

func (u *unit) config(env *sim.Env) snmpd.Config {
	switch u.proto {
	case protoV3:
		mac := seed("engine", u.ci.ID("serialNumber"))[:macLen]
		return snmpd.Config{
			User:     &snmpd.User{Name: env.User, Auth: g.SHA, AuthPassphrase: env.Secret, Priv: g.AES, PrivPassphrase: env.Token(privSuffix)},
			EngineID: snmpd.EngineID(u.enterprise(), mac), EngineBoots: engineBoots, EngineTime: uptimeSeconds,
		}
	case protoV1:
		return snmpd.Config{Community: env.Token(communityOf), V1: true}
	}
	return snmpd.Config{Community: env.Token(communityOf), V2c: true}
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), Devices: map[string]string{}, State: map[string]any{}}
	ports := map[string]int{}
	for _, u := range units(e) {
		conn, port, err := sim.ListenUDP()
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		agent, err := snmpd.Serve(conn, u.mib(), u.config(env))
		if err != nil {
			_ = conn.Close()
			_ = ep.Close()
			return nil, fmt.Errorf("%s: %w", u.ci.Name, err)
		}
		ep.OnClose(agent.Close)
		key := estate.Key(u.ci.Type, u.ci.Identity)
		ports[key] = port
		ep.Devices[u.ci.Name] = sim.Address(port)
	}
	ep.State["ports"] = ports
	return ep, nil
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	ports, _ := ep.State["ports"].(map[string]int)
	var runs []sim.Run
	for _, u := range units(e) {
		port, ok := ports[estate.Key(u.ci.Type, u.ci.Identity)]
		if !ok {
			continue
		}
		run := sim.Run{
			Name:    u.ci.Name,
			Targets: []sim.Target{{Kind: "host", Value: sim.AdvertiseHost(), Label: u.ci.Name}},
			Options: map[string]any{optionPort: port},
		}
		switch u.proto {
		case protoV3:
			run.CredentialType = credV3
			run.Credential = &sim.Credential{Type: credV3, Fields: map[string]string{
				"username": env.User, "authProtocol": "SHA", "authPassphrase": env.Secret, "privProtocol": "AES", "privPassphrase": env.Token(privSuffix),
			}}
		default:
			run.CredentialType = credV2c
			run.Credential = &sim.Credential{Type: credV2c, Fields: map[string]string{"community": env.Token(communityOf)}}
			if u.proto == protoV1 {
				run.Options[optionVer] = "1"
			}
		}
		u.expect(&run.Expect)
		runs = append(runs, run)
	}
	return runs
}

func (u *unit) expect(x *sim.Expect) {
	c := u.ci
	attrs := map[string]any{}
	switch u.kind {
	case kindPDU:
		attrs = map[string]any{
			"powerKind": kindPDU, "model": strings.TrimSpace(strings.TrimPrefix(c.Str("model"), "APC")), "ratingAmps": int(c.Num("ratedAmps", 0)),
			"outputWatts": u.total, "loadAmps": float64(u.tenths) / tenthsPerUnit, "outletCount": len(u.outlets),
		}
		for _, o := range u.outlets {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "power_feed", Name: o.name, Identity: map[string]string{"pduRef": c.ID("serialNumber"), "name": o.name}, Attributes: map[string]any{"watts": o.watts, "on": true}})
			x.Rel("contains", kindPDU, u.sysName, "power_feed", o.name)
		}
	case kindUPS:
		watts := 0
		for _, w := range u.lines {
			watts += w
		}
		attrs = map[string]any{
			"powerKind": kindUPS, "model": c.Str("model"), "firmware": c.Str("firmware"), "batteryStatus": "normal", "batteryChargePercent": fullCharge,
			"batteryMinutesRemaining": int(c.Num("batteryRuntimeMinutes", 0)), "loadPercent": int(c.Num("loadPercent", 0)), "outputWatts": watts,
			"onBattery": false, "health": "healthy",
		}
	case kindCooling:
		attrs = map[string]any{
			"model": c.Str("model"), "coolingSystemState": "on", "coolingActive": true, "heatingActive": false, "humidifyingActive": false,
			"dehumidifyingActive": false, "coolingCapacityPercent": int(c.Num("fanSpeedPercent", 0)), "temperatureC": u.temperatures(), "health": "healthy",
		}
	}
	x.CIs = append(x.CIs, sim.ExpectCI{Type: u.kind, Name: u.sysName, Identity: c.Identity, Attributes: attrs})
}

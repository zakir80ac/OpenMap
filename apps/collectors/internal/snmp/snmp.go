// REQ-DISC-001 — SNMP collector: v2c and v3 (authPriv) over gosnmp, bulk walks of the standard
// tables, parsed by parse.go and emitted by emit.go. Credentials arrive from the Node per job.
package snmp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	g "github.com/gosnmp/gosnmp"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID   = "snmp"
	version       = "0.1.0"
	defaultPort   = 161
	timeout       = 5 * time.Second
	retries       = 1
	maxRepeaters  = 25
	optionPort    = "port"
	optionNoArp   = "skipArp"
	credCommunity = "community"
	credUser      = "username"
	credAuthProto = "authProtocol"
	credAuthPass  = "authPassphrase"
	credPrivProto = "privProtocol"
	credPrivPass  = "privPassphrase"
	credContext   = "contextName"
)

var scalarOIDs = []string{oidSysDescr, oidSysObjectID, oidSysUpTime, oidSysContact, oidSysName, oidSysLocation, oidLldpLocChassisID}

var tableOIDs = []string{
	oidIfDescr, oidIfType, oidIfMtu, oidIfSpeed, oidIfPhysAddress, oidIfAdminStatus, oidIfOperStatus, oidIfName, oidIfHighSpeed, oidIfAlias,
	oidIpAdEntIfIndex, oidIpAdEntNetMask,
	oidEntPhysicalDescr, oidEntPhysicalClass, oidEntPhysicalName, oidEntPhysicalSwRev, oidEntPhysicalSerialNum, oidEntPhysicalMfgName, oidEntPhysicalModelName,
	oidLldpLocPortID, oidLldpRemChassisID, oidLldpRemPortID, oidLldpRemPortDesc, oidLldpRemSysName, oidLldpRemSysDesc,
	oidDot1qVlanStaticName, oidDot1dBasePortIfIndex, oidDot1qPvid,
}

// Collector implements collector.Implementation for the snmp family.
type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "snmp", Version: version, Language: "go",
		Protocols: []string{"snmp-v2c", "snmp-v3"}, CredentialTypes: []string{"snmp_v2c", "snmp_v3"},
		TargetKinds: []string{"host"}, Emits: []string{typeNetworkDevice, typeInterface, typeVlan, typeIPAddress, typeUnknown},
		ContractVersion: contract.Version,
	}
}

func clientFor(target contract.Target, cred *contract.Credential, options map[string]any) (*g.GoSNMP, error) {
	if cred == nil {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "snmp requires an snmp_v2c or snmp_v3 credential")
	}
	port := uint16(defaultPort)
	if p, ok := options[optionPort]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(p)); err == nil && n > 0 && n <= 65535 {
			port = uint16(n)
		}
	}
	host := target.Value
	if ip := net.ParseIP(host); ip == nil {
		if _, err := net.LookupHost(host); err != nil {
			return nil, collector.Errorf(contract.ErrUnreachable, true, "cannot resolve %s: %v", host, err)
		}
	}
	c := &g.GoSNMP{Target: host, Port: port, Timeout: timeout, Retries: retries, MaxRepetitions: maxRepeaters, Transport: "udp"}
	switch cred.Type {
	case "snmp_v2c":
		c.Version = g.Version2c
		c.Community = cred.Fields[credCommunity]
		if c.Community == "" {
			return nil, collector.Errorf(contract.ErrAuthFailed, false, "snmp_v2c credential has no community")
		}
	case "snmp_v3":
		c.Version = g.Version3
		c.SecurityModel = g.UserSecurityModel
		c.ContextName = cred.Fields[credContext]
		usm := &g.UsmSecurityParameters{UserName: cred.Fields[credUser]}
		auth := strings.ToUpper(cred.Fields[credAuthProto])
		priv := strings.ToUpper(cred.Fields[credPrivProto])
		switch {
		case auth != "" && priv != "":
			c.MsgFlags = g.AuthPriv
		case auth != "":
			c.MsgFlags = g.AuthNoPriv
		default:
			c.MsgFlags = g.NoAuthNoPriv
		}
		usm.AuthenticationProtocol = authProtocol(auth)
		usm.AuthenticationPassphrase = cred.Fields[credAuthPass]
		usm.PrivacyProtocol = privProtocol(priv)
		usm.PrivacyPassphrase = cred.Fields[credPrivPass]
		c.SecurityParameters = usm
	default:
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "unsupported credential type %q for snmp", cred.Type)
	}
	return c, nil
}

func authProtocol(name string) g.SnmpV3AuthProtocol {
	switch name {
	case "MD5":
		return g.MD5
	case "SHA", "SHA1":
		return g.SHA
	case "SHA224":
		return g.SHA224
	case "SHA256":
		return g.SHA256
	case "SHA384":
		return g.SHA384
	case "SHA512":
		return g.SHA512
	default:
		return g.NoAuth
	}
}

func privProtocol(name string) g.SnmpV3PrivProtocol {
	switch name {
	case "DES":
		return g.DES
	case "AES", "AES128":
		return g.AES
	case "AES192":
		return g.AES192
	case "AES256":
		return g.AES256
	case "AES192C":
		return g.AES192C
	case "AES256C":
		return g.AES256C
	default:
		return g.NoPriv
	}
}

func decode(pdu g.SnmpPDU) any {
	switch pdu.Type {
	case g.OctetString:
		if b, ok := pdu.Value.([]byte); ok {
			return b
		}
		return pdu.Value
	case g.Integer:
		return int64(g.ToBigInt(pdu.Value).Int64())
	case g.Counter32, g.Gauge32, g.TimeTicks, g.Counter64, g.Uinteger32:
		return g.ToBigInt(pdu.Value).Uint64()
	case g.ObjectIdentifier:
		return fmt.Sprint(pdu.Value)
	case g.IPAddress:
		return fmt.Sprint(pdu.Value)
	case g.NoSuchObject, g.NoSuchInstance, g.EndOfMibView, g.Null:
		return nil
	default:
		return pdu.Value
	}
}

// walkDevice performs the scalar GET and all table walks for one target.
func walkDevice(ctx context.Context, c *g.GoSNMP, target contract.Target, skipArp bool) (*Walk, error) {
	if err := c.Connect(); err != nil {
		return nil, collector.Errorf(contract.ErrUnreachable, true, "connect %s: %v", target.Value, err)
	}
	defer c.Conn.Close()
	w := &Walk{Target: target, Scalars: map[string]any{}, Tables: map[string][]Varbind{}, At: time.Now().UTC()}
	res, err := c.Get(scalarOIDs)
	if err != nil {
		return nil, classify(target, err)
	}
	for _, pdu := range res.Variables {
		if v := decode(pdu); v != nil {
			w.Scalars[pdu.Name] = v
		}
	}
	if w.Scalars[oidSysDescr] == nil && w.Scalars[oidSysName] == nil {
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s answered without sysDescr or sysName", target.Value)
	}
	// Power MIBs: one extra GET; agents without them answer noSuchObject, which decode drops.
	if power, err := c.Get(powerScalarOIDs); err == nil {
		for _, pdu := range power.Variables {
			if v := decode(pdu); v != nil {
				w.Scalars[pdu.Name] = v
			}
		}
	}
	tables := tableOIDs
	if !skipArp {
		tables = append(append([]string{}, tables...), oidIpNetToMediaPhys)
	}
	if parsePower(w) != nil {
		tables = append(append([]string{}, tables...), powerTableOIDs...)
	}
	for _, root := range tables {
		if ctx.Err() != nil {
			return nil, collector.Errorf(contract.ErrTimeout, true, "cancelled while walking %s", target.Value)
		}
		var walker func(string, g.WalkFunc) error
		if c.Version == g.Version1 {
			walker = c.Walk
		} else {
			walker = c.BulkWalk
		}
		err := walker(root, func(pdu g.SnmpPDU) error {
			if v := decode(pdu); v != nil {
				w.Tables[root] = append(w.Tables[root], Varbind{OID: pdu.Name, Value: v})
			}
			return nil
		})
		if err != nil {
			// A missing table is normal (no LLDP, no VLANs); only transport failures abort.
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return nil, collector.Errorf(contract.ErrTimeout, true, "timeout walking %s on %s", root, target.Value)
			}
		}
	}
	return w, nil
}

func classify(target contract.Target, err error) error {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return collector.Errorf(contract.ErrTimeout, true, "%s did not answer SNMP (wrong community, ACL, or down)", target.Value)
	}
	msg := err.Error()
	if strings.Contains(msg, "authentication") || strings.Contains(msg, "unknown user") || strings.Contains(msg, "wrong digest") {
		return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the SNMP credential: %v", target.Value, err)
	}
	return collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
}

// Collect inspects one target.
func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	c, err := clientFor(target, cred, options)
	if err != nil {
		return collector.Observation{}, err
	}
	skipArp := false
	if v, ok := options[optionNoArp].(bool); ok {
		skipArp = v
	}
	w, err := walkDevice(ctx, c, target, skipArp)
	if err != nil {
		return collector.Observation{}, err
	}
	raw, err := json.Marshal(w)
	if err != nil {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "encode walk: %v", err)
	}
	d := Parse(w)
	if d.Manufacturer == "" {
		d.Manufacturer = vendorFromSysObjectID(d.SysObjectID)
	}
	return Emit(d, target, raw, w.At), nil
}

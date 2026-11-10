// REQ-DISC-001 — standard MIB object identifiers the SNMP collector walks. Vendor private MIBs are
// added per family in vendor.go; everything here is RFC MIB-II, IF-MIB, ENTITY-MIB, LLDP-MIB, Q-BRIDGE-MIB.
package snmp

const (
	oidSysDescr    = ".1.3.6.1.2.1.1.1.0"
	oidSysObjectID = ".1.3.6.1.2.1.1.2.0"
	oidSysUpTime   = ".1.3.6.1.2.1.1.3.0"
	oidSysContact  = ".1.3.6.1.2.1.1.4.0"
	oidSysName     = ".1.3.6.1.2.1.1.5.0"
	oidSysLocation = ".1.3.6.1.2.1.1.6.0"

	// IF-MIB ifTable / ifXTable
	oidIfIndex       = ".1.3.6.1.2.1.2.2.1.1"
	oidIfDescr       = ".1.3.6.1.2.1.2.2.1.2"
	oidIfType        = ".1.3.6.1.2.1.2.2.1.3"
	oidIfMtu         = ".1.3.6.1.2.1.2.2.1.4"
	oidIfSpeed       = ".1.3.6.1.2.1.2.2.1.5"
	oidIfPhysAddress = ".1.3.6.1.2.1.2.2.1.6"
	oidIfAdminStatus = ".1.3.6.1.2.1.2.2.1.7"
	oidIfOperStatus  = ".1.3.6.1.2.1.2.2.1.8"
	oidIfName        = ".1.3.6.1.2.1.31.1.1.1.1"
	oidIfHighSpeed   = ".1.3.6.1.2.1.31.1.1.1.15"
	oidIfAlias       = ".1.3.6.1.2.1.31.1.1.1.18"

	// IP-MIB ipAddrTable (legacy but universal) and ipNetToMedia (ARP)
	oidIpAdEntIfIndex   = ".1.3.6.1.2.1.4.20.1.2"
	oidIpAdEntNetMask   = ".1.3.6.1.2.1.4.20.1.3"
	oidIpNetToMediaPhys = ".1.3.6.1.2.1.4.22.1.2"

	// ENTITY-MIB entPhysicalTable
	oidEntPhysicalDescr     = ".1.3.6.1.2.1.47.1.1.1.1.2"
	oidEntPhysicalClass     = ".1.3.6.1.2.1.47.1.1.1.1.5"
	oidEntPhysicalName      = ".1.3.6.1.2.1.47.1.1.1.1.7"
	oidEntPhysicalHwRev     = ".1.3.6.1.2.1.47.1.1.1.1.8"
	oidEntPhysicalFwRev     = ".1.3.6.1.2.1.47.1.1.1.1.9"
	oidEntPhysicalSwRev     = ".1.3.6.1.2.1.47.1.1.1.1.10"
	oidEntPhysicalSerialNum = ".1.3.6.1.2.1.47.1.1.1.1.11"
	oidEntPhysicalMfgName   = ".1.3.6.1.2.1.47.1.1.1.1.12"
	oidEntPhysicalModelName = ".1.3.6.1.2.1.47.1.1.1.1.13"

	// LLDP-MIB lldpRemTable and local port table
	oidLldpLocChassisID = ".1.0.8802.1.1.2.1.3.2.0"
	oidLldpLocPortID    = ".1.0.8802.1.1.2.1.3.7.1.3"
	oidLldpRemChassisID = ".1.0.8802.1.1.2.1.4.1.1.5"
	oidLldpRemPortID    = ".1.0.8802.1.1.2.1.4.1.1.7"
	oidLldpRemPortDesc  = ".1.0.8802.1.1.2.1.4.1.1.8"
	oidLldpRemSysName   = ".1.0.8802.1.1.2.1.4.1.1.9"
	oidLldpRemSysDesc   = ".1.0.8802.1.1.2.1.4.1.1.10"

	// Q-BRIDGE-MIB VLAN names and the bridge port → ifIndex map
	oidDot1qVlanStaticName  = ".1.3.6.1.2.1.17.7.1.4.3.1.1"
	oidDot1dBasePortIfIndex = ".1.3.6.1.2.1.17.1.4.1.2"
	oidDot1qPvid            = ".1.3.6.1.2.1.17.7.1.4.5.1.1"

	// REQ-IPAM-004: BRIDGE-MIB and Q-BRIDGE-MIB forwarding databases, the MAC addresses each bridge port has learned.
	// dot1dTpFdb is indexed by the six MAC octets; dot1qTpFdb by the filtering database id (the VLAN on most switches)
	// then the six octets. Status 3 is learned; self (4) and mgmt (5) entries are the switch's own addresses.
	oidDot1dTpFdbPort   = ".1.3.6.1.2.1.17.4.3.1.2"
	oidDot1dTpFdbStatus = ".1.3.6.1.2.1.17.4.3.1.3"
	oidDot1qTpFdbPort   = ".1.3.6.1.2.1.17.7.1.2.2.1.2"
	oidDot1qTpFdbStatus = ".1.3.6.1.2.1.17.7.1.2.2.1.3"
)

// entPhysicalClass values (ENTITY-MIB PhysicalClass).
const (
	entClassChassis     = 3
	entClassContainer   = 5
	entClassPowerSupply = 6
	entClassFan         = 7
	entClassModule      = 9
	entClassPort        = 10
)

// ifOperStatus values.
const (
	ifStatusUp   = 1
	ifStatusDown = 2
)

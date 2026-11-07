// REQ-QA-005 REQ-DISC-012 — simulated Redfish BMCs (DMTF Redfish 1.x over HTTPS with HTTP Basic auth, the
// collector's only auth mode). One listener per BMC, rendered from the estate's bmc CIs and the host each one
// manages: Dell iDRAC9, HPE iLO 5 and iLO 6, and Lenovo XClarity Controller 2 come from the estate, each with
// the resource ids, Manager/System/Chassis shapes and OEM blocks its vendor documents (System.Embedded.1 and
// iDRAC.Embedded.1 on Dell, Systems/1 with Oem.Hpe and "HpeServerPowerSupply" supplies on iLO, Systems/1 on XCC).
// The estate holds no Cisco CIMC and no generic BMC, so one standalone UCS C-series CIMC and one generic DMTF
// BMC (the public-rackmount mockup's resource layout: Systems/437XR1138R2, Chassis/1U, Managers/BMC) are seeded
// deterministically from their names; their expectations come from that seeded set. Disk drives, the second
// NIC MAC, adapter serials and the power reading are not in the estate either and are derived by hash from the
// host serial. The ServiceRoot answers without credentials as the Redfish specification requires; every other
// resource needs Basic credentials and answers 401 with a Redfish error body otherwise.
package redfish

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	root           = "/redfish/v1"
	perFlavour     = 2
	drivesPerHost  = 2
	nicsPerHost    = 2
	driveBytes     = 960197124096 // a 960 GB mixed-use SSD as BMCs report CapacityBytes
	dimmLargeGiB   = 64
	dimmSmallGiB   = 32
	dimmLargeFrom  = 512 // hosts with at least this much memory use the large DIMM size
	mibPerGiB      = 1024
	threadsPerCore = 2
	powerMinWatts  = 240
	powerSpanWatts = 420
	psuWatts       = 1400
	linkMbps       = 25000
	exhaustDelta   = 14 // exhaust reads this much above inlet
	defaultInlet   = 22
	defaultPsus    = 2
	defaultFans    = 6
	dimmSpeedMts   = 4800
	maxSpeedMhz    = 3800
	redfishVersion = "1.17.0"
	contentType    = "application/json;odata.metadata=minimal;charset=utf-8"
	serialLen      = 11
)

type Vendor struct{}

func (Vendor) ID() string             { return "redfish-bmc" }
func (Vendor) Collector() string      { return "ipmi_redfish" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-012"} }

// facts is everything one simulated BMC serves: the managed host and the BMC itself.
type facts struct {
	key          string
	bmc          *estate.CI
	host         *estate.CI
	hostname     string
	fqdn         string
	serial       string
	uuid         string
	manufacturer string
	model        string
	partNumber   string
	bios         string
	cpuModel     string
	sockets      int
	cores        int
	memoryGiB    int
	macs         []string
	ip           string
	rack         string
	rackU        int
	powerOn      bool
	product      string // BMC product as the estate names it (iDRAC9, iLO 5, ...)
	firmware     string
	bmcMac       string
	psus         int
	fans         int
	inletC       float64
}

func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func hashInt(span int, parts ...string) int {
	n, _ := strconv.ParseUint(digest(parts...)[:8], 16, 32)
	return int(n % uint64(span))
}

func uuidOf(parts ...string) string {
	h := digest(parts...)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func serialOf(prefix string, n int, parts ...string) string {
	return prefix + strings.ToUpper(digest(parts...)[:n-len(prefix)])
}

// nextMac derives the second port of a NIC from the first (consecutive MACs, as on one adapter).
func nextMac(mac string) string {
	b := strings.Split(mac, ":")
	if len(b) != 6 {
		return mac
	}
	last, err := strconv.ParseUint(b[5], 16, 8)
	if err != nil {
		return mac
	}
	b[5] = fmt.Sprintf("%02x", (last+1)&0xff)
	return strings.Join(b, ":")
}

func fromEstate(bmc, host *estate.CI) *facts {
	f := &facts{
		key: bmc.Name, bmc: bmc, host: host,
		hostname: host.Str("hostname"), fqdn: host.ID("fqdn"), serial: host.ID("serialNumber"), uuid: host.ID("systemUuid"),
		manufacturer: host.Str("manufacturer"), model: host.Str("model"), partNumber: host.Str("partNumber"), bios: host.Str("biosVersion"),
		cpuModel: host.Str("cpuModel"), sockets: int(host.Num("cpuSockets", 2)), cores: int(host.Num("cpuCores", 0)),
		memoryGiB: int(host.Num("memoryGb", 0)), ip: host.Str("primaryIp"), rack: host.Str("rack"), rackU: int(host.Num("uPosition", 0)),
		powerOn: !strings.EqualFold(host.Str("powerState"), "off"),
		product: bmc.Str("product"), firmware: bmc.Str("firmware"), bmcMac: bmc.Str("macAddress"),
		psus: int(bmc.Num("psuCount", defaultPsus)), fans: int(bmc.Num("fanCount", defaultFans)), inletC: bmc.Num("inletTempC", defaultInlet),
	}
	if f.hostname == "" {
		f.hostname = host.Name
	}
	if mac := host.ID("primaryMac"); mac != "" {
		f.macs = []string{mac, nextMac(mac)}
	}
	return f
}

// seeded builds the deterministic BMCs the estate has no data for.
func seeded(key, serialPrefix, bios, product, manufacturer, model, cpuModel, firmware string) *facts {
	mac := "00:25:b5:" + digest(key, "mac")[0:2] + ":" + digest(key, "mac")[2:4] + ":" + digest(key, "mac")[4:6]
	return &facts{
		key: key, hostname: key, serial: serialOf(serialPrefix, serialLen, key), uuid: uuidOf(key, "uuid"),
		manufacturer: manufacturer, model: model, partNumber: model, bios: bios, cpuModel: cpuModel,
		sockets: 2, cores: 48, memoryGiB: 512, macs: []string{mac, nextMac(mac)}, powerOn: true,
		product: product, firmware: firmware, bmcMac: nextMac(nextMac(mac)), psus: defaultPsus, fans: defaultFans, inletC: defaultInlet,
	}
}

// flavour is one vendor's Redfish layout.
type flavour struct {
	name         string
	vendor       string
	product      func(f *facts) string
	managerModel func(f *facts) string
	managerFw    func(f *facts) string
	manufacturer func(f *facts) string
	systemID     func(f *facts) string
	chassisID    string
	managerID    string
	procID       func(i int) string
	dimmID       func(socket, slot int) string
	dimmLocator  func(socket, slot int) string
	storageID    string
	driveID      func(i int) string
	driveName    func(i int) string
	nicID        func(i int) string
	adapterID    string
	psuName      func(i int) string
	psuMember    func(i int) string
	inletName    string
	exhaustName  string
	oemRoot      func(f *facts) map[string]any
	oemSystem    func(f *facts) map[string]any
	server       string
}

func same(s string) func(*facts) string { return func(*facts) string { return s } }

func socketLetter(socket int) string { return string(rune('A' + socket)) }

var flavours = map[string]*flavour{
	"iDRAC9": {
		name: "dell-idrac9", vendor: "Dell", product: same("Integrated Dell Remote Access Controller"),
		managerModel: func(f *facts) string {
			if strings.Contains(f.model, "60") {
				return "16G Monolithic"
			}
			return "15G Monolithic"
		},
		managerFw: func(f *facts) string { return f.firmware + ".00" }, manufacturer: same("Dell Inc."),
		systemID: same("System.Embedded.1"), chassisID: "System.Embedded.1", managerID: "iDRAC.Embedded.1",
		procID:      func(i int) string { return "CPU.Socket." + strconv.Itoa(i+1) },
		dimmID:      func(s, i int) string { return "DIMM.Socket." + socketLetter(s) + strconv.Itoa(i+1) },
		dimmLocator: func(s, i int) string { return "DIMM." + socketLetter(s) + strconv.Itoa(i+1) },
		storageID:   "RAID.Integrated.1-1",
		driveID: func(i int) string {
			return "Disk.Bay." + strconv.Itoa(i) + ":Enclosure.Internal.0-1:RAID.Integrated.1-1"
		},
		driveName: func(i int) string { return "Physical Disk 0:1:" + strconv.Itoa(i) },
		nicID:     func(i int) string { return "NIC.Integrated.1-" + strconv.Itoa(i+1) + "-1" },
		adapterID: "NIC.Integrated.1",
		psuName:   func(i int) string { return "PS" + strconv.Itoa(i+1) + " Status" },
		psuMember: func(i int) string { return "PSU.Slot." + strconv.Itoa(i+1) },
		inletName: "System Board Inlet Temp", exhaustName: "System Board Exhaust Temp",
		oemSystem: func(f *facts) map[string]any {
			return map[string]any{"Dell": map[string]any{"DellSystem": map[string]any{"@odata.type": "#DellSystem.v1_3_0.DellSystem", "ChassisServiceTag": f.serial, "NodeID": f.serial, "SystemGeneration": "15G Monolithic"}}}
		},
		server: "Apache",
	},
	"iLO 5": iloFlavour("hpe-ilo5", "iLO 5"),
	"iLO 6": iloFlavour("hpe-ilo6", "iLO 6"),
	"XClarity Controller 2": {
		name: "lenovo-xcc2", vendor: "Lenovo", product: same("Lenovo XClarity Controller 2"),
		managerModel: same("Lenovo XClarity Controller 2"), managerFw: func(f *facts) string { return f.firmware }, manufacturer: same("Lenovo"),
		systemID: same("1"), chassisID: "1", managerID: "1",
		procID:      func(i int) string { return strconv.Itoa(i + 1) },
		dimmID:      func(s, i int) string { return strconv.Itoa(s*dimmSlotsPerSocket + i + 1) },
		dimmLocator: func(s, i int) string { return "DIMM " + strconv.Itoa(s*dimmSlotsPerSocket+i+1) },
		storageID:   "RAID_Slot1",
		driveID:     func(i int) string { return "Disk." + strconv.Itoa(i) },
		driveName:   func(i int) string { return "Drive " + strconv.Itoa(i) },
		nicID:       func(i int) string { return "NIC" + strconv.Itoa(i+1) },
		adapterID:   "slot-1",
		psuName:     func(i int) string { return "PSU" + strconv.Itoa(i+1) },
		psuMember:   func(i int) string { return strconv.Itoa(i) },
		inletName:   "Ambient Temp", exhaustName: "Exhaust Temp",
		oemSystem: func(f *facts) map[string]any {
			return map[string]any{"Lenovo": map[string]any{"@odata.type": "#LenovoComputerSystem.v1_0_0.LenovoSystemProperties", "SystemStatus": "OSBooted", "FrontPanelUSB": map[string]any{"PortSwitchingTo": "Server"}}}
		},
		server: "XCC Web Server",
	},
	"CIMC": {
		name: "cisco-cimc", vendor: "Cisco Systems Inc.", product: func(f *facts) string { return f.model },
		managerModel: same("CIMC"), managerFw: func(f *facts) string { return f.firmware }, manufacturer: same("Cisco Systems Inc"),
		systemID: func(f *facts) string { return f.serial }, chassisID: "1", managerID: "CIMC",
		procID:      func(i int) string { return "CPU" + strconv.Itoa(i+1) },
		dimmID:      func(s, i int) string { return "DIMM_" + socketLetter(s) + strconv.Itoa(i+1) },
		dimmLocator: func(s, i int) string { return "DIMM_" + socketLetter(s) + strconv.Itoa(i+1) },
		storageID:   "MRAID",
		driveID:     func(i int) string { return "PD" + strconv.Itoa(i+1) },
		driveName:   func(i int) string { return "PD" + strconv.Itoa(i+1) },
		nicID:       func(i int) string { return "eth" + strconv.Itoa(i) },
		adapterID:   "MLOM",
		psuName:     func(i int) string { return "PSU" + strconv.Itoa(i+1) },
		psuMember:   func(i int) string { return strconv.Itoa(i + 1) },
		inletName:   "PSU1_TEMP_INLET", exhaustName: "EXHAUST_TEMP",
		server: "webserver",
	},
	"Generic": {
		name: "dmtf-generic", vendor: "Contoso", product: same("UR999"),
		managerModel: same("Joo Janta 200"), managerFw: func(f *facts) string { return f.firmware }, manufacturer: func(f *facts) string { return f.manufacturer },
		systemID: same("437XR1138R2"), chassisID: "1U", managerID: "BMC",
		procID:      func(i int) string { return "CPU" + strconv.Itoa(i+1) },
		dimmID:      func(s, i int) string { return "DIMM" + strconv.Itoa(s*dimmSlotsPerSocket+i+1) },
		dimmLocator: func(s, i int) string { return "PROC " + strconv.Itoa(s+1) + " DIMM " + strconv.Itoa(i+1) },
		storageID:   "1",
		driveID:     func(i int) string { return strings.ToUpper(digest("generic-drive", strconv.Itoa(i))[:16]) },
		driveName:   func(i int) string { return "Drive " + strconv.Itoa(i+1) },
		nicID:       func(i int) string { return strings.ToUpper(digest("generic-nic", strconv.Itoa(i))[:12]) },
		adapterID:   "NIC1",
		psuName:     func(i int) string { return "Power Supply Bay " + strconv.Itoa(i+1) },
		psuMember:   func(i int) string { return strconv.Itoa(i) },
		inletName:   "Intake Temp", exhaustName: "Exhaust Temp",
	},
}

// dimmSlotsPerSocket bounds the DIMM numbering per socket (two DIMMs per channel, eight channels).
const dimmSlotsPerSocket = 16

func iloFlavour(name, product string) *flavour {
	return &flavour{
		name: name, vendor: "HPE", product: func(f *facts) string { return f.model },
		managerModel: same(product), managerFw: func(f *facts) string { return product + " v" + f.firmware }, manufacturer: same("HPE"),
		systemID: same("1"), chassisID: "1", managerID: "1",
		procID:      func(i int) string { return strconv.Itoa(i + 1) },
		dimmID:      func(s, i int) string { return "proc" + strconv.Itoa(s+1) + "dimm" + strconv.Itoa(i+1) },
		dimmLocator: func(s, i int) string { return "PROC " + strconv.Itoa(s+1) + " DIMM " + strconv.Itoa(i+1) },
		storageID:   "DE00A000",
		driveID:     func(i int) string { return strconv.Itoa(i) },
		driveName:   func(i int) string { return "Drive " + strconv.Itoa(i) },
		nicID:       func(i int) string { return strconv.Itoa(i + 1) },
		adapterID:   "DE07A000",
		psuName:     func(int) string { return "HpeServerPowerSupply" },
		psuMember:   func(i int) string { return strconv.Itoa(i) },
		inletName:   "01-Inlet Ambient", exhaustName: "",
		oemRoot: func(f *facts) map[string]any {
			return map[string]any{"Hpe": map[string]any{"@odata.type": "#HpeiLOServiceExt.v2_3_0.HpeiLOServiceExt",
				"Manager": []any{map[string]any{"ManagerType": product, "ManagerFirmwareVersion": f.firmware, "FQDN": strings.ToUpper("ILO" + f.serial)}}}}
		},
		oemSystem: func(f *facts) map[string]any {
			return map[string]any{"Hpe": map[string]any{"@odata.type": "#HpeComputerSystemExt.v2_10_0.HpeComputerSystemExt", "PostState": "FinishedPost", "ServerFQDN": f.fqdn}}
		},
		server: "HPE-iLO-Server/1.0",
	}
}

func ref(path string) map[string]string { return map[string]string{"@odata.id": path} }

func collection(path, odataType, name string, members []string) map[string]any {
	list := make([]any, 0, len(members))
	for _, m := range members {
		list = append(list, ref(m))
	}
	return map[string]any{"@odata.id": path, "@odata.type": odataType, "Name": name, "Members": list, "Members@odata.count": len(list)}
}

func statusOK() map[string]string { return map[string]string{"State": "Enabled", "Health": "OK"} }

// powerWatts is the simulated PowerConsumedWatts of a host (the estate carries no reading).
func (f *facts) powerWatts() int { return powerMinWatts + hashInt(powerSpanWatts, f.serial, "power") }

func (f *facts) dimmGiB() int {
	if f.memoryGiB >= dimmLargeFrom {
		return dimmLargeGiB
	}
	return dimmSmallGiB
}

// docs renders every Redfish resource of one BMC, keyed by @odata.id.
func (f *facts) docs(fl *flavour) map[string]any {
	d := map[string]any{}
	sysID := fl.systemID(f)
	sys := root + "/Systems/" + sysID
	ch := root + "/Chassis/" + fl.chassisID
	mgr := root + "/Managers/" + fl.managerID
	rootDoc := map[string]any{
		"@odata.id": root + "/", "@odata.type": "#ServiceRoot.v1_15_0.ServiceRoot", "Id": "RootService", "Name": "Root Service",
		"RedfishVersion": redfishVersion, "UUID": uuidOf(f.serial, "service"), "Vendor": fl.vendor, "Product": fl.product(f),
		"Systems": ref(root + "/Systems"), "Chassis": ref(root + "/Chassis"), "Managers": ref(root + "/Managers"),
		"SessionService": ref(root + "/SessionService"), "Links": map[string]any{"Sessions": ref(root + "/SessionService/Sessions")},
	}
	if fl.oemRoot != nil {
		rootDoc["Oem"] = fl.oemRoot(f)
	}
	d[root] = rootDoc
	d[root+"/Systems"] = collection(root+"/Systems", "#ComputerSystemCollection.ComputerSystemCollection", "Computer System Collection", []string{sys})
	d[root+"/Chassis"] = collection(root+"/Chassis", "#ChassisCollection.ChassisCollection", "Chassis Collection", []string{ch})
	d[root+"/Managers"] = collection(root+"/Managers", "#ManagerCollection.ManagerCollection", "Manager Collection", []string{mgr})

	power := "Off"
	if f.powerOn {
		power = "On"
	}
	sysDoc := map[string]any{
		"@odata.id": sys, "@odata.type": "#ComputerSystem.v1_20_0.ComputerSystem", "Id": sysID, "Name": "System",
		"SystemType": "Physical", "Manufacturer": fl.manufacturer(f), "Model": f.model, "SKU": f.partNumber, "PartNumber": f.partNumber,
		"SerialNumber": f.serial, "UUID": strings.ToUpper(f.uuid), "HostName": f.hostname, "PowerState": power, "BiosVersion": f.bios,
		"Status":           map[string]string{"State": "Enabled", "Health": "OK", "HealthRollup": "OK"},
		"ProcessorSummary": map[string]any{"Count": f.sockets, "Model": f.cpuModel, "Status": statusOK()},
		"MemorySummary":    map[string]any{"TotalSystemMemoryGiB": f.memoryGiB, "Status": statusOK()},
		"Links":            map[string]any{"Chassis": []any{ref(ch)}, "ManagedBy": []any{ref(mgr)}},
		"Processors":       ref(sys + "/Processors"), "Memory": ref(sys + "/Memory"), "Storage": ref(sys + "/Storage"),
		"EthernetInterfaces": ref(sys + "/EthernetInterfaces"),
	}
	if fl.oemSystem != nil {
		sysDoc["Oem"] = fl.oemSystem(f)
	}
	d[sys] = sysDoc

	procs := []string{}
	perSocket := 0
	if f.sockets > 0 {
		perSocket = f.cores / f.sockets
	}
	for i := 0; i < f.sockets; i++ {
		p := sys + "/Processors/" + fl.procID(i)
		procs = append(procs, p)
		d[p] = map[string]any{"@odata.id": p, "@odata.type": "#Processor.v1_18_0.Processor", "Id": fl.procID(i), "Name": "Processor",
			"Socket": "CPU " + strconv.Itoa(i+1), "ProcessorType": "CPU", "ProcessorArchitecture": "x86", "Manufacturer": cpuVendor(f.cpuModel),
			"Model": f.cpuModel, "TotalCores": perSocket, "TotalThreads": perSocket * threadsPerCore, "MaxSpeedMHz": maxSpeedMhz,
			"SerialNumber": serialOf("", 16, f.serial, "cpu", strconv.Itoa(i)), "Status": statusOK()}
	}
	d[sys+"/Processors"] = collection(sys+"/Processors", "#ProcessorCollection.ProcessorCollection", "Processors Collection", procs)

	dimms := []string{}
	size := f.dimmGiB()
	count := 0
	if size > 0 {
		count = f.memoryGiB / size
	}
	for n := 0; n < count && f.sockets > 0; n++ {
		s, i := n%f.sockets, n/f.sockets
		id := fl.dimmID(s, i)
		p := sys + "/Memory/" + id
		dimms = append(dimms, p)
		d[p] = map[string]any{"@odata.id": p, "@odata.type": "#Memory.v1_17_0.Memory", "Id": id, "Name": "DIMM " + strconv.Itoa(n+1),
			"DeviceLocator": fl.dimmLocator(s, i), "CapacityMiB": size * mibPerGiB, "MemoryDeviceType": "DDR5", "MemoryType": "DRAM",
			"Manufacturer": "Samsung", "SerialNumber": serialOf("", 8, f.serial, "dimm", id), "PartNumber": "M321R8GA0BB0-CQK ",
			"OperatingSpeedMhz": dimmSpeedMts, "Status": statusOK()}
	}
	d[sys+"/Memory"] = collection(sys+"/Memory", "#MemoryCollection.MemoryCollection", "Memory Collection", dimms)

	st := sys + "/Storage/" + fl.storageID
	drives := []any{}
	for i := 0; i < drivesPerHost; i++ {
		p := st + "/Drives/" + fl.driveID(i)
		drives = append(drives, ref(p))
		d[p] = map[string]any{"@odata.id": p, "@odata.type": "#Drive.v1_17_0.Drive", "Id": fl.driveID(i), "Name": fl.driveName(i),
			"Model": "MZ7L3960HCJR-00A07", "Manufacturer": "SAMSUNG", "SerialNumber": serialOf("S", 14, f.serial, "drive", strconv.Itoa(i)),
			"PartNumber": "SSDSC2KG960G8", "Revision": "JXTC604Q", "CapacityBytes": driveBytes, "MediaType": "SSD", "Protocol": "SATA", "Status": statusOK()}
	}
	d[st] = map[string]any{"@odata.id": st, "@odata.type": "#Storage.v1_15_0.Storage", "Id": fl.storageID, "Name": "Storage Controller", "Drives": drives, "Drives@odata.count": len(drives), "Status": statusOK()}
	d[sys+"/Storage"] = collection(sys+"/Storage", "#StorageCollection.StorageCollection", "Storage Collection", []string{st})

	nics := []string{}
	for i, mac := range f.macs {
		if i >= nicsPerHost {
			break
		}
		p := sys + "/EthernetInterfaces/" + fl.nicID(i)
		nics = append(nics, p)
		doc := map[string]any{"@odata.id": p, "@odata.type": "#EthernetInterface.v1_9_0.EthernetInterface", "Id": fl.nicID(i), "Name": "System Ethernet Interface",
			"MACAddress": strings.ToUpper(mac), "PermanentMACAddress": strings.ToUpper(mac), "LinkStatus": "LinkUp", "SpeedMbps": linkMbps, "Status": statusOK(),
			"IPv4Addresses": []any{}}
		if i == 0 && f.ip != "" {
			doc["IPv4Addresses"] = []any{map[string]any{"Address": f.ip, "AddressOrigin": "Static", "SubnetMask": "255.255.255.0"}}
		}
		d[p] = doc
	}
	d[sys+"/EthernetInterfaces"] = collection(sys+"/EthernetInterfaces", "#EthernetInterfaceCollection.EthernetInterfaceCollection", "System Ethernet Interface Collection", nics)

	chDoc := map[string]any{"@odata.id": ch, "@odata.type": "#Chassis.v1_23_0.Chassis", "Id": fl.chassisID, "Name": "Computer System Chassis",
		"ChassisType": "RackMount", "Manufacturer": fl.manufacturer(f), "Model": f.model, "SerialNumber": f.serial, "PartNumber": f.partNumber,
		"PowerState": power, "Status": statusOK(), "Power": ref(ch + "/Power"), "Thermal": ref(ch + "/Thermal"), "NetworkAdapters": ref(ch + "/NetworkAdapters"),
		"Links": map[string]any{"ComputerSystems": []any{ref(sys)}, "ManagedBy": []any{ref(mgr)}}}
	if f.rack != "" {
		chDoc["Location"] = map[string]any{"Placement": map[string]any{"Rack": f.rack, "RackOffset": f.rackU, "RackOffsetUnits": "EIA_310"}}
	}
	d[ch] = chDoc
	ad := ch + "/NetworkAdapters/" + fl.adapterID
	d[ch+"/NetworkAdapters"] = collection(ch+"/NetworkAdapters", "#NetworkAdapterCollection.NetworkAdapterCollection", "Network Adapter Collection", []string{ad})
	d[ad] = map[string]any{"@odata.id": ad, "@odata.type": "#NetworkAdapter.v1_9_0.NetworkAdapter", "Id": fl.adapterID, "Name": "Network Adapter",
		"Manufacturer": "Broadcom Inc. and subsidiaries", "Model": "BCM57414 NetXtreme-E 10Gb/25Gb RDMA Ethernet Controller",
		"SerialNumber": serialOf("", 12, f.serial, "adapter"), "PartNumber": "BCM957414A4142CC",
		"Controllers": []any{map[string]any{"FirmwarePackageVersion": "22.31.13.70"}}, "Status": statusOK()}

	watts := f.powerWatts()
	supplies := []any{}
	for i := 0; i < f.psus; i++ {
		supplies = append(supplies, map[string]any{"@odata.id": ch + "/Power#/PowerSupplies/" + strconv.Itoa(i), "MemberId": fl.psuMember(i), "Name": fl.psuName(i),
			"SerialNumber": serialOf("", 14, f.serial, "psu", strconv.Itoa(i)), "PowerCapacityWatts": psuWatts, "LineInputVoltage": 230, "Status": statusOK()})
	}
	d[ch+"/Power"] = map[string]any{"@odata.id": ch + "/Power", "@odata.type": "#Power.v1_7_1.Power", "Id": "Power", "Name": "Power",
		"PowerControl": []any{map[string]any{"@odata.id": ch + "/Power#/PowerControl/0", "MemberId": "0", "Name": "System Power Control",
			"PowerConsumedWatts": watts, "PowerCapacityWatts": psuWatts * f.psus}},
		"PowerSupplies": supplies}
	temps := []any{map[string]any{"MemberId": "0", "Name": fl.inletName, "ReadingCelsius": f.inletC, "PhysicalContext": "Intake", "Status": statusOK()}}
	if fl.exhaustName != "" {
		temps = append(temps, map[string]any{"MemberId": "1", "Name": fl.exhaustName, "ReadingCelsius": f.inletC + exhaustDelta, "PhysicalContext": "Exhaust", "Status": statusOK()})
	}
	fans := []any{}
	for i := 0; i < f.fans; i++ {
		fans = append(fans, map[string]any{"MemberId": strconv.Itoa(i), "Name": "Fan " + strconv.Itoa(i+1), "PhysicalContext": "SystemBoard", "Status": statusOK()})
	}
	d[ch+"/Thermal"] = map[string]any{"@odata.id": ch + "/Thermal", "@odata.type": "#Thermal.v1_7_0.Thermal", "Id": "Thermal", "Name": "Thermal", "Temperatures": temps, "Fans": fans}

	mgrDoc := map[string]any{"@odata.id": mgr, "@odata.type": "#Manager.v1_17_0.Manager", "Id": fl.managerID, "Name": "Manager", "ManagerType": "BMC",
		"Model": fl.managerModel(f), "FirmwareVersion": fl.managerFw(f), "UUID": uuidOf(f.serial, "manager"), "Status": statusOK(),
		"Links": map[string]any{"ManagerForServers": []any{ref(sys)}, "ManagerForChassis": []any{ref(ch)}}}
	d[mgr] = mgrDoc
	return d
}

func cpuVendor(model string) string {
	if strings.Contains(strings.ToLower(model), "amd") || strings.Contains(strings.ToLower(model), "epyc") {
		return "Advanced Micro Devices, Inc."
	}
	return "Intel(R) Corporation"
}

// writeJSON answers with the Redfish media type and OData-Version header every conformant service sends.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("OData-Version", "4.0")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func redfishError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": "Base.1.16." + code, "message": msg,
		"@Message.ExtendedInfo": []any{map[string]any{"MessageId": "Base.1.16." + code, "Message": msg, "Severity": "Critical"}}}})
}

func (f *facts) handler(env *sim.Env, fl *flavour) http.Handler {
	docs := f.docs(fl)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fl.server != "" {
			w.Header().Set("Server", fl.server)
		}
		if r.Method != http.MethodGet {
			redfishError(w, http.StatusMethodNotAllowed, "OperationNotAllowed", "The HTTP method is not allowed on this resource.")
			return
		}
		path := strings.TrimSuffix(r.URL.Path, "/")
		if path == "/redfish" {
			writeJSON(w, http.StatusOK, map[string]string{"v1": root + "/"})
			return
		}
		if path != root && !env.BasicOK(r) {
			w.Header().Set("WWW-Authenticate", `Basic realm="Redfish"`)
			redfishError(w, http.StatusUnauthorized, "NoValidSession", "There is no valid session established with the implementation.")
			return
		}
		doc, ok := docs[path]
		if !ok {
			redfishError(w, http.StatusNotFound, "ResourceNotFound", "The requested resource of type "+path+" was not found.")
			return
		}
		writeJSON(w, http.StatusOK, doc)
	})
}

type planned struct {
	f  *facts
	fl *flavour
}

// plan picks perFlavour estate BMCs of every product (in estate order) plus the seeded CIMC and generic BMC.
func plan(e *estate.Estate) []planned {
	byProduct := map[string][]planned{}
	for _, b := range e.OfType("bmc", nil) {
		fl, ok := flavours[b.Str("product")]
		if !ok || len(byProduct[b.Str("product")]) >= perFlavour {
			continue
		}
		hosts := e.From(b, "manages")
		if len(hosts) == 0 {
			continue
		}
		byProduct[b.Str("product")] = append(byProduct[b.Str("product")], planned{fromEstate(b, hosts[0]), fl})
	}
	products := make([]string, 0, len(byProduct))
	for p := range byProduct {
		products = append(products, p)
	}
	sort.Strings(products)
	var out []planned
	for _, p := range products {
		out = append(out, byProduct[p]...)
	}
	out = append(out,
		planned{seeded("c240-ryd-sim-01", "WZP", "C240M6.4.3.2b.0", "CIMC", "Cisco Systems Inc", "UCSC-C240-M6SX", "Intel(R) Xeon(R) Gold 6342 CPU @ 2.80GHz", "4.3(2.240009)"), flavours["CIMC"]},
		planned{seeded("rack-ryd-sim-01", "437XR", "P79 v1.45 (12/06/2017)", "Generic", "Contoso", "3500", "Multi-Core Intel(R) Xeon(R) processor 7xxx Series", "4.4.6521"), flavours["Generic"]},
	)
	return out
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	plans := plan(e)
	byKey := map[string]planned{}
	keys := make([]string, 0, len(plans))
	for _, p := range plans {
		byKey[p.f.key] = p
		keys = append(keys, p.f.key)
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return byKey[k].f.handler(env, byKey[k].fl) })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, p := range plan(e) {
		u, err := url.Parse(ep.Devices[p.f.key])
		if err != nil {
			continue
		}
		port, _ := strconv.Atoi(u.Port())
		run := sim.Run{
			Name:           p.fl.name + "/" + p.f.key,
			Targets:        []sim.Target{{Kind: "host", Value: u.Hostname(), Label: p.f.key}},
			Options:        map[string]any{"port": port, "verifyTls": true, "caCertPem": env.CA.PEM},
			CredentialType: "password",
			Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
		}
		// The collector names the bmc after the ServiceRoot Product and the address it dialled (the advertised simulator host).
		bmcName := p.fl.product(p.f) + " @ " + u.Hostname()
		hostName := p.f.hostname
		if p.f.bmc != nil {
			run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: "bmc", Name: bmcName, Identity: p.f.bmc.Identity})
			run.Expect.EstateCI(p.f.host)
			hostName = p.f.host.Name
		} else {
			run.Expect.CI("bmc", bmcName)
			identity := map[string]string{"serialNumber": p.f.serial, "systemUuid": p.f.uuid, "primaryMac": p.f.macs[0]}
			run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: "host", Name: hostName, Identity: identity})
		}
		run.Expect.Rel("manages", "bmc", bmcName, "host", hostName)
		run.Expect.Rel("contains", "host", hostName, "bmc", bmcName)
		runs = append(runs, run)
	}
	return runs
}

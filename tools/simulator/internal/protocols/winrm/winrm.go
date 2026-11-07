// REQ-QA-005 REQ-DISC-002 REQ-DISC-006 REQ-DISC-016 REQ-DISC-022 — simulated WinRM (WS-Management) listener for the
// Windows collectors. It speaks the remote shell protocol the collectors' client (github.com/masterzen/winrm) uses:
// transfer/Create opens a cmd shell, shell/Command runs a command line, shell/Receive returns base64 stdout and
// stderr streams (split across responses to honour MaxEnvelopeSize) with CommandState Done and the ExitCode,
// shell/Signal terminates and transfer/Delete closes the shell. HTTP Basic credentials (env.User / env.Secret) are
// checked on every request over HTTPS under the simulated-mode CA; anything else gets the 401 a WinRM service
// sends. `powershell.exe -EncodedCommand <base64 UTF-16LE>` lines are decoded and handed to the simulated host's
// script callback, whose stdout is what the real cmdlets would print.
//
// A collector job carries one port option for all its targets, so hosts are told apart by address. When the
// simulator advertises a loopback address (verify, the default), each simulated host gets its own loopback address
// (127.0.x.y, never 127.0.0.1) and all share one port: one job covers every host. When it advertises a name on a
// network (simulator serve in the compose profile), each host listens on its own port at the bind address
// (sim.Listen) and Jobs plans one job per host. Either way collectors verify the simulated-mode leaf certificate
// with caCertPem and tlsServerName = sim.AdvertiseHost(), a name or address the leaf carries.
package winrm

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

// ServerName is the name collectors verify on the listener certificate (collector option tlsServerName).
func ServerName() string { return sim.AdvertiseHost() }

const (
	nsEnvelope   = "http://www.w3.org/2003/05/soap-envelope"
	nsAddressing = "http://schemas.xmlsoap.org/ws/2004/08/addressing"
	nsTransfer   = "http://schemas.xmlsoap.org/ws/2004/09/transfer"
	nsWsman      = "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
	nsShell      = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell"
	nsFault      = "http://schemas.microsoft.com/wbem/wsman/1/wsmanfault"

	actionCreate   = nsTransfer + "/Create"
	actionDelete   = nsTransfer + "/Delete"
	actionCommand  = nsShell + "/Command"
	actionReceive  = nsShell + "/Receive"
	actionSignal   = nsShell + "/Signal"
	actionSend     = nsShell + "/Send"
	actionFault    = "http://schemas.dmtf.org/wbem/wsman/1/wsman/fault"
	resourceCmd    = nsShell + "/cmd"
	stateDone      = nsShell + "/CommandState/Done"
	stateRunning   = nsShell + "/CommandState/Running"
	anonymous      = nsAddressing + "/role/anonymous"
	soapType       = "application/soap+xml;charset=UTF-8"
	path           = "/wsman"
	selectorShell  = "ShellId"
	streamStdout   = "stdout"
	streamStderr   = "stderr"
	bindAttempts   = 8
	firstHostOctet = 2
	hostsPerOctet  = 250
	// defaultEnvelope is the WinRM service default MaxEnvelopeSizekb (500 KiB) when a request names none.
	defaultEnvelope = 512000
	// envelopeOverhead is the room kept for the SOAP envelope around the streams of one Receive response.
	envelopeOverhead = 4096
	base64Num        = 3
	base64Den        = 4
	// exitNotRecognised is cmd.exe's exit code for a command it cannot find.
	exitNotRecognised = 9009
	readHeaderTimeout = 10 * time.Second
	shutdownTimeout   = 10 * time.Second
	uuidBytes         = 16
	utf16Width        = 2
	uuidVersion4      = 0x40
	uuidVersionMask   = 0x0f
	uuidVariant       = 0x80
	uuidVariantMask   = 0x3f
	stateHostPorts    = "winrmHostPorts"
)

// Output is what one command printed and its exit code.
type Output struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Script runs a decoded PowerShell script on one simulated host.
type Script func(script string) Output

// Unsupported is the output of PowerShell for a script whose cmdlets the simulated host does not have.
func Unsupported(cmdlet string) Output {
	return Output{Stderr: cmdlet + " : The term '" + cmdlet + "' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n", ExitCode: 1}
}

// FirstCmdlet is the first Verb-Noun token of a script, the one PowerShell reports when it is not installed.
func FirstCmdlet(script string) string {
	for _, f := range strings.FieldsFunc(script, func(r rune) bool { return unicode.IsSpace(r) || strings.ContainsRune("({|;", r) }) {
		if verb, noun, ok := strings.Cut(f, "-"); ok && verb != "" && noun != "" && verb[0] >= 'A' && verb[0] <= 'Z' {
			return f
		}
	}
	return "Invoke-Expression"
}

type command struct {
	stdout, stderr []byte
	exit           int
	done           bool
}

type shell struct {
	host     string
	commands map[string]*command
}

type server struct {
	env    *sim.Env
	hosts  map[string]Script
	log    *sim.RequestLog
	logMu  sync.Mutex
	mu     sync.Mutex
	shells map[string]*shell
}

// loopbackAddress is the loopback address of the i-th simulated host.
func loopbackAddress(i int) string {
	return "127.0." + strconv.Itoa(i/hostsPerOctet) + "." + strconv.Itoa(i%hostsPerOctet+firstHostOctet)
}

func perAddress() bool {
	ip := net.ParseIP(sim.AdvertiseHost())
	return ip != nil && ip.IsLoopback()
}

// Serve starts one WinRM HTTPS listener per host key. Endpoint.Devices maps each key to the address collectors
// target, State["log"] is the request log; plan the collector jobs with Jobs.
func Serve(env *sim.Env, keys []string, script func(key string) Script) (*sim.Endpoint, error) {
	if len(keys) == 0 {
		return nil, errors.New("winrm: no hosts to serve")
	}
	s := &server{env: env, hosts: map[string]Script{}, log: &sim.RequestLog{}, shells: map[string]*shell{}}
	for _, k := range keys {
		s.hosts[k] = script(k)
	}
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), Devices: map[string]string{}, State: map[string]any{"log": s.log}}
	lns := make([]net.Listener, len(keys))
	if perAddress() {
		addrs := make([]string, len(keys))
		for i := range keys {
			addrs[i] = loopbackAddress(i)
		}
		bound, port, err := bindAll(addrs)
		if err != nil {
			return nil, err
		}
		copy(lns, bound)
		ep.Port = port
		for i, k := range keys {
			ep.Devices[k] = addrs[i]
		}
	} else {
		ports := map[string]int{}
		for i, k := range keys {
			ln, port, err := sim.Listen()
			if err != nil {
				for _, l := range lns[:i] {
					_ = l.Close()
				}
				return nil, err
			}
			lns[i] = ln
			ports[k] = port
			ep.Devices[k] = sim.AdvertiseHost()
		}
		ep.State[stateHostPorts] = ports
	}
	servers := make([]*http.Server, len(keys))
	for i, k := range keys {
		servers[i] = &http.Server{Handler: s.handler(k), ReadHeaderTimeout: readHeaderTimeout}
		go func(srv *http.Server, l net.Listener) { _ = srv.Serve(l) }(servers[i], tls.NewListener(lns[i], env.CA.ServerConfig()))
	}
	ep.OnClose(func() error {
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		var first error
		for _, srv := range servers {
			if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) && first == nil {
				first = err
			}
		}
		return first
	})
	return ep, nil
}

// Job is one collector invocation: the host keys it targets and the WinRM port they all listen on.
type Job struct {
	Keys []string
	Port int
}

// Jobs plans the collector invocations for keys served by ep: one job for every host when hosts have their own
// loopback addresses, one job per host when each has its own port.
func Jobs(ep *sim.Endpoint, keys []string) []Job {
	ports, ok := ep.State[stateHostPorts].(map[string]int)
	if !ok {
		return []Job{{Keys: keys, Port: ep.Port}}
	}
	out := make([]Job, 0, len(keys))
	for _, k := range keys {
		out = append(out, Job{Keys: []string{k}, Port: ports[k]})
	}
	return out
}

// bindAll listens on every address with one shared port, retrying with a fresh port when one is taken.
func bindAll(addrs []string) ([]net.Listener, int, error) {
	var last error
	for attempt := 0; attempt < bindAttempts; attempt++ {
		first, err := net.Listen("tcp", net.JoinHostPort(addrs[0], "0"))
		if err != nil {
			return nil, 0, err
		}
		port := first.Addr().(*net.TCPAddr).Port
		lns := []net.Listener{first}
		ok := true
		for _, a := range addrs[1:] {
			ln, err := net.Listen("tcp", net.JoinHostPort(a, strconv.Itoa(port)))
			if err != nil {
				last, ok = err, false
				break
			}
			lns = append(lns, ln)
		}
		if ok {
			return lns, port, nil
		}
		for _, ln := range lns {
			_ = ln.Close()
		}
	}
	return nil, 0, fmt.Errorf("winrm: no shared port for %d loopback addresses: %w", len(addrs), last)
}

func (s *server) record(r *http.Request, action string, status int) {
	short := action[strings.LastIndex(action, "/")+1:]
	s.logMu.Lock()
	// The request log's own lock is unexported; entries are appended here under this server's lock and read by
	// the harness only after the collector process has exited.
	s.log.Entries = append(s.log.Entries, r.Method+" "+r.URL.RequestURI()+" "+short+" "+strconv.Itoa(status))
	s.logMu.Unlock()
}

type selector struct {
	Name  string `xml:"Name,attr"`
	Value string `xml:",chardata"`
}

type stream struct {
	CommandID string `xml:"CommandId,attr"`
	Name      string `xml:"Name,attr"`
	Value     string `xml:",chardata"`
}

type envelope struct {
	Header struct {
		Action          string     `xml:"Action"`
		MessageID       string     `xml:"MessageID"`
		ResourceURI     string     `xml:"ResourceURI"`
		MaxEnvelopeSize string     `xml:"MaxEnvelopeSize"`
		Selectors       []selector `xml:"SelectorSet>Selector"`
	} `xml:"Header"`
	Body struct {
		Shell *struct {
			InputStreams  string `xml:"InputStreams"`
			OutputStreams string `xml:"OutputStreams"`
		} `xml:"Shell"`
		CommandLine *struct {
			Command   string   `xml:"Command"`
			Arguments []string `xml:"Arguments"`
		} `xml:"CommandLine"`
		Receive *struct {
			DesiredStream stream `xml:"DesiredStream"`
		} `xml:"Receive"`
		Signal *struct {
			CommandID string `xml:"CommandId,attr"`
			Code      string `xml:"Code"`
		} `xml:"Signal"`
		Send *struct {
			Stream stream `xml:"Stream"`
		} `xml:"Send"`
	} `xml:"Body"`
}

func (e *envelope) shellID() string {
	for _, s := range e.Header.Selectors {
		if s.Name == selectorShell {
			return strings.TrimSpace(s.Value)
		}
	}
	return ""
}

func (s *server) handler(host string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handle(w, r, host) })
}

func (s *server) handle(w http.ResponseWriter, r *http.Request, host string) {
	if r.URL.Path != path || r.Method != http.MethodPost {
		w.WriteHeader(http.StatusNotFound)
		s.record(r, "-", http.StatusNotFound)
		return
	}
	if !s.env.BasicOK(r) {
		// A WinRM service with Basic enabled answers a missing or wrong credential with an empty 401.
		w.Header().Add("WWW-Authenticate", "Negotiate")
		w.Header().Add("WWW-Authenticate", `Basic realm="WSMAN"`)
		w.WriteHeader(http.StatusUnauthorized)
		s.record(r, "auth", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.fault(w, r, "", "w:InvalidMessageInformationHeader", "unreadable request")
		return
	}
	var env envelope
	if err := xml.Unmarshal(body, &env); err != nil {
		s.fault(w, r, "", "w:InvalidMessageInformationHeader", "The request is not a SOAP envelope.")
		return
	}
	if env.Header.ResourceURI != resourceCmd {
		s.fault(w, r, env.Header.MessageID, "w:DestinationUnreachable", "The WS-Management service cannot process the request. The resource URI is not supported.")
		return
	}
	switch env.Header.Action {
	case actionCreate:
		s.create(w, r, &env, host)
	case actionCommand:
		s.command(w, r, &env, host)
	case actionReceive:
		s.receive(w, r, &env, host)
	case actionSignal:
		s.signal(w, r, &env, host)
	case actionSend:
		s.send(w, r, &env, host)
	case actionDelete:
		s.delete(w, r, &env, host)
	default:
		s.fault(w, r, env.Header.MessageID, "w:ActionNotSupported", "The action is not supported by the service.")
	}
}

func newID() string {
	b := make([]byte, uuidBytes)
	_, _ = rand.Read(b)
	b[6] = (b[6] & uuidVersionMask) | uuidVersion4
	b[8] = (b[8] & uuidVariantMask) | uuidVariant
	h := strings.ToUpper(hex.EncodeToString(b))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func esc(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func (s *server) reply(w http.ResponseWriter, r *http.Request, status int, action, relatesTo, body string) {
	var b strings.Builder
	b.WriteString(`<s:Envelope xml:lang="en-US" xmlns:s="` + nsEnvelope + `" xmlns:a="` + nsAddressing + `" xmlns:x="` + nsTransfer + `" xmlns:w="` + nsWsman + `" xmlns:rsp="` + nsShell + `" xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd">`)
	b.WriteString(`<s:Header><a:Action>` + action + `</a:Action><a:MessageID>uuid:` + newID() + `</a:MessageID><a:To>` + anonymous + `</a:To>`)
	if relatesTo != "" {
		b.WriteString(`<a:RelatesTo>` + esc(relatesTo) + `</a:RelatesTo>`)
	}
	b.WriteString(`</s:Header><s:Body>` + body + `</s:Body></s:Envelope>`)
	w.Header().Set("Content-Type", soapType)
	w.WriteHeader(status)
	_, _ = io.WriteString(w, b.String())
	s.record(r, action, status)
}

func (s *server) fault(w http.ResponseWriter, r *http.Request, relatesTo, subcode, text string) {
	body := `<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>` + subcode + `</s:Value></s:Subcode></s:Code>` +
		`<s:Reason><s:Text xml:lang="en-US">` + esc(text) + `</s:Text></s:Reason><s:Detail><f:WSManFault xmlns:f="` + nsFault + `" Code="2150858843" Machine="` + esc(ServerName()) + `"><f:Message>` + esc(text) + `</f:Message></f:WSManFault></s:Detail></s:Fault>`
	s.reply(w, r, http.StatusInternalServerError, actionFault, relatesTo, body)
}

func (s *server) create(w http.ResponseWriter, r *http.Request, env *envelope, host string) {
	id := newID()
	s.mu.Lock()
	s.shells[id] = &shell{host: host, commands: map[string]*command{}}
	s.mu.Unlock()
	addr := "https://" + r.Host + path
	body := `<x:ResourceCreated><a:Address>` + esc(addr) + `</a:Address><a:ReferenceParameters><w:ResourceURI>` + resourceCmd + `</w:ResourceURI>` +
		`<w:SelectorSet><w:Selector Name="ShellId">` + id + `</w:Selector></w:SelectorSet></a:ReferenceParameters></x:ResourceCreated>` +
		`<rsp:Shell><rsp:ShellId>` + id + `</rsp:ShellId><rsp:ResourceUri>` + resourceCmd + `</rsp:ResourceUri><rsp:Owner>` + esc(s.env.User) + `</rsp:Owner>` +
		`<rsp:ClientIP>` + esc(clientIP(r)) + `</rsp:ClientIP><rsp:IdleTimeOut>PT7200.000S</rsp:IdleTimeOut><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`
	s.reply(w, r, http.StatusOK, actionCreate+"Response", env.Header.MessageID, body)
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

func (s *server) shellFor(env *envelope, host string) *shell {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh := s.shells[env.shellID()]
	if sh == nil || sh.host != host {
		return nil
	}
	return sh
}

func (s *server) command(w http.ResponseWriter, r *http.Request, env *envelope, host string) {
	sh := s.shellFor(env, host)
	if sh == nil || env.Body.CommandLine == nil {
		s.fault(w, r, env.Header.MessageID, "w:InvalidSelectors", "The request for the Windows Remote Shell with ShellId "+env.shellID()+" failed because the shell was not found on the server.")
		return
	}
	line := strings.TrimSpace(env.Body.CommandLine.Command)
	if len(env.Body.CommandLine.Arguments) > 0 {
		line += " " + strings.Join(env.Body.CommandLine.Arguments, " ")
	}
	out := s.run(host, line)
	id := newID()
	s.mu.Lock()
	sh.commands[id] = &command{stdout: []byte(out.Stdout), stderr: []byte(out.Stderr), exit: out.ExitCode}
	s.mu.Unlock()
	s.reply(w, r, http.StatusOK, actionCommand+"Response", env.Header.MessageID, `<rsp:CommandResponse><rsp:CommandId>`+id+`</rsp:CommandId></rsp:CommandResponse>`)
}

// run executes one cmd.exe command line: a PowerShell -EncodedCommand is decoded and run on the host, anything
// else is a command the simulated host does not have.
func (s *server) run(host, line string) Output {
	if script, ok := DecodeCommand(line); ok {
		return s.hosts[host](script)
	}
	exe := line
	if f := strings.Fields(line); len(f) > 0 {
		exe = f[0]
	}
	return Output{Stderr: "'" + exe + "' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n", ExitCode: exitNotRecognised}
}

// DecodeCommand returns the script of a `powershell[.exe] ... -EncodedCommand <base64 UTF-16LE>` command line.
func DecodeCommand(line string) (string, bool) {
	f := strings.Fields(line)
	if len(f) == 0 {
		return "", false
	}
	exe := strings.ToLower(f[0])
	exe = exe[strings.LastIndexAny(exe, `\/`)+1:]
	if exe != "powershell" && exe != "powershell.exe" && exe != "pwsh" && exe != "pwsh.exe" {
		return "", false
	}
	for i := 1; i+1 < len(f); i++ {
		switch strings.ToLower(f[i]) {
		case "-encodedcommand", "-enc", "-ec", "-e":
			raw, err := base64.StdEncoding.DecodeString(f[i+1])
			if err != nil || len(raw)%utf16Width != 0 {
				return "", false
			}
			u := make([]uint16, len(raw)/utf16Width)
			for j := range u {
				u[j] = binary.LittleEndian.Uint16(raw[j*utf16Width:])
			}
			return string(utf16.Decode(u)), true
		}
	}
	return "", false
}

func maxEnvelope(env *envelope) int {
	n, err := strconv.Atoi(strings.TrimSpace(env.Header.MaxEnvelopeSize))
	if err != nil || n <= envelopeOverhead {
		return defaultEnvelope
	}
	return n
}

func (s *server) receive(w http.ResponseWriter, r *http.Request, env *envelope, host string) {
	sh := s.shellFor(env, host)
	if sh == nil || env.Body.Receive == nil {
		s.fault(w, r, env.Header.MessageID, "w:InvalidSelectors", "The shell was not found on the server.")
		return
	}
	id := env.Body.Receive.DesiredStream.CommandID
	budget := (maxEnvelope(env) - envelopeOverhead) * base64Num / base64Den
	s.mu.Lock()
	c := sh.commands[id]
	if c == nil {
		s.mu.Unlock()
		s.fault(w, r, env.Header.MessageID, "w:InvalidSelectors", "The command was not found on the server.")
		return
	}
	var b strings.Builder
	b.WriteString(`<rsp:ReceiveResponse>`)
	take := func(name string, buf *[]byte) {
		if len(*buf) == 0 || budget <= 0 {
			return
		}
		n := min(len(*buf), budget)
		b.WriteString(`<rsp:Stream Name="` + name + `" CommandId="` + id + `">` + base64.StdEncoding.EncodeToString((*buf)[:n]) + `</rsp:Stream>`)
		*buf = (*buf)[n:]
		budget -= n
	}
	take(streamStdout, &c.stdout)
	take(streamStderr, &c.stderr)
	if len(c.stdout) == 0 && len(c.stderr) == 0 {
		c.done = true
		b.WriteString(`<rsp:Stream Name="stdout" CommandId="` + id + `" End="true"></rsp:Stream><rsp:Stream Name="stderr" CommandId="` + id + `" End="true"></rsp:Stream>`)
		b.WriteString(`<rsp:CommandState CommandId="` + id + `" State="` + stateDone + `"><rsp:ExitCode>` + strconv.Itoa(c.exit) + `</rsp:ExitCode></rsp:CommandState>`)
	} else {
		b.WriteString(`<rsp:CommandState CommandId="` + id + `" State="` + stateRunning + `"></rsp:CommandState>`)
	}
	s.mu.Unlock()
	b.WriteString(`</rsp:ReceiveResponse>`)
	s.reply(w, r, http.StatusOK, actionReceive+"Response", env.Header.MessageID, b.String())
}

func (s *server) signal(w http.ResponseWriter, r *http.Request, env *envelope, host string) {
	sh := s.shellFor(env, host)
	if sh == nil || env.Body.Signal == nil {
		s.fault(w, r, env.Header.MessageID, "w:InvalidSelectors", "The shell was not found on the server.")
		return
	}
	s.mu.Lock()
	delete(sh.commands, env.Body.Signal.CommandID)
	s.mu.Unlock()
	s.reply(w, r, http.StatusOK, actionSignal+"Response", env.Header.MessageID, `<rsp:SignalResponse></rsp:SignalResponse>`)
}

// send accepts stdin; the simulated scripts read none, so the input is discarded like a closed console.
func (s *server) send(w http.ResponseWriter, r *http.Request, env *envelope, host string) {
	if s.shellFor(env, host) == nil {
		s.fault(w, r, env.Header.MessageID, "w:InvalidSelectors", "The shell was not found on the server.")
		return
	}
	s.reply(w, r, http.StatusOK, actionSend+"Response", env.Header.MessageID, `<rsp:SendResponse></rsp:SendResponse>`)
}

func (s *server) delete(w http.ResponseWriter, r *http.Request, env *envelope, host string) {
	if s.shellFor(env, host) == nil {
		s.fault(w, r, env.Header.MessageID, "w:InvalidSelectors", "The shell was not found on the server.")
		return
	}
	s.mu.Lock()
	delete(s.shells, env.shellID())
	s.mu.Unlock()
	s.reply(w, r, http.StatusOK, actionDelete+"Response", env.Header.MessageID, "")
}

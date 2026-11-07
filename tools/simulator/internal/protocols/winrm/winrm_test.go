// T-374 REQ-QA-005 REQ-DISC-002 — the simulated WinRM listener speaks the remote shell protocol: a wrong credential
// gets the empty 401 a WinRM service sends, a shell is created, a PowerShell -EncodedCommand is decoded and run on
// the right host, output larger than MaxEnvelopeSize arrives over several Receive responses before CommandState
// Done with the exit code, a command cmd.exe cannot find exits 9009, and Signal and Delete close the command and
// shell.
package winrm

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	testEnvelope = 153600
	bigOutput    = 400000
)

type client struct {
	t    *testing.T
	http *http.Client
	url  string
	user string
	pass string
}

func (c *client) post(body string) (int, string) {
	c.t.Helper()
	req, err := http.NewRequest(http.MethodPost, c.url, strings.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Content-Type", soapType)
	req.SetBasicAuth(c.user, c.pass)
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func envelopeFor(action, shellID, body string) string {
	sel := ""
	if shellID != "" {
		sel = `<w:SelectorSet><w:Selector Name="ShellId">` + shellID + `</w:Selector></w:SelectorSet>`
	}
	return `<env:Envelope xmlns:env="` + nsEnvelope + `" xmlns:a="` + nsAddressing + `" xmlns:w="` + nsWsman + `" xmlns:rsp="` + nsShell + `"><env:Header>` +
		`<a:Action mustUnderstand="true">` + action + `</a:Action><a:MessageID>uuid:1</a:MessageID><w:ResourceURI mustUnderstand="true">` + resourceCmd + `</w:ResourceURI>` +
		`<w:MaxEnvelopeSize mustUnderstand="true">` + strconv.Itoa(testEnvelope) + `</w:MaxEnvelopeSize>` + sel + `</env:Header><env:Body>` + body + `</env:Body></env:Envelope>`
}

func encoded(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*utf16Width)
	for i, r := range u {
		binary.LittleEndian.PutUint16(b[i*utf16Width:], r)
	}
	return "powershell.exe -EncodedCommand " + base64.StdEncoding.EncodeToString(b)
}

type receiveDoc struct {
	Streams []struct {
		Name  string `xml:"Name,attr"`
		Value string `xml:",chardata"`
	} `xml:"Body>ReceiveResponse>Stream"`
	State struct {
		State    string `xml:"State,attr"`
		ExitCode int    `xml:"ExitCode"`
	} `xml:"Body>ReceiveResponse>CommandState"`
}

func field(t *testing.T, doc, name string) string {
	t.Helper()
	_, rest, ok := strings.Cut(doc, "<rsp:"+name+">")
	if !ok {
		t.Fatalf("no %s in %s", name, doc)
	}
	v, _, _ := strings.Cut(rest, "</rsp:"+name+">")
	return v
}

func (c *client) run(shellID, line string) (string, int, int) {
	c.t.Helper()
	status, doc := c.post(envelopeFor(actionCommand, shellID, `<rsp:CommandLine><rsp:Command><![CDATA[`+line+`]]></rsp:Command></rsp:CommandLine>`))
	if status != http.StatusOK {
		c.t.Fatalf("command: %d %s", status, doc)
	}
	id := field(c.t, doc, "CommandId")
	var out bytes.Buffer
	for responses := 1; ; responses++ {
		status, doc = c.post(envelopeFor(actionReceive, shellID, `<rsp:Receive><rsp:DesiredStream CommandId="`+id+`">stdout stderr</rsp:DesiredStream></rsp:Receive>`))
		if status != http.StatusOK || len(doc) > testEnvelope {
			c.t.Fatalf("receive: status %d, %d bytes", status, len(doc))
		}
		var r receiveDoc
		if err := xml.Unmarshal([]byte(doc), &r); err != nil {
			c.t.Fatal(err)
		}
		for _, s := range r.Streams {
			b, err := base64.StdEncoding.DecodeString(s.Value)
			if err != nil {
				c.t.Fatal(err)
			}
			if s.Name == streamStdout {
				out.Write(b)
			}
		}
		if r.State.State == stateDone {
			if status, _ := c.post(envelopeFor(actionSignal, shellID, `<rsp:Signal CommandId="`+id+`"><rsp:Code>`+nsShell+`/signal/terminate</rsp:Code></rsp:Signal>`)); status != http.StatusOK {
				c.t.Fatalf("signal: %d", status)
			}
			return out.String(), r.State.ExitCode, responses
		}
	}
}

func TestREQDISC002_T374_RemoteShellProtocol(t *testing.T) {
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("x", bigOutput)
	ep, err := Serve(env, []string{"a.example", "b.example"}, func(key string) Script {
		return func(script string) Output {
			if strings.Contains(script, "Get-Big") {
				return Output{Stdout: big}
			}
			return Output{Stdout: key + ":" + script, ExitCode: len(key)}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ep.Close()
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM([]byte(env.CA.PEM))
	hc := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: ServerName(), MinVersion: tls.VersionTLS12}}}
	port := Jobs(ep, []string{"b.example"})[0].Port
	c := &client{t: t, http: hc, url: "https://" + net.JoinHostPort(ep.Devices["b.example"], strconv.Itoa(port)) + path, user: env.User, pass: "wrong"}
	if status, body := c.post(envelopeFor(actionCreate, "", `<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`)); status != http.StatusUnauthorized || body != "" {
		t.Fatalf("wrong credential: %d %q", status, body)
	}
	c.pass = env.Secret
	status, doc := c.post(envelopeFor(actionCreate, "", `<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`))
	if status != http.StatusOK || !strings.Contains(doc, actionCreate+"Response") {
		t.Fatalf("create: %d %s", status, doc)
	}
	shellID := field(t, doc, "ShellId")
	if out, code, _ := c.run(shellID, encoded("Get-Date")); out != "b.example:Get-Date" || code != len("b.example") {
		t.Fatalf("script ran on the wrong host or was not decoded: %q %d", out, code)
	}
	if out, code, responses := c.run(shellID, encoded("Get-Big")); out != big || code != 0 || responses < 2 {
		t.Fatalf("large output: %d bytes, exit %d, %d responses", len(out), code, responses)
	}
	if _, code, _ := c.run(shellID, "ipconfig /all"); code != exitNotRecognised {
		t.Fatalf("unknown command exit %d", code)
	}
	if status, _ := c.post(envelopeFor(actionDelete, shellID, "")); status != http.StatusOK {
		t.Fatalf("delete: %d", status)
	}
	if status, _ := c.post(envelopeFor(actionDelete, shellID, "")); status != http.StatusInternalServerError {
		t.Fatalf("a deleted shell must fault, got %d", status)
	}
}

// When the simulator advertises a name (the compose profile), every host listens on its own port and Jobs plans
// one job per host.
func TestREQDISC002_T374_PerPortWhenAdvertisingAName(t *testing.T) {
	sim.Configure("", "localhost")
	defer sim.Configure("", "127.0.0.1")
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{"a.example", "b.example", "c.example"}
	ep, err := Serve(env, keys, func(key string) Script { return func(string) Output { return Output{Stdout: key} } })
	if err != nil {
		t.Fatal(err)
	}
	defer ep.Close()
	jobs := Jobs(ep, keys)
	ports := map[int]bool{}
	for _, j := range jobs {
		ports[j.Port] = true
		if len(j.Keys) != 1 || ep.Devices[j.Keys[0]] != "localhost" {
			t.Fatalf("job %+v targets %q", j, ep.Devices[j.Keys[0]])
		}
	}
	if len(jobs) != len(keys) || len(ports) != len(keys) {
		t.Fatalf("expected one job and port per host, got %+v", jobs)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM([]byte(env.CA.PEM))
	hc := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: ServerName(), MinVersion: tls.VersionTLS12}}}
	c := &client{t: t, http: hc, url: "https://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(jobs[2].Port)) + path, user: env.User, pass: env.Secret}
	status, doc := c.post(envelopeFor(actionCreate, "", `<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>`))
	if status != http.StatusOK {
		t.Fatalf("create: %d %s", status, doc)
	}
	if out, _, _ := c.run(field(t, doc, "ShellId"), encoded("Get-Date")); out != jobs[2].Keys[0] {
		t.Fatalf("port %d answered as %q", jobs[2].Port, out)
	}
}

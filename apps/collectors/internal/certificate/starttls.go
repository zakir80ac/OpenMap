// REQ-DISC-025 — StartTLS negotiation for the certificate collector: services that speak a plaintext
// protocol first and upgrade in-band (SMTP STARTTLS after EHLO, IMAP STARTTLS, POP3 STLS, the LDAP
// StartTLS extended operation and the PostgreSQL SSLRequest) are negotiated up to the point where the
// TLS handshake starts; Probe then records the chain exactly as it does for direct TLS.
package certificate

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
)

// StartTLS protocol names accepted by the startTls option.
const (
	StartTLSSMTP     = "smtp"
	StartTLSIMAP     = "imap"
	StartTLSPOP3     = "pop3"
	StartTLSLDAP     = "ldap"
	StartTLSPostgres = "postgres"
	// startTLSAuto (or the option set to true) picks the protocol from the endpoint's well-known port.
	startTLSAuto = "auto"
)

// Well-known plaintext ports of the services above (IANA service names smtp, submission, imap, pop3,
// ldap, postgresql).
const (
	portSMTP       = 25
	portSubmission = 587
	portIMAP       = 143
	portPOP3       = 110
	portLDAP       = 389
	portPostgres   = 5432
)

var startTLSByPort = map[int]string{portSMTP: StartTLSSMTP, portSubmission: StartTLSSMTP, portIMAP: StartTLSIMAP, portPOP3: StartTLSPOP3, portLDAP: StartTLSLDAP, portPostgres: StartTLSPostgres}

const (
	// smtpClientName is the EHLO argument; a fixed name keeps the dialogue identical on every node.
	smtpClientName = "openmap-discovery"
	smtpReady      = 220 // RFC 5321 service ready (greeting and STARTTLS go-ahead)
	smtpOK         = 250 // RFC 5321 requested action completed (EHLO)
	smtpReplyCode  = 3   // three-digit reply code before the separator
	smtpMoreLines  = '-' // "250-..." continues a multi-line reply
	imapTag        = "om1"
	imapOK         = "OK"
	pop3OK         = "+OK"
	crlf           = "\r\n"
	// maxDialogueLine and maxDialogueLines bound what a misbehaving server can make the probe read.
	maxDialogueLine  = 4096
	maxDialogueLines = 64

	// RFC 4511 §4.14 StartTLS extended operation.
	ldapStartTLSOID       = "1.3.6.1.4.1.1466.20037"
	ldapMessageID         = 1
	berSequence           = 0x30
	berInteger            = 0x02
	berEnumerated         = 0x0a
	ldapExtendedRequest   = 0x77 // [APPLICATION 23] constructed
	ldapExtendedResponse  = 0x78 // [APPLICATION 24] constructed
	ldapRequestName       = 0x80 // [0] primitive: requestName
	ldapResultSuccess     = 0
	berLongFormFlag       = 0x80
	berLongFormMaxOctets  = 4
	maxLDAPResponseOctets = 1 << 16

	// PostgreSQL SSLRequest: int32 length 8, int32 code 80877103; the server answers one byte.
	pgSSLRequestLength     = 8
	pgSSLRequestCode       = 80877103
	pgSSLRequestCodeOffset = 4
	pgSSLAccept            = 'S'
	pgSSLRefuse            = 'N'
)

var errStartTLSRefused = errors.New("starttls refused")

// StartTLSProtocol resolves the startTls option for one port: a protocol name, "auto" or true to use
// the well-known port, empty or false for direct TLS. Unknown names are an error, not a silent fallback.
func StartTLSProtocol(option any, port int) (string, error) {
	var name string
	switch v := option.(type) {
	case nil:
		return "", nil
	case bool:
		if !v {
			return "", nil
		}
		name = startTLSAuto
	case string:
		name = strings.ToLower(strings.TrimSpace(v))
	default:
		return "", fmt.Errorf("startTls: unsupported value %v", option)
	}
	switch name {
	case "":
		return "", nil
	case startTLSAuto:
		if p, ok := startTLSByPort[port]; ok {
			return p, nil
		}
		return "", fmt.Errorf("startTls auto: no StartTLS protocol is registered for port %d", port)
	case StartTLSSMTP, StartTLSIMAP, StartTLSPOP3, StartTLSLDAP, StartTLSPostgres:
		return name, nil
	}
	return "", fmt.Errorf("startTls: unknown protocol %q", name)
}

// negotiateStartTLS runs the plaintext part of the protocol on conn and returns once the server has
// agreed to start TLS; the caller performs the handshake on the same connection.
func negotiateStartTLS(conn net.Conn, protocol string) error {
	r := bufio.NewReaderSize(conn, maxDialogueLine)
	var err error
	switch protocol {
	case StartTLSSMTP:
		err = smtpStartTLS(conn, r)
	case StartTLSIMAP:
		err = imapStartTLS(conn, r)
	case StartTLSPOP3:
		err = pop3StartTLS(conn, r)
	case StartTLSLDAP:
		err = ldapStartTLS(conn, r)
	case StartTLSPostgres:
		err = postgresSSLRequest(conn, r)
	default:
		err = fmt.Errorf("startTls: unknown protocol %q", protocol)
	}
	if err == nil && r.Buffered() > 0 {
		// Bytes after the go-ahead would be lost to the handshake (and are a STARTTLS injection sign).
		err = fmt.Errorf("%s: %d plaintext bytes after the StartTLS go-ahead", protocol, r.Buffered())
	}
	return err
}

func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadSlice('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(line), crlf), nil
}

// smtpReply reads one (possibly multi-line) reply and returns its code and text lines.
func smtpReply(r *bufio.Reader) (int, []string, error) {
	var lines []string
	for i := 0; i < maxDialogueLines; i++ {
		line, err := readLine(r)
		if err != nil {
			return 0, lines, err
		}
		if len(line) < smtpReplyCode {
			return 0, lines, fmt.Errorf("smtp: malformed reply %q", line)
		}
		code, err := strconv.Atoi(line[:smtpReplyCode])
		if err != nil {
			return 0, lines, fmt.Errorf("smtp: malformed reply %q", line)
		}
		lines = append(lines, strings.TrimSpace(line[smtpReplyCode:]))
		if len(line) == smtpReplyCode || line[smtpReplyCode] != smtpMoreLines {
			return code, lines, nil
		}
	}
	return 0, lines, errors.New("smtp: reply too long")
}

func smtpStartTLS(w io.Writer, r *bufio.Reader) error {
	if code, _, err := smtpReply(r); err != nil || code != smtpReady {
		return fmt.Errorf("smtp greeting: code %d: %w", code, errOr(err))
	}
	if _, err := io.WriteString(w, "EHLO "+smtpClientName+crlf); err != nil {
		return err
	}
	code, caps, err := smtpReply(r)
	if err != nil || code != smtpOK {
		return fmt.Errorf("smtp EHLO: code %d: %w", code, errOr(err))
	}
	offered := false
	for _, c := range caps {
		if strings.EqualFold(strings.TrimLeft(c, "-"), "STARTTLS") {
			offered = true
		}
	}
	if !offered {
		return fmt.Errorf("smtp: STARTTLS not advertised: %w", errStartTLSRefused)
	}
	if _, err := io.WriteString(w, "STARTTLS"+crlf); err != nil {
		return err
	}
	if code, _, err := smtpReply(r); err != nil || code != smtpReady {
		return fmt.Errorf("smtp STARTTLS: code %d: %w", code, errOr(err))
	}
	return nil
}

func imapStartTLS(w io.Writer, r *bufio.Reader) error {
	greeting, err := readLine(r)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(greeting, "* "+imapOK) {
		return fmt.Errorf("imap greeting %q: %w", greeting, errStartTLSRefused)
	}
	if _, err := io.WriteString(w, imapTag+" STARTTLS"+crlf); err != nil {
		return err
	}
	for i := 0; i < maxDialogueLines; i++ {
		line, err := readLine(r)
		if err != nil {
			return err
		}
		if strings.HasPrefix(line, imapTag+" ") {
			if strings.HasPrefix(line, imapTag+" "+imapOK) {
				return nil
			}
			return fmt.Errorf("imap STARTTLS %q: %w", line, errStartTLSRefused)
		}
	}
	return errors.New("imap: no tagged STARTTLS response")
}

func pop3StartTLS(w io.Writer, r *bufio.Reader) error {
	greeting, err := readLine(r)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(greeting, pop3OK) {
		return fmt.Errorf("pop3 greeting %q: %w", greeting, errStartTLSRefused)
	}
	if _, err := io.WriteString(w, "STLS"+crlf); err != nil {
		return err
	}
	line, err := readLine(r)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(line, pop3OK) {
		return fmt.Errorf("pop3 STLS %q: %w", line, errStartTLSRefused)
	}
	return nil
}

// berTLV encodes one definite-length BER element (short form; every element here is under 128 octets).
func berTLV(tag byte, content []byte) []byte {
	return append([]byte{tag, byte(len(content))}, content...)
}

// ldapStartTLSRequest is LDAPMessage{ messageID 1, extendedReq{ requestName 1.3.6.1.4.1.1466.20037 } }.
func ldapStartTLSRequest() []byte {
	op := berTLV(ldapExtendedRequest, berTLV(ldapRequestName, []byte(ldapStartTLSOID)))
	return berTLV(berSequence, append(berTLV(berInteger, []byte{ldapMessageID}), op...))
}

// readBER reads one BER element and returns its tag and content.
func readBER(r io.Reader) (byte, []byte, error) {
	head := make([]byte, 2)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, nil, err
	}
	length := int(head[1])
	if head[1]&berLongFormFlag != 0 {
		n := int(head[1] &^ berLongFormFlag)
		if n == 0 || n > berLongFormMaxOctets {
			return 0, nil, fmt.Errorf("ldap: unsupported BER length form %#x", head[1])
		}
		octets := make([]byte, n)
		if _, err := io.ReadFull(r, octets); err != nil {
			return 0, nil, err
		}
		length = 0
		for _, b := range octets {
			length = length<<8 | int(b)
		}
	}
	if length > maxLDAPResponseOctets {
		return 0, nil, fmt.Errorf("ldap: response of %d octets exceeds the limit", length)
	}
	content := make([]byte, length)
	if _, err := io.ReadFull(r, content); err != nil {
		return 0, nil, err
	}
	return head[0], content, nil
}

func ldapStartTLS(w io.Writer, r *bufio.Reader) error {
	if _, err := w.Write(ldapStartTLSRequest()); err != nil {
		return err
	}
	tag, msg, err := readBER(r)
	if err != nil {
		return err
	}
	if tag != berSequence {
		return fmt.Errorf("ldap: response tag %#x is not an LDAPMessage", tag)
	}
	inner := strings.NewReader(string(msg))
	idTag, id, err := readBER(inner)
	if err != nil || idTag != berInteger || len(id) != 1 || id[0] != ldapMessageID {
		return fmt.Errorf("ldap: unexpected message id %v (%#x): %w", id, idTag, errOr(err))
	}
	opTag, op, err := readBER(inner)
	if err != nil || opTag != ldapExtendedResponse {
		return fmt.Errorf("ldap: unexpected operation %#x: %w", opTag, errOr(err))
	}
	rcTag, rc, err := readBER(strings.NewReader(string(op)))
	if err != nil || rcTag != berEnumerated || len(rc) != 1 {
		return fmt.Errorf("ldap: malformed extended response: %w", errOr(err))
	}
	if rc[0] != ldapResultSuccess {
		return fmt.Errorf("ldap StartTLS result code %d: %w", rc[0], errStartTLSRefused)
	}
	return nil
}

func postgresSSLRequest(w io.Writer, r *bufio.Reader) error {
	req := make([]byte, pgSSLRequestLength)
	binary.BigEndian.PutUint32(req[0:], pgSSLRequestLength)
	binary.BigEndian.PutUint32(req[pgSSLRequestCodeOffset:], pgSSLRequestCode)
	if _, err := w.Write(req); err != nil {
		return err
	}
	answer, err := r.ReadByte()
	if err != nil {
		return err
	}
	switch answer {
	case pgSSLAccept:
		return nil
	case pgSSLRefuse:
		return fmt.Errorf("postgres: server does not accept SSL: %w", errStartTLSRefused)
	}
	return fmt.Errorf("postgres: unexpected SSLRequest answer %q", answer)
}

func errOr(err error) error {
	if err != nil {
		return err
	}
	return errStartTLSRefused
}

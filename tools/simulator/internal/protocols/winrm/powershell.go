// REQ-QA-005 — what simulated Windows hosts print: Windows PowerShell 5.1 ConvertTo-Json output (DateTime as
// \/Date(ms)\/, enums as integers, CRLF line endings), NetBIOS computer names and seeded values for the parts of a
// host the synthetic estate does not describe.
package winrm

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

const (
	// netbiosLen is the longest NetBIOS computer name (Win32_ComputerSystem.Name truncates the DNS host name).
	netbiosLen = 15
	crlf       = "\r\n"
)

// Date is a DateTime as Windows PowerShell 5.1 ConvertTo-Json writes it.
type Date time.Time

func (d Date) MarshalJSON() ([]byte, error) {
	ms := time.Time(d).UnixMilli()
	return []byte(`"\/Date(` + strconv.FormatInt(ms, 10) + `)\/"`), nil
}

// JSON renders v like `ConvertTo-Json -Compress` and ends the line as Windows does.
func JSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b) + crlf
}

// Lines joins output lines with CRLF.
func Lines(lines ...string) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(strings.TrimRight(l, crlf))
		b.WriteString(crlf)
	}
	return b.String()
}

// NetBIOS is the computer name Windows reports for a DNS host name.
func NetBIOS(hostname string) string {
	n := strings.ToUpper(strings.SplitN(hostname, ".", 2)[0])
	if len(n) > netbiosLen {
		n = n[:netbiosLen]
	}
	return n
}

// Seed is a stable pseudo-random number for the parts of a host the estate does not carry.
func Seed(parts ...string) uint64 {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return binary.BigEndian.Uint64(sum[:8])
}

// Pick returns a stable value in [lo, hi] for the given parts.
func Pick(lo, hi int, parts ...string) int {
	if hi <= lo {
		return lo
	}
	return lo + int(Seed(parts...)%uint64(hi-lo+1))
}

// GUID is a stable upper-case GUID for the given parts.
func GUID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	h := strings.ToUpper(hex.EncodeToString(sum[:16]))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

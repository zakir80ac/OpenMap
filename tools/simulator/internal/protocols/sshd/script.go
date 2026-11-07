// REQ-QA-005 — helpers for simulated hosts that answer the collectors' delimited shell scripts: unwrapping the
// `sh -c '<script>'` exec request, finding the @@OPENMAP:<key>@@ sections a script asks for (in script order, with
// the shell text that follows each marker), and framing each section's output exactly as `printf '\n<marker>\n'`
// followed by the command's own output prints it. Also the run plumbing every SSH simulator shares: credentials
// and the port / pinned host-key options.
package sshd

import (
	"regexp"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	shellPrefix  = "sh -c "
	markerOpen   = "@@OPENMAP:"
	markerClose  = "@@"
	templateVerb = "%s"
)

var markerPattern = regexp.MustCompile(regexp.QuoteMeta(markerOpen) + `([^@\s'"]+)` + regexp.QuoteMeta(markerClose))

// UnwrapShell returns the script of an `sh -c <word>` request, undoing POSIX single quotes and backslash escapes.
func UnwrapShell(command string) (string, bool) {
	if !strings.HasPrefix(command, shellPrefix) {
		return "", false
	}
	rest := command[len(shellPrefix):]
	var b strings.Builder
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		switch {
		case c == '\'':
			end := strings.IndexByte(rest[i+1:], '\'')
			if end < 0 {
				return "", false
			}
			b.WriteString(rest[i+1 : i+1+end])
			i += end + 1
		case c == '\\' && i+1 < len(rest):
			b.WriteByte(rest[i+1])
			i++
		case c == ' ' || c == '\t' || c == '\n':
			return b.String(), true
		default:
			b.WriteByte(c)
		}
	}
	return b.String(), true
}

// Section is one delimited part of a script.
type Section struct {
	// Key is the marker key; a key containing %s is printed once per item of a shell loop.
	Key string
	// Command is the shell text between this marker and the next.
	Command string
}

// Templated reports whether the section is printed inside a loop (its key carries a printf verb).
func (s Section) Templated() bool { return strings.Contains(s.Key, templateVerb) }

// Expand substitutes a loop item into a templated key.
func (s Section) Expand(item string) string { return strings.Replace(s.Key, templateVerb, item, 1) }

// Sections lists the markers a script prints, in script order.
func Sections(script string) []Section {
	locs := markerPattern.FindAllStringSubmatchIndex(script, -1)
	out := make([]Section, 0, len(locs))
	for i, loc := range locs {
		end := len(script)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		out = append(out, Section{Key: script[loc[2]:loc[3]], Command: script[loc[1]:end]})
	}
	return out
}

// Frame is the output of one section: the marker line printed with a leading newline, then the command output.
func Frame(key, body string) string {
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	return "\n" + markerOpen + key + markerClose + "\n" + body
}

// Shell answers `sh -c` scripts with render and anything else with the shell's "not found" reply.
func Shell(render func(script string) string) Handler {
	return func(r Request) Reply {
		script, ok := UnwrapShell(r.Command)
		if !ok {
			return NotFound(r.Command)
		}
		return Reply{Stdout: render(script)}
	}
}

// NotFound is what a POSIX login shell answers for a command it does not have.
func NotFound(command string) Reply {
	name := strings.Fields(command)
	word := command
	if len(name) > 0 {
		word = name[0]
	}
	return Reply{Stderr: "sh: 1: " + word + ": not found\n", Status: exitNotFound}
}

const exitNotFound = 127

// PasswordCredential is the simulated password credential.
func PasswordCredential(env *sim.Env) *sim.Credential {
	return &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}}
}

// KeyCredential is an ssh_key credential carrying privatePEM for the simulated user.
func KeyCredential(env *sim.Env, privatePEM string) *sim.Credential {
	return &sim.Credential{Type: "ssh_key", Fields: map[string]string{"username": env.User, "privateKey": privatePEM}}
}

// Target is the collector target for a server.
func (s *Server) Target(label string) sim.Target {
	return sim.Target{Kind: "host", Value: s.Host, Label: label}
}

// Options are the job options that point a collector at the server with its host key pinned.
func (s *Server) Options() map[string]any {
	return map[string]any{"port": s.Port, "hostKeyFingerprints": map[string]any{s.Host: s.Fingerprint}}
}

// REQ-DISC-004 REQ-DISC-031 — optional environment file for installed binaries: a service manager (systemd,
// launchd, the Windows Service Control Manager) cannot always pass variables, so the Node and the agent read
// KEY=value lines from a file at start and apply them to the process environment unless the variable is already
// set. The format is the one systemd's EnvironmentFile= accepts: one assignment per line, `#` comments, optional
// single or double quotes around the value.
package agent

import (
	"bufio"
	"os"
	"strings"
)

// ParseEnvFile returns the assignments in text; malformed lines are skipped rather than failing the start.
func ParseEnvFile(text string) map[string]string {
	out := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" || strings.ContainsAny(key, " \t") {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		out[key] = value
	}
	return out
}

// LoadEnvFile applies the file's assignments to the process environment without overriding variables already set.
// A missing file is not an error: the installer writes it, but the environment alone is always enough.
func LoadEnvFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for key, value := range ParseEnvFile(string(data)) {
		if _, set := os.LookupEnv(key); !set {
			if err := os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	return nil
}

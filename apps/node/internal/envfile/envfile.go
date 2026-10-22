// REQ-DISC-031 — optional environment file for the installed Node (systemd EnvironmentFile= format): KEY=value
// lines, `#` comments, optional quotes; applied at start unless the variable is already set, so a service manager
// that cannot pass variables still configures the Node, and an explicit environment always wins.
package envfile

import (
	"bufio"
	"os"
	"strings"
)

// Parse returns the assignments in text; malformed lines are skipped rather than failing the start.
func Parse(text string) map[string]string {
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

// Load applies the file's assignments without overriding variables already set; a missing file is not an error.
func Load(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for key, value := range Parse(string(data)) {
		if _, set := os.LookupEnv(key); !set {
			if err := os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	return nil
}

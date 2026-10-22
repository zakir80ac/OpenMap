// REQ-DISC-024 — Redis / Valkey probe: INFO sections for version, run id, replication role and
// peers, clients and memory, and per-keyspace key counts as databases.
package database

import (
	"context"
	"crypto/tls"
	"net"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

type redisProber struct{}

func (redisProber) Probe(ctx context.Context, host string, port int, user, password string, useTLS bool, _ string) (*Inventory, error) {
	opts := &redis.Options{Addr: net.JoinHostPort(host, strconv.Itoa(port)), Username: user, Password: password, DialTimeout: connectTimeout, ReadTimeout: connectTimeout, ClientName: "openmap-discovery"}
	if useTLS {
		opts.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host}
	}
	client := redis.NewClient(opts)
	defer client.Close()
	text, err := client.Info(ctx).Result()
	if err != nil {
		return nil, err
	}
	info := ParseRedisInfo(text)
	inv := &Inventory{Engine: EngineRedis, Settings: map[string]any{}, Raw: []byte(text)}
	inv.Version = firstNonEmpty(info["valkey_version"], info["redis_version"])
	inv.Edition = firstNonEmpty(info["server_name"], "redis")
	inv.ClusterID = firstNonEmpty(info["run_id"], host+":"+strconv.Itoa(port))
	inv.ClusterName = inv.Edition + " @ " + host
	inv.UptimeSeconds, _ = strconv.ParseInt(info["uptime_in_seconds"], 10, 64)
	inv.Connections, _ = strconv.Atoi(info["connected_clients"])
	inv.MaxConn, _ = strconv.Atoi(info["maxclients"])
	switch info["role"] {
	case "master":
		inv.Role = "primary"
	case "slave", "replica":
		inv.Role = "replica"
		inv.ReplicationOf = info["master_host"] + ":" + info["master_port"]
	default:
		inv.Role = "standalone"
	}
	if n, err := strconv.Atoi(info["connected_slaves"]); err == nil {
		for i := 0; i < n; i++ {
			// slave0:ip=10.0.0.2,port=6379,state=online,...
			line := info["slave"+strconv.Itoa(i)]
			var ip, p string
			for _, kv := range strings.Split(line, ",") {
				k, v, _ := strings.Cut(kv, "=")
				switch k {
				case "ip":
					ip = v
				case "port":
					p = v
				}
			}
			if ip != "" {
				inv.Replicas = append(inv.Replicas, net.JoinHostPort(ip, p))
			}
		}
	}
	inv.Settings["clusterEnabled"] = info["cluster_enabled"] == "1"
	inv.Settings["usedMemoryBytes"], _ = strconv.ParseInt(info["used_memory"], 10, 64)
	inv.Settings["maxMemoryBytes"], _ = strconv.ParseInt(info["maxmemory"], 10, 64)
	inv.Settings["persistence"] = map[string]any{"rdbLastSaveTime": info["rdb_last_save_time"], "aofEnabled": info["aof_enabled"] == "1"}
	for k, v := range info {
		if !strings.HasPrefix(k, "db") || len(k) > len("db")+3 {
			continue
		}
		if _, err := strconv.Atoi(k[len("db"):]); err != nil {
			continue
		}
		var keys int64
		for _, kv := range strings.Split(v, ",") {
			if key, val, ok := strings.Cut(kv, "="); ok && key == "keys" {
				keys, _ = strconv.ParseInt(val, 10, 64)
			}
		}
		inv.Databases = append(inv.Databases, Database{Name: k, State: "online", Extra: map[string]any{"keys": keys, "keyspace": v}})
	}
	return inv, nil
}

// ParseRedisInfo turns INFO text into a flat key/value map.
func ParseRedisInfo(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, ":"); ok {
			out[k] = v
		}
	}
	return out
}

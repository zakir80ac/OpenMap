// REQ-DISC-024 — database discovery collector: connects to PostgreSQL, MySQL/MariaDB, SQL Server,
// MongoDB, Redis/Valkey and Oracle Database with a read-only account and emits the database cluster (engine, cluster
// identity, version, role, replication), every database with its size, the listening service and
// the host it runs on. Engine is taken from the job or inferred from the port.
package database

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID  = "database"
	version      = "0.1.0"
	evidenceKind = "api_response"
	optionEngine = "engine" // postgresql | mysql | mssql | mongodb | redis | oracle
	optionPort   = "port"
	optionTLS    = "tls"
	optionDbName = "database" // initial database for engines that need one
	credUser     = "username"
	credPassword = "password"
	defaultVrf   = "default"

	EnginePostgres = "postgresql"
	EngineMySQL    = "mysql"
	EngineMSSQL    = "mssql"
	EngineMongo    = "mongodb"
	EngineRedis    = "redis"
	EngineOracle   = "oracle"

	portPostgres = 5432
	portMySQL    = 3306
	portMSSQL    = 1433
	portMongo    = 27017
	portRedis    = 6379
	portOracle   = 1521

	connectTimeout = 15 * time.Second

	typeCluster  = "database_cluster"
	typeDatabase = "database"
	typeListener = "listening_service"
	typeHost     = "host"
	typeIP       = "ip_address"
	relContains  = "contains"
	relHostedOn  = "hosted_on"
	relRunsOn    = "runs_on"
	relReplicate = "replicates_to"
)

var defaultPorts = map[string]int{EnginePostgres: portPostgres, EngineMySQL: portMySQL, EngineMSSQL: portMSSQL, EngineMongo: portMongo, EngineRedis: portRedis, EngineOracle: portOracle}
var enginesByPort = map[int]string{portPostgres: EnginePostgres, portMySQL: EngineMySQL, portMSSQL: EngineMSSQL, portMongo: EngineMongo, portRedis: EngineRedis, portOracle: EngineOracle}

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "database", Version: version, Language: "go",
		Protocols: []string{"postgresql", "mysql", "tds", "mongodb", "resp", "tns"}, CredentialTypes: []string{"password", "none"},
		TargetKinds: []string{"host"}, Emits: []string{typeCluster, typeDatabase, typeListener, typeIP},
		ContractVersion: contract.Version,
	}
}

// Database is one logical database (or Redis keyspace) on the instance.
type Database struct {
	Name      string
	SizeBytes int64
	Owner     string
	Encoding  string
	State     string
	Extra     map[string]any
}

// Inventory is the engine-neutral view every probe fills.
type Inventory struct {
	Engine        string
	Version       string
	Edition       string
	ClusterID     string // engine-specific stable identity (system identifier, server_uuid, AG id, replica set, run_id)
	ClusterName   string
	Role          string // primary | replica | standalone
	ReplicationOf string // upstream address when a replica
	Replicas      []string
	UptimeSeconds int64
	Connections   int
	MaxConn       int
	Databases     []Database
	Settings      map[string]any
	Raw           []byte
}

// Prober is one engine's implementation.
type Prober interface {
	Probe(ctx context.Context, host string, port int, user, password string, tls bool, dbName string) (*Inventory, error)
}

var probers = map[string]Prober{
	EnginePostgres: postgresProber{},
	EngineMySQL:    mysqlProber{},
	EngineMSSQL:    mssqlProber{},
	EngineMongo:    mongoProber{},
	EngineRedis:    redisProber{},
	EngineOracle:   oracleProber{},
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, port int, at time.Time) collector.Observation {
	obs := collector.Observation{}
	if inv.Raw != nil {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: inv.Raw})
	}
	hostRef := strings.ToLower(target.Value)
	clusterID := firstNonEmpty(inv.ClusterID, hostRef+":"+strconv.Itoa(port))
	clusterIdentity := map[string]string{"engine": inv.Engine, "clusterId": clusterID}
	clusterRef := contract.CiRef{Type: typeCluster, Identity: clusterIdentity}
	var totalBytes int64
	for _, d := range inv.Databases {
		totalBytes += d.SizeBytes
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeCluster, Identity: clusterIdentity, Name: firstNonEmpty(inv.ClusterName, inv.Engine+" @ "+hostRef),
		Attributes: map[string]any{"engine": inv.Engine, "version": inv.Version, "edition": inv.Edition, "role": inv.Role, "replicationOf": inv.ReplicationOf, "replicas": inv.Replicas, "uptimeSeconds": inv.UptimeSeconds, "connections": inv.Connections, "maxConnections": inv.MaxConn, "databaseCount": len(inv.Databases), "totalSizeBytes": totalBytes, "host": hostRef, "port": port, "settings": inv.Settings},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: inv.Engine, ID: clusterID}}, ObservedAt: at})
	hostIdentity := map[string]string{"fqdn": hostRef}
	if ip := net.ParseIP(target.Value); ip != nil {
		hostIdentity = map[string]string{"fqdn": hostRef}
	}
	obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: clusterRef, To: contract.CiRef{Type: typeHost, Identity: hostIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	lsIdentity := map[string]string{"hostRef": hostRef, "protocol": "tcp", "port": strconv.Itoa(port)}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: lsIdentity, Name: "tcp/" + strconv.Itoa(port) + " " + inv.Engine,
		Attributes: map[string]any{"protocol": "tcp", "port": port, "service": inv.Engine, "product": inv.Engine, "version": inv.Version, "source": collectorID},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: clusterRef, To: contract.CiRef{Type: typeListener, Identity: lsIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	for _, d := range inv.Databases {
		identity := map[string]string{"hostRef": hostRef, "engine": inv.Engine, "name": d.Name, "port": strconv.Itoa(port)}
		attrs := map[string]any{"engine": inv.Engine, "sizeBytes": d.SizeBytes, "owner": d.Owner, "encoding": d.Encoding, "state": d.State, "cluster": clusterID}
		for k, v := range d.Extra {
			attrs[k] = v
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeDatabase, Identity: identity, Name: d.Name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: clusterRef, To: contract.CiRef{Type: typeDatabase, Identity: identity}, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, r := range inv.Replicas {
		addr, _, _ := net.SplitHostPort(r)
		if addr == "" {
			addr = r
		}
		if net.ParseIP(addr) == nil {
			continue
		}
		ipIdentity := map[string]string{"address": addr, "vrfRef": defaultVrf}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"role": "database-replica", "cluster": clusterID, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relReplicate, From: clusterRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	}
	return obs
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func marshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func classify(target string, err error) error {
	var te *collector.TargetError
	if asTargetError(err, &te) {
		return err
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "password authentication failed") || strings.Contains(msg, "access denied") || strings.Contains(msg, "login failed") || strings.Contains(msg, "authentication failed") || strings.Contains(msg, "noauth") || strings.Contains(msg, "wrongpass") || strings.Contains(msg, "logon denied"):
		return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential: %v", target, err)
	case strings.Contains(msg, "permission denied") || strings.Contains(msg, "not authorized"):
		return collector.Errorf(contract.ErrPermissionDenied, false, "%s: %v", target, err)
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
		return collector.Errorf(contract.ErrTimeout, true, "%s timed out", target)
	default:
		return collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target, err)
	}
}

func asTargetError(err error, out **collector.TargetError) bool {
	for e := err; e != nil; {
		if te, ok := e.(*collector.TargetError); ok {
			*out = te
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	engine, _ := options[optionEngine].(string)
	engine = strings.ToLower(engine)
	port := 0
	if p, ok := options[optionPort]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(p)); err == nil && n > 0 {
			port = n
		}
	}
	if engine == "" && port > 0 {
		engine = enginesByPort[port]
	}
	if engine == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "database job must name engine (postgresql|mysql|mssql|mongodb|redis|oracle) or a well-known port")
	}
	prober, ok := probers[engine]
	if !ok {
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "engine %q is not supported", engine)
	}
	if port == 0 {
		port = defaultPorts[engine]
	}
	user, password := "", ""
	if cred != nil {
		user, password = cred.Fields[credUser], cred.Fields[credPassword]
	}
	useTLS, _ := options[optionTLS].(bool)
	dbName, _ := options[optionDbName].(string)
	probeCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	inv, err := prober.Probe(probeCtx, target.Value, port, user, password, useTLS, dbName)
	if err != nil {
		return collector.Observation{}, classify(target.Value, err)
	}
	inv.Engine = engine
	return Emit(inv, target, port, time.Now().UTC()), nil
}

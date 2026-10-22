-- REQ-CORE-009 — initial Postgres schema. Generated from prisma/schema.prisma with
-- `pnpm --filter @openmap/db prisma:diff`; regenerate rather than hand-edit.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('en', 'ar');

-- CreateEnum
CREATE TYPE "CiLayer" AS ENUM ('dc', 'network_security', 'hardware', 'storage', 'virtualization', 'cloud', 'os', 'containers', 'databases', 'applications', 'saas', 'unknown');

-- CreateEnum
CREATE TYPE "CiType" AS ENUM ('host', 'chassis', 'blade', 'bmc', 'hypervisor', 'vm_cluster', 'vm', 'operating_system', 'container', 'k8s_cluster', 'k8s_namespace', 'k8s_workload', 'k8s_service', 'container_registry', 'network_device', 'interface', 'port', 'vlan', 'vrf', 'ip_address', 'subnet', 'dns_zone', 'dns_record', 'dhcp_scope', 'dhcp_lease', 'load_balancer', 'firewall_rule', 'site_link', 'storage_array', 'lun', 'fc_switch', 'fc_fabric', 'fc_zone', 'nas_share', 'object_bucket', 'database', 'database_cluster', 'certificate', 'application', 'application_component', 'listening_service', 'business_service', 'software', 'software_instance', 'licence', 'vulnerability', 'site', 'building', 'room', 'row', 'rack', 'pdu', 'power_feed', 'power_circuit', 'ups', 'cooling_unit', 'cable', 'patch_panel', 'cloud_account', 'cloud_resource', 'saas_application', 'saas_tenant', 'user_account', 'service_account', 'vendor', 'contract', 'cost_centre', 'unknown');

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('depends_on', 'runs_on', 'hosted_on', 'contains', 'member_of', 'connected_to', 'cabled_to', 'located_in', 'powered_by', 'cooled_by', 'uses_ip', 'in_subnet', 'in_vlan', 'resolves_to', 'leased_to', 'installed_on', 'licensed_by', 'affected_by', 'part_of_service', 'communicates_with', 'mounted_on', 'backed_by', 'owns', 'manages', 'billed_to', 'secured_by', 'covered_by', 'supported_by', 'assigned_to', 'spare_for', 'zoned_with', 'presented_to', 'replicates_to');

-- CreateEnum
CREATE TYPE "Lifecycle" AS ENUM ('discovered', 'managed', 'planned', 'retired');

-- CreateEnum
CREATE TYPE "SiteKind" AS ENUM ('datacenter', 'colocation', 'office', 'branch', 'cloud_region', 'edge');

-- CreateEnum
CREATE TYPE "LinkKind" AS ENUM ('dark_fibre', 'dwdm', 'mpls', 'sd_wan', 'dia', 'expressroute', 'direct_connect', 'cloud_interconnect', 'vpn', 'point_to_point', 'cellular');

-- CreateEnum
CREATE TYPE "LinkRole" AS ENUM ('primary', 'backup', 'overlay');

-- CreateEnum
CREATE TYPE "CloudProvider" AS ENUM ('azure', 'aws', 'gcp', 'oci', 'other');

-- CreateEnum
CREATE TYPE "NodeEnrolmentStatus" AS ENUM ('pending', 'enrolled', 'cloud_managed', 'agent_only');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('organization', 'sites', 'connectivity', 'nodes_credentials', 'integrations', 'generate');

-- CreateEnum
CREATE TYPE "CollectorFamily" AS ENUM ('snmp', 'ssh_cli', 'wmi', 'winrm', 'ssh_agentless', 'vmware', 'hyperv', 'kvm_libvirt', 'nutanix_ahv', 'oracle_vm', 'kubernetes', 'cloud_aws', 'cloud_azure', 'cloud_gcp', 'netflow', 'port_scan', 'ipmi_redfish', 'fc_fabric', 'nas', 'object_storage', 'dns', 'dhcp', 'ldap', 'database', 'storage', 'pdu', 'agent', 'load_balancer', 'certificate', 'vulnerability_feed', 'saas', 'os_patch');

-- CreateEnum
CREATE TYPE "CollectorLanguage" AS ENUM ('go', 'python');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('none', 'snmp_v2c', 'snmp_v3', 'password', 'ssh_key', 'api_token', 'oauth_client', 'certificate', 'kubeconfig', 'cloud_role');

-- CreateEnum
CREATE TYPE "TargetKind" AS ENUM ('host', 'cidr', 'url', 'cluster', 'account', 'zone', 'flow_source');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('snmp_walk', 'cli_output', 'api_response', 'flow_sample', 'scan_output', 'agent_report');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('success', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('scheduled', 'started', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "OutboxTarget" AS ENUM ('memgraph', 'clickhouse', 'meilisearch', 'websocket', 'bsm');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "AssetStage" AS ENUM ('planned', 'in_stock', 'deployed', 'spare', 'rma', 'retired', 'disposed');

-- CreateEnum
CREATE TYPE "SupportLevel" AS ENUM ('none', 'basic', 'next_business_day', 'four_hour', 'mission_critical', 'custom');

-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('straight_line', 'declining_balance', 'none');

-- CreateEnum
CREATE TYPE "PlanKind" AS ENUM ('new_infrastructure', 'stack_expansion', 'refresh', 'migration', 'decommission');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('draft', 'approved', 'building', 'live', 'cancelled');

-- CreateEnum
CREATE TYPE "ScenarioKind" AS ENUM ('component', 'power', 'rack', 'site', 'network', 'storage', 'cloud_region', 'shared_service', 'maintenance');

-- CreateEnum
CREATE TYPE "IntegrationCategory" AS ENUM ('itsm', 'siem', 'soar', 'monitoring', 'notification', 'automation', 'warranty', 'identity', 'finance', 'iac');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('inbound', 'outbound', 'bidirectional');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('out', 'in');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('pending', 'delivered', 'failed', 'retrying', 'dead_letter');

-- CreateEnum
CREATE TYPE "IntegrationHealth" AS ENUM ('healthy', 'warning', 'failing', 'disabled');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('informational', 'low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "IncidentState" AS ENUM ('open', 'acknowledged', 'mitigated', 'resolved', 'closed');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "defaultLocale" "Locale" NOT NULL,
    "regulatoryScope" TEXT[],
    "airGapped" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenantId" UUID NOT NULL,
    "locale" "Locale" NOT NULL,
    "timeZone" TEXT NOT NULL,
    "discoveryIntervalMinutes" INTEGER NOT NULL,
    "historyRetentionDays" INTEGER NOT NULL,
    "staleAfterDays" INTEGER NOT NULL,
    "assistantEnabled" BOOLEAN NOT NULL,
    "outboundIntegrationsEnabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "business_units" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "costCentreCiId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SiteKind" NOT NULL,
    "tier" INTEGER,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "geoLat" DOUBLE PRECISION,
    "geoLon" DOUBLE PRECISION,
    "cloudProvider" "CloudProvider",
    "cloudRegion" TEXT,
    "locationCount" INTEGER NOT NULL DEFAULT 1,
    "ciId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_links" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "fromSiteId" UUID NOT NULL,
    "toSiteId" UUID NOT NULL,
    "kind" "LinkKind" NOT NULL,
    "provider" TEXT,
    "circuitId" TEXT,
    "bandwidthMbps" INTEGER NOT NULL,
    "diversePaths" INTEGER NOT NULL,
    "role" "LinkRole" NOT NULL,
    "latencyMs" DOUBLE PRECISION,
    "ciId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "site_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_states" (
    "organizationId" UUID NOT NULL,
    "step" "OnboardingStep" NOT NULL,
    "completedSteps" "OnboardingStep"[],
    "credentialRefs" TEXT[],
    "integrationIds" UUID[],
    "seedImports" JSONB NOT NULL,
    "generatedAt" TIMESTAMPTZ(3),
    "firstSweepId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "onboarding_states_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "cis" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "CiType" NOT NULL,
    "identity" JSONB NOT NULL,
    "identityKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "layer" "CiLayer" NOT NULL,
    "userLabel" JSONB,
    "lifecycle" "Lifecycle" NOT NULL,
    "attributes" JSONB NOT NULL,
    "tags" TEXT[],
    "sourceCollectorId" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceConfidence" DOUBLE PRECISION NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validTo" TIMESTAMPTZ(3),
    "checksum" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ci_external_ids" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ciId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ci_external_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "RelationshipType" NOT NULL,
    "fromCiId" UUID NOT NULL,
    "toCiId" UUID NOT NULL,
    "attributes" JSONB NOT NULL,
    "sourceCollectorId" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "sourceConfidence" DOUBLE PRECISION NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validTo" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_conflicts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ciId" UUID,
    "type" "CiType" NOT NULL,
    "identityKey" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'open',
    "chosenValue" JSONB,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reconciliation_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collector_manifests" (
    "collectorId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "family" "CollectorFamily" NOT NULL,
    "language" "CollectorLanguage" NOT NULL,
    "protocols" TEXT[],
    "credentialTypes" "CredentialType"[],
    "targetKinds" "TargetKind"[],
    "emits" TEXT[],
    "contractVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collector_manifests_pkey" PRIMARY KEY ("collectorId","version")
);

-- CreateTable
CREATE TABLE "discovery_nodes" (
    "id" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "status" "NodeEnrolmentStatus" NOT NULL,
    "enrolTokenDigest" CHAR(64),
    "enrolledAt" TIMESTAMPTZ(3),
    "certificateSerial" TEXT,
    "certificateFingerprint" CHAR(64),
    "certificateExpiresAt" TIMESTAMPTZ(3),
    "version" TEXT,
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "collectorIds" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "discovery_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_jobs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "collectorId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "targets" JSONB NOT NULL,
    "credentialRef" TEXT,
    "credentialType" "CredentialType" NOT NULL,
    "timeoutMs" INTEGER NOT NULL,
    "rateLimitConcurrency" INTEGER NOT NULL,
    "rateLimitRps" DOUBLE PRECISION NOT NULL,
    "options" JSONB NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'scheduled',
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "contractVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "discovery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collector_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "collectorId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL,
    "targetsAttempted" INTEGER NOT NULL,
    "targetsReached" INTEGER NOT NULL,
    "cisEmitted" INTEGER NOT NULL,
    "relationshipsEmitted" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collector_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "targetKind" "TargetKind" NOT NULL,
    "targetValue" TEXT NOT NULL,
    "targetLabel" TEXT,
    "digest" CHAR(64) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "sequence" BIGSERIAL NOT NULL,
    "eventId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "pending" "OutboxTarget"[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "asset_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ciId" UUID,
    "assetTag" TEXT NOT NULL,
    "serialNumber" TEXT,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "partNumber" TEXT,
    "stage" "AssetStage" NOT NULL,
    "stageChangedAt" TIMESTAMPTZ(3) NOT NULL,
    "locationCiId" UUID,
    "custodian" TEXT,
    "ownerCostCentreCiId" UUID,
    "planId" UUID,
    "purchasedAt" DATE,
    "purchaseCostAmount" DECIMAL(18,2),
    "purchaseCostCurrency" CHAR(3),
    "depreciationMethod" "DepreciationMethod" NOT NULL,
    "usefulLifeMonths" INTEGER NOT NULL,
    "residualValueAmount" DECIMAL(18,2) NOT NULL,
    "residualValueCurrency" CHAR(3) NOT NULL,
    "warranty" JSONB,
    "supportContractId" UUID,
    "endOfLife" JSONB,
    "stockOnHand" INTEGER,
    "stockReorderPoint" INTEGER,
    "tags" TEXT[],
    "customFields" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "asset_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_audits" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "field" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infra_plans" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "PlanKind" NOT NULL,
    "status" "PlanStatus" NOT NULL,
    "owner" TEXT NOT NULL,
    "targetSiteCiId" UUID,
    "targetRackCiIds" UUID[],
    "costCentreCiId" UUID,
    "estimatedCostAmount" DECIMAL(18,2),
    "estimatedCostCurrency" CHAR(3),
    "externalRefs" JSONB NOT NULL,
    "plannedLiveAt" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "infra_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "sku" TEXT,
    "layer" "CiLayer" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "unitCostAmount" DECIMAL(18,2),
    "unitCostCurrency" CHAR(3),
    "vendorCiId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bom_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_contracts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "vendorCiId" UUID NOT NULL,
    "contractNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" "SupportLevel" NOT NULL,
    "responseMinutes" INTEGER,
    "startsAt" DATE NOT NULL,
    "endsAt" DATE NOT NULL,
    "autoRenews" BOOLEAN NOT NULL,
    "annualCostAmount" DECIMAL(18,2),
    "annualCostCurrency" CHAR(3),
    "costCentreCiId" UUID,
    "primaryContactId" UUID,
    "externalIds" JSONB NOT NULL,
    "documentRefs" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_contacts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "vendorCiId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "portalUrl" TEXT,
    "availability" TEXT,
    "escalationLevel" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impact_scenarios" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ScenarioKind" NOT NULL,
    "failedCiIds" UUID[],
    "maxDepth" INTEGER NOT NULL,
    "honourRedundancy" BOOLEAN NOT NULL,
    "includeSharedServices" BOOLEAN NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT NOT NULL,
    "changeRefSource" TEXT,
    "changeRefId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "impact_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impact_simulations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scenarioId" UUID NOT NULL,
    "ranAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "failedCiIds" UUID[],
    "affectedApplicationCiIds" UUID[],
    "services" JSONB NOT NULL,
    "servicesDown" INTEGER NOT NULL,
    "servicesDegraded" INTEGER NOT NULL,
    "usersAffected" INTEGER NOT NULL,
    "revenueAtRiskAmount" DECIMAL(18,2),
    "revenueAtRiskCurrency" CHAR(3),
    "recommendations" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_simulations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impact_validations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "simulationId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "predictedServiceCiIds" UUID[],
    "actualServiceCiIds" UUID[],
    "accuracy" DOUBLE PRECISION NOT NULL,
    "missedServiceCiIds" UUID[],
    "validatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "state" "IncidentState" NOT NULL DEFAULT 'open',
    "source" TEXT NOT NULL,
    "affectedServiceCiIds" UUID[],
    "rootCauseCiId" UUID,
    "correlatedEventIds" UUID[],
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_links" (
    "incidentId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "remoteId" TEXT NOT NULL,
    "remoteUrl" TEXT,
    "remoteState" TEXT NOT NULL,
    "syncedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incident_links_pkey" PRIMARY KEY ("incidentId","integrationId")
);

-- CreateTable
CREATE TABLE "integration_configs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "category" "IntegrationCategory" NOT NULL,
    "vendor" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "direction" "Direction" NOT NULL,
    "endpoint" TEXT NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "fieldMappings" JSONB NOT NULL,
    "classMappings" JSONB NOT NULL,
    "subscribedEvents" TEXT[],
    "scheduleCron" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_statuses" (
    "integrationId" UUID NOT NULL,
    "health" "IntegrationHealth" NOT NULL DEFAULT 'disabled',
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastErrorAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "credentialExpiresAt" TIMESTAMPTZ(3),
    "deliveredLastHour" INTEGER NOT NULL DEFAULT 0,
    "failedLastHour" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_statuses_pkey" PRIMARY KEY ("integrationId")
);

-- CreateTable
CREATE TABLE "integration_deliveries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "eventId" UUID,
    "remoteId" TEXT,
    "state" "DeliveryState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestDigest" CHAR(64) NOT NULL,
    "responseCode" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "integration_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_alerts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "remoteId" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "indicators" JSONB NOT NULL,
    "resolvedCiIds" UUID[],
    "affectedServiceCiIds" UUID[],
    "responseActions" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "traceparent" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "tenantId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "locale" "Locale",
    "timeZone" TEXT,
    "visibleLayers" "CiLayer"[],
    "preferences" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("tenantId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_organizationId_slug_key" ON "tenants"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "business_units_tenantId_key" ON "business_units"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sites_organizationId_code_key" ON "sites"("organizationId", "code");

-- CreateIndex
CREATE INDEX "site_links_fromSiteId_idx" ON "site_links"("fromSiteId");

-- CreateIndex
CREATE INDEX "site_links_toSiteId_idx" ON "site_links"("toSiteId");

-- CreateIndex
CREATE INDEX "cis_tenantId_type_idx" ON "cis"("tenantId", "type");

-- CreateIndex
CREATE INDEX "cis_tenantId_layer_idx" ON "cis"("tenantId", "layer");

-- CreateIndex
CREATE INDEX "cis_tenantId_validTo_idx" ON "cis"("tenantId", "validTo");

-- CreateIndex
CREATE INDEX "cis_tenantId_lifecycle_idx" ON "cis"("tenantId", "lifecycle");

-- CreateIndex
CREATE INDEX "cis_tenantId_type_identityKey_idx" ON "cis"("tenantId", "type", "identityKey");

-- CreateIndex
CREATE INDEX "cis_tenantId_checksum_idx" ON "cis"("tenantId", "checksum");

-- CreateIndex
CREATE INDEX "cis_attributes_idx" ON "cis" USING GIN ("attributes" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "ci_external_ids_tenantId_source_externalId_idx" ON "ci_external_ids"("tenantId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ci_external_ids_ciId_source_externalId_key" ON "ci_external_ids"("ciId", "source", "externalId");

-- CreateIndex
CREATE INDEX "relationships_fromCiId_idx" ON "relationships"("fromCiId");

-- CreateIndex
CREATE INDEX "relationships_toCiId_idx" ON "relationships"("toCiId");

-- CreateIndex
CREATE INDEX "relationships_tenantId_type_idx" ON "relationships"("tenantId", "type");

-- CreateIndex
CREATE INDEX "relationships_tenantId_validTo_idx" ON "relationships"("tenantId", "validTo");

-- CreateIndex
CREATE INDEX "relationships_fromCiId_toCiId_type_idx" ON "relationships"("fromCiId", "toCiId", "type");

-- CreateIndex
CREATE INDEX "reconciliation_conflicts_tenantId_status_idx" ON "reconciliation_conflicts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "reconciliation_conflicts_tenantId_ciId_idx" ON "reconciliation_conflicts"("tenantId", "ciId");

-- CreateIndex
CREATE INDEX "collector_manifests_family_idx" ON "collector_manifests"("family");

-- CreateIndex
CREATE INDEX "discovery_nodes_tenantId_siteId_idx" ON "discovery_nodes"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "discovery_nodes_tenantId_certificateExpiresAt_idx" ON "discovery_nodes"("tenantId", "certificateExpiresAt");

-- CreateIndex
CREATE INDEX "discovery_jobs_tenantId_status_scheduledAt_idx" ON "discovery_jobs"("tenantId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "discovery_jobs_nodeId_status_idx" ON "discovery_jobs"("nodeId", "status");

-- CreateIndex
CREATE INDEX "collector_runs_tenantId_startedAt_idx" ON "collector_runs"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "collector_runs_jobId_idx" ON "collector_runs"("jobId");

-- CreateIndex
CREATE INDEX "evidence_runId_idx" ON "evidence"("runId");

-- CreateIndex
CREATE INDEX "evidence_tenantId_digest_idx" ON "evidence"("tenantId", "digest");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventId_key" ON "outbox_events"("eventId");

-- CreateIndex
CREATE INDEX "outbox_events_deliveredAt_idx" ON "outbox_events"("deliveredAt");

-- CreateIndex
CREATE INDEX "outbox_events_tenantId_type_createdAt_idx" ON "outbox_events"("tenantId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_subject_idx" ON "outbox_events"("subject");

-- CreateIndex
CREATE INDEX "asset_records_tenantId_stage_idx" ON "asset_records"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "asset_records_tenantId_serialNumber_idx" ON "asset_records"("tenantId", "serialNumber");

-- CreateIndex
CREATE INDEX "asset_records_ciId_idx" ON "asset_records"("ciId");

-- CreateIndex
CREATE INDEX "asset_records_planId_idx" ON "asset_records"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_records_tenantId_assetTag_key" ON "asset_records"("tenantId", "assetTag");

-- CreateIndex
CREATE INDEX "asset_audits_assetId_at_idx" ON "asset_audits"("assetId", "at");

-- CreateIndex
CREATE INDEX "infra_plans_tenantId_status_idx" ON "infra_plans"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "infra_plans_tenantId_number_key" ON "infra_plans"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "bom_lines_planId_position_key" ON "bom_lines"("planId", "position");

-- CreateIndex
CREATE INDEX "support_contracts_tenantId_endsAt_idx" ON "support_contracts"("tenantId", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_contracts_tenantId_vendorCiId_contractNumber_key" ON "support_contracts"("tenantId", "vendorCiId", "contractNumber");

-- CreateIndex
CREATE INDEX "vendor_contacts_tenantId_vendorCiId_idx" ON "vendor_contacts"("tenantId", "vendorCiId");

-- CreateIndex
CREATE INDEX "impact_scenarios_tenantId_kind_idx" ON "impact_scenarios"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "impact_simulations_scenarioId_ranAt_idx" ON "impact_simulations"("scenarioId", "ranAt");

-- CreateIndex
CREATE INDEX "impact_simulations_tenantId_ranAt_idx" ON "impact_simulations"("tenantId", "ranAt");

-- CreateIndex
CREATE UNIQUE INDEX "impact_validations_simulationId_incidentId_key" ON "impact_validations"("simulationId", "incidentId");

-- CreateIndex
CREATE INDEX "incidents_tenantId_state_openedAt_idx" ON "incidents"("tenantId", "state", "openedAt");

-- CreateIndex
CREATE INDEX "incident_links_integrationId_remoteId_idx" ON "incident_links"("integrationId", "remoteId");

-- CreateIndex
CREATE INDEX "integration_configs_tenantId_category_enabled_idx" ON "integration_configs"("tenantId", "category", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_tenantId_name_key" ON "integration_configs"("tenantId", "name");

-- CreateIndex
CREATE INDEX "integration_deliveries_integrationId_state_createdAt_idx" ON "integration_deliveries"("integrationId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "integration_deliveries_tenantId_createdAt_idx" ON "integration_deliveries"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "integration_deliveries_eventId_idx" ON "integration_deliveries"("eventId");

-- CreateIndex
CREATE INDEX "security_alerts_tenantId_severity_observedAt_idx" ON "security_alerts"("tenantId", "severity", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "security_alerts_integrationId_remoteId_key" ON "security_alerts"("integrationId", "remoteId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_at_idx" ON "audit_logs"("tenantId", "at");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_subjectType_subjectId_idx" ON "audit_logs"("tenantId", "subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_links" ADD CONSTRAINT "site_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_links" ADD CONSTRAINT "site_links_fromSiteId_fkey" FOREIGN KEY ("fromSiteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_links" ADD CONSTRAINT "site_links_toSiteId_fkey" FOREIGN KEY ("toSiteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_states" ADD CONSTRAINT "onboarding_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cis" ADD CONSTRAINT "cis_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_external_ids" ADD CONSTRAINT "ci_external_ids_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_external_ids" ADD CONSTRAINT "ci_external_ids_ciId_fkey" FOREIGN KEY ("ciId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_fromCiId_fkey" FOREIGN KEY ("fromCiId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_toCiId_fkey" FOREIGN KEY ("toCiId") REFERENCES "cis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_conflicts" ADD CONSTRAINT "reconciliation_conflicts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_nodes" ADD CONSTRAINT "discovery_nodes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_nodes" ADD CONSTRAINT "discovery_nodes_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "discovery_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "discovery_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "discovery_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "collector_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_records" ADD CONSTRAINT "asset_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_records" ADD CONSTRAINT "asset_records_ciId_fkey" FOREIGN KEY ("ciId") REFERENCES "cis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_records" ADD CONSTRAINT "asset_records_planId_fkey" FOREIGN KEY ("planId") REFERENCES "infra_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_records" ADD CONSTRAINT "asset_records_supportContractId_fkey" FOREIGN KEY ("supportContractId") REFERENCES "support_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_audits" ADD CONSTRAINT "asset_audits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_audits" ADD CONSTRAINT "asset_audits_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infra_plans" ADD CONSTRAINT "infra_plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_planId_fkey" FOREIGN KEY ("planId") REFERENCES "infra_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_contracts" ADD CONSTRAINT "support_contracts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_contracts" ADD CONSTRAINT "support_contracts_primaryContactId_fkey" FOREIGN KEY ("primaryContactId") REFERENCES "vendor_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_scenarios" ADD CONSTRAINT "impact_scenarios_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_simulations" ADD CONSTRAINT "impact_simulations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_simulations" ADD CONSTRAINT "impact_simulations_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "impact_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_validations" ADD CONSTRAINT "impact_validations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_validations" ADD CONSTRAINT "impact_validations_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "impact_simulations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impact_validations" ADD CONSTRAINT "impact_validations_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_links" ADD CONSTRAINT "incident_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_links" ADD CONSTRAINT "incident_links_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_links" ADD CONSTRAINT "incident_links_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integration_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_configs" ADD CONSTRAINT "integration_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_statuses" ADD CONSTRAINT "integration_statuses_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integration_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integration_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integration_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


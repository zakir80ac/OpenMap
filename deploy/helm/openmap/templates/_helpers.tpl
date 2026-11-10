{{/* REQ-INT-003 — naming, labels and the shared application environment. */}}
{{- define "openmap.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "openmap.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openmap.labels" -}}
app.kubernetes.io/name: {{ include "openmap.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "openmap.componentLabels" -}}
{{ include "openmap.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "openmap.selector" -}}
app.kubernetes.io/name: {{ include "openmap.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "openmap.image" -}}
{{- $tag := default .root.Chart.AppVersion .root.Values.image.tag -}}
{{- if .root.Values.image.registry -}}
{{ printf "%s/%s/%s:%s" .root.Values.image.registry .root.Values.image.repositoryPrefix .app $tag }}
{{- else -}}
{{ printf "%s/%s:%s" .root.Values.image.repositoryPrefix .app $tag }}
{{- end -}}
{{- end -}}

{{- define "openmap.svc" -}}
{{ printf "%s-%s" (include "openmap.fullname" .root) .component }}
{{- end -}}

{{/* REQ-SEC-011 (ADR-067): OpenBao's address, the chart's own or the external vault. */}}
{{- define "openmap.vaultAddr" -}}
{{- if .Values.openbao.external.enabled }}{{ .Values.openbao.external.address }}{{ else }}http://{{ include "openmap.fullname" . }}-openbao:8200{{ end }}
{{- end }}

{{/*
REQ-SEC-011 (ADR-068): the internal services CA for clients. An init container fetches it from OpenBao's public
pki/ca/pem (it exists once the OpenBao init job has run) into a memory volume every container of the pod mounts.
*/}}
{{- define "openmap.serviceCaInit" -}}
- name: service-ca
  image: {{ if .Values.image.registry }}{{ .Values.image.registry }}/{{ end }}{{ .Values.openbao.image }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  command: ["sh", "-c", "until wget -qO /run/openmap/ca/services-ca.crt {{ include "openmap.vaultAddr" . }}/v1/pki/ca/pem && grep -q CERTIFICATE /run/openmap/ca/services-ca.crt; do sleep {{ .Values.migrate.pollSeconds }}; done"]
  volumeMounts: [{ name: service-ca, mountPath: /run/openmap/ca }]
{{- end -}}

{{- define "openmap.caVolume" -}}
- name: service-ca
  emptyDir: { medium: Memory, sizeLimit: 1Mi }
{{- end -}}

{{- define "openmap.caMount" -}}
- { name: service-ca, mountPath: /run/openmap/ca, readOnly: true }
{{- end -}}

{{/* REQ-SEC-011 (ADR-067): the services' AppRole ids, mounted where OPENBAO_ROLE_ID_FILE / OPENBAO_SECRET_ID_FILE point. */}}
{{- define "openmap.vaultVolume" -}}
{{- if not .Values.openbao.external.enabled }}
- name: openbao-approle
  secret:
    secretName: {{ include "openmap.fullname" . }}-openbao-approle
    defaultMode: 0440
    items: [{ key: role-id, path: role-id }, { key: secret-id, path: secret-id }]
{{- end }}
{{- end -}}

{{- define "openmap.vaultMount" -}}
{{- if not .Values.openbao.external.enabled }}
- { name: openbao-approle, mountPath: /run/openmap/openbao, readOnly: true }
{{- end }}
{{- end -}}

{{/* Environment shared by every Node service; secrets are referenced, never inlined. */}}
{{- define "openmap.appEnv" -}}
- name: NODE_ENV
  value: production
- name: POSTGRES_URL
  valueFrom: { secretKeyRef: { name: {{ include "openmap.fullname" . }}-datastores, key: POSTGRES_URL } }
- name: MEMGRAPH_URL
  value: bolt://{{ include "openmap.fullname" . }}-memgraph:7687
# ADR-068: HTTPS to ClickHouse, every TLS client verifying against the CA each pod fetches.
- name: CLICKHOUSE_URL
  value: https://{{ include "openmap.fullname" . }}-clickhouse:8443
- name: SERVICE_CA_PATH
  value: /run/openmap/ca/services-ca.crt
- name: CLICKHOUSE_USER
  value: {{ .Values.clickhouse.username | quote }}
- name: CLICKHOUSE_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "openmap.fullname" . }}-datastores, key: CLICKHOUSE_PASSWORD } }
- name: CLICKHOUSE_DB
  value: {{ .Values.clickhouse.database | quote }}
- name: VALKEY_URL
  value: redis://{{ include "openmap.fullname" . }}-valkey:6379
- name: MEILI_URL
  value: http://{{ include "openmap.fullname" . }}-meilisearch:7700
- name: MEILI_MASTER_KEY
  valueFrom: { secretKeyRef: { name: {{ include "openmap.fullname" . }}-datastores, key: MEILI_MASTER_KEY } }
- name: KEYCLOAK_URL
  value: http://{{ include "openmap.fullname" . }}-keycloak:8080
- name: KEYCLOAK_REALM
  value: {{ .Values.keycloak.realm | quote }}
- name: OPENBAO_ADDR
  value: {{ include "openmap.vaultAddr" . | quote }}
- name: OPENBAO_MOUNT
  value: {{ .Values.openbao.mount | quote }}
{{- if .Values.openbao.external.enabled }}
- name: OPENBAO_TOKEN
  valueFrom: { secretKeyRef: { name: {{ include "openmap.fullname" . }}-datastores, key: OPENBAO_TOKEN } }
{{- else }}
- name: OPENBAO_ROLE_ID_FILE
  value: /run/openmap/openbao/role-id
- name: OPENBAO_SECRET_ID_FILE
  value: /run/openmap/openbao/secret-id
{{- end }}
- name: PUBLIC_API_URL
  value: {{ .Values.api.publicUrl | quote }}
- name: PUBLIC_CONSOLE_URL
  value: {{ .Values.console.publicUrl | quote }}
{{- if .Values.console.aliasUrl }}
- name: PUBLIC_CONSOLE_ALIAS_URL
  value: {{ .Values.console.aliasUrl | quote }}
{{- end }}
- name: PUBLIC_KEYCLOAK_URL
  value: {{ .Values.keycloak.publicUrl | quote }}
{{- if .Values.llm.enabled }}
- name: LLM_URL
  value: {{ .Values.llm.url | quote }}
{{- end }}
{{- end -}}

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

{{/* Environment shared by every Node service; secrets are referenced, never inlined. */}}
{{- define "openmap.appEnv" -}}
- name: NODE_ENV
  value: production
- name: POSTGRES_URL
  valueFrom: { secretKeyRef: { name: {{ include "openmap.fullname" . }}-datastores, key: POSTGRES_URL } }
- name: MEMGRAPH_URL
  value: bolt://{{ include "openmap.fullname" . }}-memgraph:7687
- name: CLICKHOUSE_URL
  value: http://{{ include "openmap.fullname" . }}-clickhouse:8123
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
  value: {{ if .Values.openbao.external.enabled }}{{ .Values.openbao.external.address | quote }}{{ else }}http://{{ include "openmap.fullname" . }}-openbao:8200{{ end }}
- name: OPENBAO_MOUNT
  value: {{ .Values.openbao.mount | quote }}
- name: OPENBAO_TOKEN
  valueFrom: { secretKeyRef: { name: {{ include "openmap.fullname" . }}-datastores, key: OPENBAO_TOKEN } }
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

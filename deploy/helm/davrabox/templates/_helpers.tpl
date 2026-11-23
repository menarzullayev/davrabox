{{- define "dvr.labels" -}}
app.kubernetes.io/part-of: davrabox
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "dvr.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  seccompProfile: { type: RuntimeDefault }
{{- end -}}

{{- define "dvr.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }
{{- end -}}

{{- define "dvr.dbHost" -}}
{{- if .Values.postgres.enabled -}}postgres{{- else -}}{{ required "api.databaseHost is required when postgres.enabled=false" .Values.api.databaseHost }}{{- end -}}
{{- end -}}

{{- define "cubestack-bmc-exporter.fullname" -}}
{{- default (printf "%s-%s" .Release.Name .Chart.Name) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cubestack-bmc-exporter.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: cubestack-observability
{{- end -}}

{{- define "cubestack-bmc-exporter.componentLabels" -}}
{{ include "cubestack-bmc-exporter.labels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

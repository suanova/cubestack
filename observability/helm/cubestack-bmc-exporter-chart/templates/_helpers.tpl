{{- define "cubestack-bmc-exporter.fullname" -}}
{{- /* Singleton chart: resource names default to the release name (e.g.
     release "cubestack-bmc-exporter" -> "cubestack-bmc-exporter-bmc-oem-exporter"),
     not the "<release>-<chart>" double name. fullnameOverride still wins. */ -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
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

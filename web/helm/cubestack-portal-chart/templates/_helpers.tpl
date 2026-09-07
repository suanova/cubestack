{{/*
Expand the name of the chart.
*/}}
{{- define "cubestack-portal-chart.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "cubestack-portal-chart.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "cubestack-portal-chart.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create the name of the service account
*/}}
{{- define "cubestack-portal-chart.serviceAccountName" -}}
{{- default (include "cubestack-portal-chart.fullname" .) .Values.serviceAccount.name }}
{{- end }}

{{/*
Create the name of the deployment
*/}}
{{- define "cubestack-portal-chart.deploymentName" -}}
{{- include "cubestack-portal-chart.fullname" . }}
{{- end }}

{{/*
Create the name of the service
*/}}
{{- define "cubestack-portal-chart.serviceName" -}}
{{- include "cubestack-portal-chart.fullname" . }}
{{- end }}

{{/*
Create the name of the ingress
*/}}
{{- define "cubestack-portal-chart.ingressName" -}}
{{- include "cubestack-portal-chart.fullname" . }}
{{- end }}

{{/*
Create environment variables for UI container
*/}}
{{- define "cubestack-portal-chart.env" -}}
{{- if .Values.env }}
{{- range $key, $value := .Values.env }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- end }}

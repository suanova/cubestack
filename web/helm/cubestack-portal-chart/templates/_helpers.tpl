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
{{- include "cubestack-portal-chart.fullname" . -}}
{{- end }}

{{/*
Create cluster-scoped, namespace-unique names for the ClusterRole.
Cluster-scoped resources cannot be namespaced, so releases with the same
name in different namespaces would collide. The fullname is capped so a
bounded hash of the namespace always survives the 63-char DNS limit.
*/}}
{{- define "cubestack-portal-chart.clusterRoleName" -}}
{{- $nsHash := .Values.namespace | sha256sum | trunc 8 -}}
{{- printf "%s-%s-cluster-role" (include "cubestack-portal-chart.fullname" . | trunc 40 | trimSuffix "-") $nsHash | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "cubestack-portal-chart.clusterRoleBindingName" -}}
{{- $nsHash := .Values.namespace | sha256sum | trunc 8 -}}
{{- printf "%s-%s-cluster-role-binding" (include "cubestack-portal-chart.fullname" . | trunc 33 | trimSuffix "-") $nsHash | trunc 63 | trimSuffix "-" -}}
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

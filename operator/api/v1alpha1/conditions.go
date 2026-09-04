/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

// ConditionType is the type of a status condition. The constants below are the
// standard condition types of the ai.cubestack.io API group; controllers
// should reference them instead of raw strings. It is an alias of string so
// the constants assign directly to metav1.Condition.Type.
type ConditionType = string

const (
	// ConditionStorageResolved indicates that the referenced storage is
	// resolvable: Dynamic — the referenced StorageClass exists; Static — the
	// storage unit is resolvable (handled by the storage-side integration); S3 —
	// the uri prefix and credentials Secret are resolvable (same integration);
	// HostPath — always True. (ModelVersion)
	ConditionStorageResolved ConditionType = "StorageResolved"

	// ConditionAssetsResolved indicates that all assets[].configMapRef.name
	// exist in cubestack-system. (InferenceRuntimeProfile)
	ConditionAssetsResolved ConditionType = "AssetsResolved"

	// ConditionInUse indicates that the object is referenced by at least one
	// InferenceService. True is only a warning before deletion. (ModelVersion,
	// InferenceRuntimeProfile)
	ConditionInUse ConditionType = "InUse"

	// ConditionResolved indicates that profileRef/modelRef/assets resolve and
	// the model is compatible with the profile. (InferenceService)
	ConditionResolved ConditionType = "Resolved"

	// ConditionRendered indicates that overrides are valid and the templates
	// render successfully. (InferenceService)
	ConditionRendered ConditionType = "Rendered"

	// ConditionProvisioned indicates that the rendered asset ConfigMaps and
	// model PVCs are created in the service namespace. (InferenceService)
	ConditionProvisioned ConditionType = "Provisioned"

	// ConditionWorkloadsApplied indicates that the desired config is applied
	// to Services and workloads, not that they are ready. (InferenceService)
	ConditionWorkloadsApplied ConditionType = "WorkloadsApplied"

	// ConditionEndpointReady indicates that the internal endpoint is actually
	// reachable. (InferenceService)
	ConditionEndpointReady ConditionType = "EndpointReady"

	// ConditionRouteReady indicates that the public route is published, or
	// that publishing was not requested. (InferenceService)
	ConditionRouteReady ConditionType = "RouteReady"

	// ConditionReady aggregates all roles per readinessPolicy. (InferenceService)
	ConditionReady ConditionType = "Ready"

	// ConditionProgressing indicates that the controller is still applying the
	// desired config. (InferenceService)
	ConditionProgressing ConditionType = "Progressing"

	// ConditionProfileDeprecated warns that the referenced profile carries the
	// ai.cubestack.io/deprecated label. (InferenceService)
	ConditionProfileDeprecated ConditionType = "ProfileDeprecated"

	// ConditionProfileDrifted warns that the current profile content hash
	// differs from status.profile.revision, usually from a same-name
	// recreation. (InferenceService)
	ConditionProfileDrifted ConditionType = "ProfileDrifted"

	// ConditionPodScheduled indicates that the Pod has been scheduled.
	// (DevEnvironment)
	ConditionPodScheduled ConditionType = "PodScheduled"

	// ConditionStorageReady indicates that the workspace PVC is Bound.
	// (DevEnvironment)
	ConditionStorageReady ConditionType = "StorageReady"

	// ConditionBrandMatchValid indicates that gpuType matches the image brand
	// (nvidia<->base-cuda, metax<->base-maca). (DevEnvironment)
	ConditionBrandMatchValid ConditionType = "BrandMatchValid"
)

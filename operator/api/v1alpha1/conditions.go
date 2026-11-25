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

	// ConditionRouteReady indicates that the public route is published and
	// accepted by the gateway, or that publishing was not requested.
	// (InferenceService, DevEnvironment)
	ConditionRouteReady ConditionType = "RouteReady"

	// ConditionReady aggregates all roles per readinessPolicy, and for a
	// DevEnvironment reflects the phase derived from the workload.
	// (InferenceService, DevEnvironment)
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

	// ConditionCustomized warns that the service carries user environment
	// overrides outside the profile (spec.env). It never affects the phase.
	// (InferenceService)
	ConditionCustomized ConditionType = "Customized"

	// ConditionPodScheduled indicates that the Pod has been scheduled.
	// (DevEnvironment)
	ConditionPodScheduled ConditionType = "PodScheduled"

	// ConditionAccepted indicates that the controller applies the spec as
	// written. False means the spec states something the controller refuses to
	// run and only the user can correct it — today a GPU vendor its image does
	// not match, or NOTEBOOK_ARGS the controller cannot read; nothing is
	// provisioned until it is fixed. True with reason Overridden means the
	// controller resolved one or more spec fields itself and runs the
	// environment anyway, each one named in the message. (DevEnvironment)
	ConditionAccepted ConditionType = "Accepted"

	// ConditionPlatformReady indicates that the platform prerequisites and
	// resources this environment requests are in place: the virtualization and
	// storage layers are serviceable, and the requested accelerator, RDMA and
	// IP-pool resources are available. The ones not requested count as
	// satisfied. (VMEnvironment)
	ConditionPlatformReady ConditionType = "PlatformReady"

	// ConditionAssetsReady indicates that the external objects the spec
	// references exist and are usable — the SSH key Secret and the password
	// Secret. Not referencing one counts as satisfied. (VMEnvironment)
	ConditionAssetsReady ConditionType = "AssetsReady"

	// ConditionStorageReady indicates that the system disk and every data disk
	// are usable. (VMEnvironment)
	ConditionStorageReady ConditionType = "StorageReady"

	// ConditionGuestReady indicates that the guest finished booting, its agent
	// is connected, and the guest-side services of the enabled channels are up.
	// (VMEnvironment)
	ConditionGuestReady ConditionType = "GuestReady"

	// ConditionLiveMigratable indicates whether the environment currently
	// meets the conditions for live migration. (VMEnvironment)
	ConditionLiveMigratable ConditionType = "LiveMigratable"
)

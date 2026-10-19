package renderer

import (
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/api/validate/content"
	"k8s.io/apimachinery/pkg/util/intstr"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	// modelMain is the model name of the primary model mount.
	modelMain = "main"
	// overridesNamespace is the variable namespace of the resolved overrides.
	overridesNamespace = "overrides"
)

// Vendor product labels, written by the vendor device plugin to every GPU
// node and used as the fact source of the accelerator.models scheduling
// constraint (design §3.2): metax records metax-tech.com/gpu.product=MXC500,
// nvidia nvidia.com/gpu.product=H200.
const (
	metaxProductLabel  = "metax-tech.com/gpu.product"
	nvidiaProductLabel = "nvidia.com/gpu.product"
)

// Result is the outcome of a full render: resolved overrides, per-role
// workload structure and rendered pod templates, and rendered asset data.
// Errors is empty when the render succeeds; any error means the Rendered
// condition is False with the first error's reason.
type Result struct {
	Overrides map[string]string
	Roles     []RenderedRole
	Assets    map[string]map[string]string
	Errors    []Error

	// PodAntiAffinityPolicy is the rendered placement policy of the profile's
	// podAntiAffinity (design §3.2): "required", "preferred" or "none". It is
	// empty when the profile declares no podAntiAffinity at all; a declared
	// podAntiAffinity whose policy is unset renders as "required", the
	// behaviour of every profile written before the policy existed.
	PodAntiAffinityPolicy string
}

// RenderedRole is one profile role with the workload structure resolved and
// the pod template's templated fields rendered. GroupSize is 0 for Deployments.
type RenderedRole struct {
	Name        string
	Replicas    int64
	GroupSize   int64
	PodTemplate aiv1alpha1.PodTemplate

	// UsesCredentials is true when the role's pod template referenced
	// {{ model.credentialsPath }}: the controller injects the S3 credentials
	// volume only into these roles (design §4.5).
	UsesCredentials bool

	// ModelNodeAffinity constrains scheduling when the profile declares more
	// than one accelerator model (design §3.2): the controller renders a
	// required nodeAffinity In term on the vendor product label. Nil when a
	// single model is declared — that case is injected as a nodeSelector.
	ModelNodeAffinity *ModelNodeAffinity

	// NodeAffinityRequirements are the multi-value node selections resolved
	// from the service-level and role-level nodeSelector templates: the
	// controller renders each as a required nodeAffinity In term. A selection
	// naming one value per label is a plain podTemplate.nodeSelector entry
	// instead, because a nodeSelector map can only express equality.
	NodeAffinityRequirements []NodeAffinityRequirement
}

// NodeAffinityRequirement is a required nodeAffinity In term: the node's label
// value must be one of Values.
type NodeAffinityRequirement struct {
	Label  string
	Values []string
}

// ModelNodeAffinity is the multi-model scheduling constraint resolved from
// the profile accelerator (design §3.2): the platform node label that records
// the GPU model and the models the node must offer.
type ModelNodeAffinity struct {
	// Label is the vendor product label of the accelerator vendor.
	Label string
	// Models are the declared accelerator models, all required via In.
	Models []string
}

// Render renders the full profile for one InferenceService: validates and
// resolves the overrides, resolves the workload structure (replicas, group
// size), renders the pod template templated fields, and renders the asset
// data in the service-level context.
func Render(isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, model *aiv1alpha1.ModelVersion, assetData map[string]map[string]string) Result {
	res := Result{
		Overrides: map[string]string{},
		Assets:    make(map[string]map[string]string),
	}

	overrides, errs := ResolveOverrides(profile.Spec.Overrides, isvc.Spec.Overrides)
	res.Overrides = overrides
	res.Errors = append(res.Errors, errs...)

	routeVars := routeVars(isvc.Spec.Route)
	serviceVars := serviceVars(isvc)

	// Pre-build the per-role serviceName map for roles.<name>.serviceName.
	serviceNames := make(map[string]string, len(profile.Spec.Roles))
	for _, role := range profile.Spec.Roles {
		serviceNames[role.Name] = fmt.Sprintf("%s-%s", isvc.Name, role.Name)
	}

	declared := make(map[string]bool, len(profile.Spec.Overrides))
	for _, ov := range profile.Spec.Overrides {
		declared[ov.Name] = true
	}

	ctx := &renderContext{
		overrides:    overrides,
		declared:     declared,
		service:      serviceVars,
		model:        modelVars(model),
		route:        routeVars,
		profileVars:  profile.Spec.Vars,
		serviceNames: serviceNames,
		// model.path resolves to the S3 uri and model.credentialsPath is only
		// available when credentialsRef is set (design §4.5).
		storageStrategy:  model.Spec.Storage.Strategy,
		s3CredentialsSet: model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyS3 && model.Spec.Storage.S3 != nil && model.Spec.Storage.S3.CredentialsRef != nil,
	}

	// The placement policy and the node selector are each a single profile-level
	// value — one declaration covers every role — so they are rendered once here
	// rather than per role.
	res.PodAntiAffinityPolicy, res.Errors = resolvePodAntiAffinity(ctx, profile.Spec.PodAntiAffinity, res.Errors)
	var serviceSelector nodeSelection
	serviceSelector, res.Errors = resolveNodeSelector(ctx, "", profile.Spec.NodeSelector, res.Errors)

	// Roles: structure first, then pod template. Errors accumulate; later
	// fields are still rendered so the message aggregates all failures.
	for i := range profile.Spec.Roles {
		role := profile.Spec.Roles[i]
		rr := RenderedRole{Name: role.Name, PodTemplate: role.PodTemplate}
		rr.Replicas, res.Errors = resolveReplicas(ctx, role.Name, role.Workload.Replicas, res.Errors)

		roleV := &roleVars{name: role.Name}
		if role.Workload.Kind == aiv1alpha1.WorkloadKindLeaderWorkerSet && role.Workload.Group != nil {
			rr.GroupSize, res.Errors = resolveReplicas(ctx, role.Name, &role.Workload.Group.Size, res.Errors)
			roleV.groupSize = strconv.FormatInt(rr.GroupSize, 10)
		}
		for _, m := range role.PodTemplate.Mounts {
			if m.Model == modelMain {
				roleV.modelPath = m.At
				break
			}
		}
		// S3 strategy: the engine consumes the model by URI — the role never
		// mounts it, and {{ model.path }} resolves to the uri for every role.
		// (A profile declaring mounts[] with an S3 ModelVersion is rejected at
		// Resolved, so the two never combine here.)
		if roleV.modelPath == "" && model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyS3 && model.Spec.Storage.S3 != nil {
			roleV.modelPath = model.Spec.Storage.S3.URI
		}
		ctx.role = roleV
		rr.PodTemplate, res.Errors = renderPodTemplate(ctx, rr.PodTemplate, res.Errors)
		rr.UsesCredentials = roleV.usesCredentials
		// The service-level selection merges before the role-level one so that a
		// pair naming the vendor product label goes through the conflict rule
		// below; the role-level selection wins a shared key. Materialization
		// happens after injectModelSelector so the conflict rule sees the
		// multi-value selections too.
		var roleSelector nodeSelection
		roleSelector, res.Errors = resolveNodeSelector(ctx, role.Name, role.NodeSelector, res.Errors)
		selector := mergeNodeSelections(serviceSelector, roleSelector)
		accel := role.EffectiveAccelerator(profile.Spec.Accelerator)
		res.Errors = injectModelSelector(&rr, accel, selector, res.Errors)
		// A multi-value selection replaces any podTemplate entry for the same
		// key: keeping it would AND an equality with the In term, which no node
		// can satisfy. The accelerator pin is the exception — it is what keeps a
		// single-model role on its model when the selection spans several.
		modelPinLabel := ""
		if rr.PodTemplate.Resources != nil &&
			rr.PodTemplate.Resources.GPUPerPod != nil &&
			len(accel.Models) == 1 {
			modelPinLabel = productLabel(accel.Vendor)
		}
		for label, values := range selector {
			if len(values) > 1 && label != modelPinLabel {
				delete(rr.PodTemplate.NodeSelector, label)
			}
		}
		finalizeNodeSelector(&rr, selector)
		// A role that will receive the injected S3 credentials volume must not
		// declare a podTemplate volume of the same name: the pod template would
		// carry two volumes named model-credentials and Kubernetes would reject
		// it at apply time (design §4.5).
		if roleV.usesCredentials {
			for _, v := range rr.PodTemplate.Volumes {
				if v.Name == aiv1alpha1.ModelCredentialsVolumeName {
					res.Errors = append(res.Errors, Error{
						Reason: ReasonReservedVolumeName,
						Msg:    fmt.Sprintf("role %q declares volume %q which is reserved for the S3 credentials copy", role.Name, v.Name),
					})
					break
				}
			}
		}
		res.Roles = append(res.Roles, rr)
	}
	ctx.role = nil

	// Assets: service-level context only. Errors from the overrides and role
	// phases accumulate into res.Errors; each asset string only appends. The
	// asset data keys are sorted so the error order — and therefore the
	// Rendered condition reason — is deterministic across reconciles.
	for _, asset := range profile.Spec.Assets {
		data := assetData[asset.Name]
		keys := make([]string, 0, len(data))
		for k := range data {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		rendered := make(map[string]string, len(data))
		for _, k := range keys {
			var errs []Error
			rendered[k], errs = renderString(ctx, data[k], assetAllowed)
			res.Errors = append(res.Errors, errs...)
		}
		res.Assets[asset.Name] = rendered
	}

	return res
}

// serviceVars are the service-level variables: name and namespace.
func serviceVars(isvc *aiv1alpha1.InferenceService) map[string]string {
	return map[string]string{"name": isvc.Name, "namespace": isvc.Namespace}
}

func modelVars(model *aiv1alpha1.ModelVersion) map[string]string {
	return map[string]string{
		"name":         model.Spec.Model,
		"version":      model.Spec.Version,
		"architecture": model.Spec.Architecture,
		"quantization": model.Spec.Quantization,
	}
}

// routeVars renders the route.<name> variables of the templates. The defaults
// mirror the RouteSpec CRD defaults: an unset timeoutSeconds caps nothing and
// an unset idleTimeoutSeconds bounds the stream at 300s.
func routeVars(route *aiv1alpha1.RouteSpec) map[string]string {
	if route == nil {
		return map[string]string{"publish": "false", "modelName": "", "timeoutSeconds": "0", "idleTimeoutSeconds": "300"}
	}
	timeout := "0"
	if route.TimeoutSeconds != nil {
		timeout = strconv.FormatInt(*route.TimeoutSeconds, 10)
	}
	idle := "300"
	if route.IdleTimeoutSeconds != nil {
		idle = strconv.FormatInt(*route.IdleTimeoutSeconds, 10)
	}
	return map[string]string{
		"publish":            strconv.FormatBool(route.Publish),
		"modelName":          route.ModelName,
		"timeoutSeconds":     timeout,
		"idleTimeoutSeconds": idle,
	}
}

// renderContext carries the variable namespaces of one render.
type renderContext struct {
	overrides    map[string]string
	declared     map[string]bool
	service      map[string]string
	model        map[string]string
	route        map[string]string
	profileVars  map[string]string
	serviceNames map[string]string
	// storageStrategy and s3CredentialsSet describe the referenced
	// ModelVersion's storage for model.path/model.credentialsPath.
	storageStrategy  aiv1alpha1.StorageStrategy
	s3CredentialsSet bool
	// role is the role currently being rendered; nil in service-level
	// contexts (asset data).
	role *roleVars
}

// mergeNodeSelections combines the service-level and role-level selections:
// the service-level one applies to every role (which nodes the service runs on
// is a property of the service, and a CPU-only role quietly left off the pool
// the service was pinned to would be a surprise rather than a feature), and the
// role-level one wins a shared key. Values are kept as a list here — whether
// they become a nodeSelector entry or a nodeAffinity term is decided in
// finalizeNodeSelector.
func mergeNodeSelections(base, override nodeSelection) nodeSelection {
	if len(base) == 0 && len(override) == 0 {
		return nil
	}
	merged := make(nodeSelection, len(base)+len(override))
	maps.Copy(merged, base)
	maps.Copy(merged, override)
	return merged
}

// finalizeNodeSelector materializes a rendered selection into the pod template:
// a key with one value is a nodeSelector entry (equality), a key with several
// values is a required nodeAffinity In term (a nodeSelector map cannot express
// "one of"). Keys are sorted so the rendered result is deterministic.
func finalizeNodeSelector(rr *RenderedRole, sel nodeSelection) {
	if len(sel) == 0 {
		return
	}
	keys := make([]string, 0, len(sel))
	for k := range sel {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, label := range keys {
		values := sel[label]
		if len(values) == 1 {
			if rr.PodTemplate.NodeSelector == nil {
				rr.PodTemplate.NodeSelector = make(map[string]string, len(sel))
			}
			rr.PodTemplate.NodeSelector[label] = values[0]
			continue
		}
		rr.NodeAffinityRequirements = append(rr.NodeAffinityRequirements, NodeAffinityRequirement{Label: label, Values: values})
	}
}

// productLabel is the node label the accelerator vendor's device plugin writes
// the GPU model to (design §3.2); the model constraint is injected through it.
func productLabel(vendor aiv1alpha1.AcceleratorVendor) string {
	if vendor == aiv1alpha1.AcceleratorVendorNvidia {
		return nvidiaProductLabel
	}
	return metaxProductLabel
}

// injectModelSelector constrains the role's scheduling to its effective
// accelerator models (design §3.2: the role's own accelerator when declared,
// the profile-level value otherwise): one model merges into the pod template
// nodeSelector, several models produce a required nodeAffinity In term on the
// vendor product label (recorded in the rendered role for the controller).
// A node selector pinning the vendor label to a value outside the declared
// models is a ModelSchedulingConflict: the merge would render a pod that can
// never be scheduled, and the immutable profile must fail at the Rendered stage.
// The pin may be the role's own podTemplate.nodeSelector, the service-level or
// role-level nodeSelector template (single value or a multi-value selection).
func injectModelSelector(rr *RenderedRole, accel aiv1alpha1.Accelerator, sel nodeSelection, errs []Error) []Error {
	if len(accel.Models) == 0 {
		return errs
	}
	// Only roles that request GPUs are constrained to GPU-model nodes. A
	// CPU-only auxiliary role (e.g. a router) must be able to run on any node
	// — pinning it to GPU-model nodes would strand it on clusters without
	// GPU nodes (or with no model label on non-GPU nodes).
	if rr.PodTemplate.Resources == nil || rr.PodTemplate.Resources.GPUPerPod == nil {
		return errs
	}
	label := productLabel(accel.Vendor)

	if pinned, ok := rr.PodTemplate.NodeSelector[label]; ok {
		if !slices.Contains(accel.Models, pinned) {
			return append(errs, Error{
				Reason: ReasonModelSchedulingConflict,
				Msg: fmt.Sprintf("role %q node selector pins %q to %q, which contradicts the declared accelerator models %v",
					rr.Name, label, pinned, accel.Models),
			})
		}
		// An identical pin is consistent: the merge below is a no-op for the
		// single-model case, the nodeAffinity term stays satisfiable otherwise.
	}

	// A selection on the product label is either a map pin (one value, checked
	// above after materialization) or a nodeAffinity In term (several values).
	// The term is AND-combined with the accelerator constraint, so it must
	// intersect the declared models or the pod could never be scheduled.
	if selected, ok := sel[label]; ok {
		if len(selected) == 1 {
			if !slices.Contains(accel.Models, selected[0]) {
				return append(errs, Error{
					Reason: ReasonModelSchedulingConflict,
					Msg: fmt.Sprintf("role %q node selector pins %q to %q, which contradicts the declared accelerator models %v",
						rr.Name, label, selected[0], accel.Models),
				})
			}
		} else if !slices.ContainsFunc(selected, func(v string) bool { return slices.Contains(accel.Models, v) }) {
			return append(errs, Error{
				Reason: ReasonModelSchedulingConflict,
				Msg: fmt.Sprintf("role %q node selector restricts %q to %v, none of which is one of the declared accelerator models %v",
					rr.Name, label, selected, accel.Models),
			})
		}
	}

	if len(accel.Models) == 1 {
		if rr.PodTemplate.NodeSelector == nil {
			rr.PodTemplate.NodeSelector = map[string]string{}
		}
		rr.PodTemplate.NodeSelector[label] = accel.Models[0]
		return errs
	}
	rr.ModelNodeAffinity = &ModelNodeAffinity{Label: label, Models: accel.Models}
	return errs
}

// roleVars are the role-level variables of the current role.
type roleVars struct {
	name      string
	groupSize string // "" for Deployment roles
	modelPath string // "" when the role declares no model:main mount
	// usesCredentials is set when the role referenced {{ model.credentialsPath }}
	// and it resolved: the role then needs the S3 credentials volume injected.
	usesCredentials bool
}

// allowedFunc reports whether a variable namespace is allowed in the current
// field context; it also decides the PhaseViolation error.
type allowedFunc func(namespace string) bool

// workloadAllowed allows only overrides in workload structure fields.
func workloadAllowed(namespace string) bool { return namespace == overridesNamespace }

// assetAllowed allows only the service-level namespaces in asset data.
func assetAllowed(namespace string) bool {
	switch namespace {
	case "model", "service", overridesNamespace, "profile", "route":
		return true
	}
	return false
}

// podTemplateAllowed allows the full variable set.
func podTemplateAllowed(namespace string) bool { return true }

// renderString substitutes every {{ path }} placeholder in s, resolving the
// variable against the context and the field's allowed namespaces.
func renderString(ctx *renderContext, s string, allowed allowedFunc) (string, []Error) {
	var b strings.Builder
	b.Grow(len(s))
	var errs []Error
	rest := s
	for {
		open := strings.Index(rest, "{{")
		if open < 0 {
			b.WriteString(rest)
			break
		}
		b.WriteString(rest[:open])
		afterOpen := rest[open+2:]
		close := strings.Index(afterOpen, "}}")
		if close < 0 {
			errs = append(errs, Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unclosed placeholder in %q", s)})
			b.WriteString(rest[open:])
			break
		}
		path := strings.TrimSpace(afterOpen[:close])
		value, err := resolve(ctx, path, allowed)
		if err != nil {
			errs = append(errs, *err)
			b.WriteString(rest[open : open+2+close+2])
		} else {
			b.WriteString(value)
		}
		rest = afterOpen[close+2:]
	}
	return b.String(), errs
}

// resolve resolves one dotted variable path against the context.
func resolve(ctx *renderContext, path string, allowed allowedFunc) (string, *Error) {
	parts := strings.Split(path, ".")
	if len(parts) < 2 || parts[0] == "" {
		return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("invalid placeholder %q", path)}
	}
	ns := parts[0]
	if !allowed(ns) {
		return "", &Error{Reason: ReasonPhaseViolation, Msg: fmt.Sprintf("variable %q is not allowed in this context", path)}
	}

	switch ns {
	case overridesNamespace:
		return resolveOverridesVar(ctx, parts, path)
	case "service":
		return resolveServiceVar(ctx, parts, path)
	case "model":
		return resolveModelVar(ctx, parts, path)
	case "route":
		return resolveRouteVar(ctx, parts, path)
	case "profile":
		return resolveProfileVar(ctx, parts, path)
	case "role":
		return resolveRoleVar(ctx, path)
	case "roles":
		return resolveRolesVar(ctx, parts, path)
	default:
		return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable namespace %q", ns)}
	}
}

// resolveOverridesVar resolves an overrides.<name> variable.
func resolveOverridesVar(ctx *renderContext, parts []string, path string) (string, *Error) {
	if len(parts) != 2 {
		return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
	}
	if v, ok := ctx.overrides[parts[1]]; ok {
		return v, nil
	}
	if !ctx.declared[parts[1]] {
		return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("override %q is not declared by the profile", parts[1])}
	}
	return "", &Error{Reason: ReasonInvalidOverride, Msg: fmt.Sprintf("override %q has no value (no user value and no default)", parts[1])}
}

// resolveServiceVar resolves a service.<name> variable.
func resolveServiceVar(ctx *renderContext, parts []string, path string) (string, *Error) {
	if len(parts) != 2 {
		return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
	}
	if v, ok := ctx.service[parts[1]]; ok {
		return v, nil
	}
	return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
}

// resolveModelVar resolves a model.<name> variable; model.path is resolved
// per-role from the role's model:main mount.
func resolveModelVar(ctx *renderContext, parts []string, path string) (string, *Error) {
	if len(parts) != 2 {
		return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
	}
	if parts[1] == "path" {
		if ctx.role == nil {
			return "", &Error{Reason: ReasonPhaseViolation, Msg: fmt.Sprintf("variable %q is not available in this context", path)}
		}
		if ctx.role.modelPath == "" {
			return "", &Error{Reason: ReasonModelNotMounted, Msg: fmt.Sprintf("role %q references {{ model.path }} but declares no model:main mount", ctx.role.name)}
		}
		return ctx.role.modelPath, nil
	}
	if parts[1] == "credentialsPath" {
		if ctx.role == nil {
			return "", &Error{Reason: ReasonPhaseViolation, Msg: fmt.Sprintf("variable %q is not available in this context", path)}
		}
		if ctx.storageStrategy != aiv1alpha1.StorageStrategyS3 {
			return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("role %q references {{ model.credentialsPath }} but the model storage strategy is not S3", ctx.role.name)}
		}
		if !ctx.s3CredentialsSet {
			return "", &Error{Reason: ReasonModelCredentialsUnresolved, Msg: fmt.Sprintf("role %q references {{ model.credentialsPath }} but the ModelVersion sets no storage.s3.credentialsRef", ctx.role.name)}
		}
		ctx.role.usesCredentials = true
		return aiv1alpha1.ModelCredentialsFilePath, nil
	}
	if v, ok := ctx.model[parts[1]]; ok {
		return v, nil
	}
	return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
}

// resolveRouteVar resolves a route.<name> variable.
func resolveRouteVar(ctx *renderContext, parts []string, path string) (string, *Error) {
	if len(parts) != 2 {
		return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
	}
	if v, ok := ctx.route[parts[1]]; ok {
		return v, nil
	}
	return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
}

// resolveProfileVar resolves a profile.vars.<name> variable.
func resolveProfileVar(ctx *renderContext, parts []string, path string) (string, *Error) {
	if len(parts) == 3 && parts[1] == "vars" {
		if v, ok := ctx.profileVars[parts[2]]; ok {
			return v, nil
		}
	}
	return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
}

// resolveRoleVar resolves a role.<name> variable of the current role.
func resolveRoleVar(ctx *renderContext, path string) (string, *Error) {
	if ctx.role == nil {
		return "", &Error{Reason: ReasonPhaseViolation, Msg: fmt.Sprintf("variable %q is not available in this context", path)}
	}
	switch path {
	case "role.name":
		return ctx.role.name, nil
	case "role.group.size":
		if ctx.role.groupSize == "" {
			return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("role %q has no group size", ctx.role.name)}
		}
		return ctx.role.groupSize, nil
	}
	return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
}

// resolveRolesVar resolves a roles.<name>.serviceName variable.
func resolveRolesVar(ctx *renderContext, parts []string, path string) (string, *Error) {
	if len(parts) == 3 && parts[2] == "serviceName" {
		if v, ok := ctx.serviceNames[parts[1]]; ok {
			return v, nil
		}
	}
	return "", &Error{Reason: ReasonUnknownPlaceholder, Msg: fmt.Sprintf("unknown variable %q", path)}
}

// resolveReplicas renders a workload structure field (replicas or group size)
// and parses it as an integer. Only overrides.* is allowed in these fields.
func resolveReplicas(ctx *renderContext, roleName string, field *intstr.IntOrString, errs []Error) (int64, []Error) {
	if field == nil {
		return 1, errs // default replicas
	}
	if field.Type == intstr.Int {
		return int64(field.IntValue()), errs
	}
	rendered, renderErrs := renderString(ctx, field.StrVal, workloadAllowed)
	errs = append(errs, renderErrs...)
	if len(renderErrs) > 0 {
		return 0, errs
	}
	n, err := strconv.ParseInt(strings.TrimSpace(rendered), 10, 64)
	if err != nil {
		return 0, append(errs, Error{Reason: ReasonInvalidOverride, Msg: fmt.Sprintf("replicas of role %q does not resolve to an integer: %q", roleName, rendered)})
	}
	// The value lands in an int32 spec field (Deployment and LWS both use
	// *int32 for replicas and size); out-of-range values would wrap silently.
	if n > math.MaxInt32 || n < math.MinInt32 {
		return 0, append(errs, Error{Reason: ReasonInvalidOverride, Msg: fmt.Sprintf("replicas of role %q value %d exceeds the Kubernetes int32 range", roleName, n)})
	}
	return n, errs
}

// resolvePodAntiAffinity renders the profile's podAntiAffinity.policy template
// and validates the resolved token (design §3.2). Only overrides.* is allowed in
// this field, exactly like the workload structure fields: how a service spreads
// is a user knob, not something derived from the service. A profile that
// declares no podAntiAffinity renders empty — the controller then injects
// nothing — while a declared one whose policy is unset renders as "required",
// the behaviour of every profile written before the field existed.
func resolvePodAntiAffinity(ctx *renderContext, aa *aiv1alpha1.PodAntiAffinity, errs []Error) (string, []Error) {
	if aa == nil {
		return "", errs
	}
	rendered, renderErrs := renderString(ctx, string(aa.Policy), workloadAllowed)
	errs = append(errs, renderErrs...)
	if len(renderErrs) > 0 {
		return "", errs
	}
	policy := aiv1alpha1.PodAntiAffinityPolicy(strings.TrimSpace(rendered))
	switch policy {
	case "", aiv1alpha1.PodAntiAffinityPolicyRequired:
		return string(aiv1alpha1.PodAntiAffinityPolicyRequired), errs
	case aiv1alpha1.PodAntiAffinityPolicyPreferred, aiv1alpha1.PodAntiAffinityPolicyNone:
		return string(policy), errs
	default:
		return "", append(errs, Error{
			Reason: ReasonInvalidOverride,
			Msg:    fmt.Sprintf("podAntiAffinity.policy does not resolve to required, preferred or none: %q", rendered),
		})
	}
}

// nodeSelection is one rendered nodeSelector template: label key → accepted
// values, in input order and deduplicated. A key with one value becomes a
// nodeSelector entry; several values become a required nodeAffinity In term.
type nodeSelection map[string][]string

// resolveNodeSelector renders a nodeSelector template and parses the resolved
// value as one or more comma-separated key=value label pairs (design §3.2). It
// serves both the profile-level spec.nodeSelector (roleName == "") and a
// role's own nodeSelector (roleName != "", used in the error message). Only
// overrides.* is allowed in this field, like the workload structure fields and
// the placement policy: which nodes a service runs on is the fact the site
// brings to the profile, not something derived from the service or from the
// model. An empty resolved value — what a profile whose nodeSelector override
// carries the empty default gets — adds no selector at all, and so does an
// absent field. A stringList override resolves to several pairs, one per
// entry; commas are not legal in label values, so splitting on them is
// unambiguous. Each pair is checked with the same rules the apiserver applies
// to a pod's nodeSelector — content.IsLabelKey for the key and
// content.IsLabelValue for the value, the two functions pkg/util/validation
// re-exports as the deprecated IsQualifiedName and IsValidLabelValue: a pair
// that cannot be a node selector fails the render with InvalidOverride, so a
// typo surfaces on the Rendered condition instead of leaving every replica
// Pending on a node that can never match. That the key exists on some node is
// not checked here or anywhere else — the profile's accelerator.models
// constraint is matched by the scheduler too, not by the operator, which reads
// no Node.
func resolveNodeSelector(ctx *renderContext, roleName, field string, errs []Error) (nodeSelection, []Error) {
	if field == "" {
		return nil, errs
	}
	rendered, renderErrs := renderString(ctx, field, workloadAllowed)
	errs = append(errs, renderErrs...)
	if len(renderErrs) > 0 {
		return nil, errs
	}
	resolved := strings.TrimSpace(rendered)
	if resolved == "" {
		return nil, errs
	}
	subject := "nodeSelector"
	if roleName != "" {
		subject = fmt.Sprintf("role %q nodeSelector", roleName)
	}
	sel := make(nodeSelection)
	for item := range strings.SplitSeq(resolved, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		key, value, ok := strings.Cut(item, "=")
		if !ok || key == "" || value == "" {
			return nil, append(errs, Error{
				Reason: ReasonInvalidOverride,
				Msg:    fmt.Sprintf("%s does not resolve to a key=value label pair: %q", subject, item),
			})
		}
		if problems := content.IsLabelKey(key); len(problems) > 0 {
			return nil, append(errs, Error{
				Reason: ReasonInvalidOverride,
				Msg:    fmt.Sprintf("%s key %q is not a valid Kubernetes label key: %s", subject, key, problems[0]),
			})
		}
		if problems := content.IsLabelValue(value); len(problems) > 0 {
			return nil, append(errs, Error{
				Reason: ReasonInvalidOverride,
				Msg:    fmt.Sprintf("%s value %q is not a valid Kubernetes label value: %s", subject, value, problems[0]),
			})
		}
		if !slices.Contains(sel[key], value) {
			sel[key] = append(sel[key], value)
		}
	}
	return sel, errs
}

// renderPodTemplate renders the templated fields of a pod template: command,
// args, env[].value, nodeSelector values, labels values and annotations
// values (design §3.2: the full variable set is available in pod templates).
func renderPodTemplate(ctx *renderContext, pt aiv1alpha1.PodTemplate, errs []Error) (aiv1alpha1.PodTemplate, []Error) {
	render := func(s string) string {
		v, renderErrs := renderString(ctx, s, podTemplateAllowed)
		errs = append(errs, renderErrs...)
		return v
	}
	pt.Command = renderEach(pt.Command, render)
	pt.Args = renderEach(pt.Args, render)
	// Copy the env slice (and each value) before rendering: the renderer must
	// not mutate its input, whose env values share memory with pt.Env.
	pt.Env = append([]aiv1alpha1.EnvVar(nil), pt.Env...)
	for i := range pt.Env {
		if pt.Env[i].Value != nil {
			v := render(*pt.Env[i].Value)
			pt.Env[i].Value = &v
		}
	}
	pt.NodeSelector = renderMap(pt.NodeSelector, render)
	pt.Labels = renderMap(pt.Labels, render)
	pt.Annotations = renderMap(pt.Annotations, render)

	// gpuPerPod may be a template referencing overrides (e.g. the tensor-
	// parallel size of a profile whose pod must be granted as many GPUs as the
	// engine shards the model across). Resolve it to a concrete Int so
	// buildPodSpec reads a plain count. A plain-Int value is left as-is. Copy
	// the resources struct first: pt.Resources is shared with the input
	// profile and the renderer must not mutate it.
	if pt.Resources != nil && pt.Resources.GPUPerPod != nil && pt.Resources.GPUPerPod.Type == intstr.String {
		res := *pt.Resources
		rendered, renderErrs := renderString(ctx, pt.Resources.GPUPerPod.StrVal, podTemplateAllowed)
		errs = append(errs, renderErrs...)
		if len(renderErrs) == 0 {
			n, perr := strconv.ParseInt(strings.TrimSpace(rendered), 10, 64)
			if perr != nil || n < 1 {
				errs = append(errs, Error{Reason: ReasonInvalidOverride, Msg: fmt.Sprintf("gpuPerPod of role %q does not resolve to a positive integer: %q", ctx.role.name, rendered)})
			} else {
				v := intstr.FromInt32(int32(n))
				res.GPUPerPod = &v
				pt.Resources = &res
			}
		}
	}
	return pt, errs
}

func renderEach(items []string, render func(string) string) []string {
	out := make([]string, len(items))
	for i, s := range items {
		out[i] = render(s)
	}
	return out
}

func renderMap(m map[string]string, render func(string) string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = render(v)
	}
	return out
}

package renderer

import (
	"fmt"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/util/intstr"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	// modelMain is the model name of the primary model mount.
	modelMain = "main"
	// overridesNamespace is the variable namespace of the resolved overrides.
	overridesNamespace = "overrides"
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
}

// RenderedRole is one profile role with the workload structure resolved and
// the pod template's templated fields rendered. GroupSize is 0 for Deployments.
type RenderedRole struct {
	Name        string
	Replicas    int64
	GroupSize   int64
	PodTemplate aiv1alpha1.PodTemplate
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
	}

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
		ctx.role = roleV
		rr.PodTemplate, res.Errors = renderPodTemplate(ctx, rr.PodTemplate, res.Errors)
		res.Roles = append(res.Roles, rr)
	}
	ctx.role = nil

	// Assets: service-level context only. Errors from the overrides and role
	// phases accumulate into res.Errors; each asset string only appends.
	for _, asset := range profile.Spec.Assets {
		data := assetData[asset.Name]
		rendered := make(map[string]string, len(data))
		for k, v := range data {
			var errs []Error
			rendered[k], errs = renderString(ctx, v, assetAllowed)
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

func routeVars(route *aiv1alpha1.RouteSpec) map[string]string {
	if route == nil {
		return map[string]string{"publish": "false", "modelName": "", "timeoutSeconds": "60"}
	}
	timeout := "60"
	if route.TimeoutSeconds != nil {
		timeout = strconv.FormatInt(*route.TimeoutSeconds, 10)
	}
	return map[string]string{
		"publish":        strconv.FormatBool(route.Publish),
		"modelName":      route.ModelName,
		"timeoutSeconds": timeout,
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
	// role is the role currently being rendered; nil in service-level
	// contexts (asset data).
	role *roleVars
}

// roleVars are the role-level variables of the current role.
type roleVars struct {
	name      string
	groupSize string // "" for Deployment roles
	modelPath string // "" when the role declares no model:main mount
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
	return n, errs
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

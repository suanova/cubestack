package renderer

import (
	"fmt"
	"slices"
	"strings"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// validateUserEnvRoles reports every role a spec.env entry names that the
// profile does not declare.
func validateUserEnvRoles(profile *aiv1alpha1.InferenceRuntimeProfile, env []aiv1alpha1.UserEnvVar) []Error {
	known := make(map[string]bool, len(profile.Spec.Roles))
	for _, role := range profile.Spec.Roles {
		known[role.Name] = true
	}

	var errs []Error
	for _, e := range env {
		for _, role := range e.Roles {
			if !known[role] {
				errs = append(errs, Error{
					Reason: ReasonUnknownEnvRole,
					Msg:    fmt.Sprintf("env %q targets unknown role %q", e.Name, role),
				})
			}
		}
	}
	return errs
}

// mergeUserEnv applies the entries whose Roles contain role to pt: a same-name
// entry replaces the profile's value in place; new names are appended sorted
// by name so the spec's order does not affect the render. pt is the renderer's
// copy of the profile pod template, so the profile itself is not mutated.
func mergeUserEnv(pt *aiv1alpha1.PodTemplate, env []aiv1alpha1.UserEnvVar, role string) {
	position := make(map[string]int, len(pt.Env))
	for i, e := range pt.Env {
		position[e.Name] = i
	}

	var appended []aiv1alpha1.UserEnvVar
	for _, e := range env {
		if !slices.Contains(e.Roles, role) {
			continue
		}
		value := e.Value
		if i, ok := position[e.Name]; ok {
			pt.Env[i] = aiv1alpha1.EnvVar{Name: e.Name, Value: &value}
			continue
		}
		appended = append(appended, e)
	}

	slices.SortFunc(appended, func(a, b aiv1alpha1.UserEnvVar) int {
		return strings.Compare(a.Name, b.Name)
	})
	for _, e := range appended {
		value := e.Value
		pt.Env = append(pt.Env, aiv1alpha1.EnvVar{Name: e.Name, Value: &value})
	}
}

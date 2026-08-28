// Package renderer validates and renders the InferenceService template
// variables: override resolution and the {{ }} substitution engine.
package renderer

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/equality"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// ErrorReason is the condition Reason of a render failure.
type ErrorReason string

const (
	// ReasonUnknownOverride marks a user override key not declared by the profile.
	ReasonUnknownOverride ErrorReason = "UnknownOverride"
	// ReasonInvalidOverride marks an override value failing type, enum or range checks.
	ReasonInvalidOverride ErrorReason = "InvalidOverride"
	// ReasonPhaseViolation marks a known variable used in a context that forbids it.
	ReasonPhaseViolation ErrorReason = "PhaseViolation"
	// ReasonUnknownPlaceholder marks a template referencing an unknown variable.
	ReasonUnknownPlaceholder ErrorReason = "UnknownPlaceholder"
	// ReasonModelNotMounted marks {{ model.path }} in a role without a model mount.
	ReasonModelNotMounted ErrorReason = "ModelNotMounted"
)

// Error is a single render failure.
type Error struct {
	Reason ErrorReason
	Msg    string
}

// ResolveOverrides validates the user override values against the profile
// declarations and resolves them into canonical string form (integer → decimal,
// boolean → "true"/"false", string → verbatim). Declared overrides without a
// user value and without a Default are omitted; a template referencing one
// fails at render time.
func ResolveOverrides(declared []aiv1alpha1.Override, user map[string]apiextensionsv1.JSON) (map[string]string, []Error) {
	resolved := make(map[string]string)
	var errs []Error

	for _, ov := range declared {
		if raw, ok := user[ov.Name]; ok {
			value, err := validateValue(ov, raw)
			if err != nil {
				errs = append(errs, *err)
				continue
			}
			resolved[ov.Name] = value
			continue
		}
		if ov.Default != nil {
			value, err := validateValue(ov, *ov.Default)
			if err != nil {
				errs = append(errs, *err)
				continue
			}
			resolved[ov.Name] = value
		}
	}

	for name := range user {
		if !declaredContains(declared, name) {
			errs = append(errs, Error{Reason: ReasonUnknownOverride, Msg: fmt.Sprintf("override %q is not declared by the profile", name)})
		}
	}

	return resolved, errs
}

func declaredContains(declared []aiv1alpha1.Override, name string) bool {
	for _, ov := range declared {
		if ov.Name == name {
			return true
		}
	}
	return false
}

// validateValue checks one raw JSON value against the override declaration and
// returns its canonical string form.
func validateValue(ov aiv1alpha1.Override, raw apiextensionsv1.JSON) (string, *Error) {
	fail := func(msg string) (string, *Error) {
		return "", &Error{Reason: ReasonInvalidOverride, Msg: msg}
	}

	dec := json.NewDecoder(strings.NewReader(string(raw.Raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return fail(fmt.Sprintf("override %q is not valid JSON: %v", ov.Name, err))
	}

	var canonical string
	switch ov.Type {
	case aiv1alpha1.OverrideTypeInteger:
		num, ok := v.(json.Number)
		if !ok || !strings.ContainsAny(num.String(), "0123456789") || strings.ContainsAny(num.String(), ".eE") {
			return fail(fmt.Sprintf("override %q must be an integer", ov.Name))
		}
		n, err := num.Int64()
		if err != nil {
			return fail(fmt.Sprintf("override %q must be an integer", ov.Name))
		}
		if ov.Min != nil && n < *ov.Min {
			return fail(fmt.Sprintf("override %q value %d is below the minimum %d", ov.Name, n, *ov.Min))
		}
		if ov.Max != nil && n > *ov.Max {
			return fail(fmt.Sprintf("override %q value %d exceeds the maximum %d", ov.Name, n, *ov.Max))
		}
		canonical = strconv.FormatInt(n, 10)
	case aiv1alpha1.OverrideTypeString:
		s, ok := v.(string)
		if !ok {
			return fail(fmt.Sprintf("override %q must be a string", ov.Name))
		}
		canonical = s
	case aiv1alpha1.OverrideTypeBoolean:
		b, ok := v.(bool)
		if !ok {
			return fail(fmt.Sprintf("override %q must be a boolean", ov.Name))
		}
		canonical = strconv.FormatBool(b)
	}

	if len(ov.Enum) > 0 {
		if !enumContains(ov.Enum, v) {
			return fail(fmt.Sprintf("override %q value %v is not in the allowed enum", ov.Name, v))
		}
	}

	return canonical, nil
}

// enumContains compares semantically (1 equals 1.0), not by raw bytes. Both
// sides are decoded with UseNumber so numeric values compare as json.Number;
// two numbers are compared numerically, everything else via deep equality.
func enumContains(enum []apiextensionsv1.JSON, v any) bool {
	for _, item := range enum {
		var want any
		dec := json.NewDecoder(strings.NewReader(string(item.Raw)))
		dec.UseNumber()
		if err := dec.Decode(&want); err != nil {
			continue
		}
		if a, ok := v.(json.Number); ok {
			if b, ok := want.(json.Number); ok {
				av, aerr := a.Float64()
				bv, berr := b.Float64()
				if aerr == nil && berr == nil && av == bv {
					return true
				}
				continue
			}
		}
		if equality.Semantic.DeepEqual(v, want) {
			return true
		}
	}
	return false
}

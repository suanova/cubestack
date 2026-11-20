package controller

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// TestSetCustomizedConditionBoundsMessage guards the condition message against
// the CRD's 32768-character limit: spec.env allows 64 entries with 256-char
// names, so an unbounded message would make every status update fail.
func TestSetCustomizedConditionBoundsMessage(t *testing.T) {
	roles := make([]string, 16)
	for i := range roles {
		roles[i] = strings.Repeat("r", 63)
	}
	env := make([]aiv1alpha1.UserEnvVar, 64)
	for i := range env {
		env[i] = aiv1alpha1.UserEnvVar{Name: strings.Repeat("N", 256), Value: "x", Roles: roles}
	}

	var conditions []metav1.Condition
	setCustomizedCondition(&conditions, env)

	cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionCustomized)
	if cond == nil {
		t.Fatal("Customized condition missing")
	}
	if len(cond.Message) > 8192 {
		t.Fatalf("message length %d exceeds the 8192 bound", len(cond.Message))
	}
	if !strings.Contains(cond.Message, "more") {
		t.Fatalf("message lacks the omitted-entry count: %q", cond.Message)
	}
}

// TestSetCustomizedConditionShortMessage keeps the common path unsummarized.
func TestSetCustomizedConditionShortMessage(t *testing.T) {
	var conditions []metav1.Condition
	setCustomizedCondition(&conditions, []aiv1alpha1.UserEnvVar{{Name: "A", Value: "1", Roles: []string{testApplyRouterRole}}})

	cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionCustomized)
	if cond == nil {
		t.Fatal("Customized condition missing")
	}
	if want := "User environment overrides: A (router)"; cond.Message != want {
		t.Fatalf("message = %q, want %q", cond.Message, want)
	}
}

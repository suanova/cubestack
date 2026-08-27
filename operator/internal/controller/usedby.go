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

package controller

import (
	"cmp"
	"fmt"
	"slices"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// sortedUsedBy maps referencing InferenceServices to ObjectRef entries sorted
// by namespace and then name, keeping the rebuilt reverse index deterministic.
func sortedUsedBy(referrers []aiv1alpha1.InferenceService) []aiv1alpha1.ObjectRef {
	usedBy := make([]aiv1alpha1.ObjectRef, 0, len(referrers))
	for _, isvc := range referrers {
		usedBy = append(usedBy, aiv1alpha1.ObjectRef{Namespace: isvc.Namespace, Name: isvc.Name})
	}
	slices.SortFunc(usedBy, func(a, b aiv1alpha1.ObjectRef) int {
		if c := cmp.Compare(a.Namespace, b.Namespace); c != 0 {
			return c
		}
		return cmp.Compare(a.Name, b.Name)
	})
	return usedBy
}

// setInUseCondition sets the InUse condition from the rebuilt reverse index.
func setInUseCondition(conditions *[]metav1.Condition, usedBy []aiv1alpha1.ObjectRef) {
	if len(usedBy) == 0 {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionInUse,
			Status:  metav1.ConditionFalse,
			Reason:  "NotReferenced",
			Message: "Not referenced by any InferenceService",
		})
		return
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionInUse,
		Status:  metav1.ConditionTrue,
		Reason:  "ReferencedByServices",
		Message: fmt.Sprintf("Referenced by %d InferenceService", len(usedBy)),
	})
}

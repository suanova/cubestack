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
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// DefaultEndpointPortName is the endpoint Service port name when the profile
// does not declare one (design §3.3).
const DefaultEndpointPortName = "http"

// Reasons reported by checkEndpoint when the endpoint is not reachable.
const (
	EndpointRoleNotFound = "EndpointRoleNotFound"
	EndpointPortNotFound = "EndpointPortNotFound"
	EndpointNotReady     = "EndpointNotReady"
)

// endpointCheck reports the endpoint-role readiness: the internal endpoint
// string <svc>.<ns>.svc:<port> when reachable.
type endpointCheck struct {
	Internal string // "<isvc>-<role>.<ns>.svc:<port>", empty when not reachable
	Reason   string // EndpointRoleNotFound | EndpointPortNotFound | EndpointNotReady | ""
	Err      error  // API-level failure; the error result carries it to Reconcile (field is plan-mandated)
	Role     string // endpoint role name, for the EndpointReady condition message
}

// checkEndpoint verifies the endpoint role's Service exists with the
// endpoint.portName port (default http) and at least one ready backend
// endpoint (design §3.3 EndpointReady). API failures return a non-nil err.
func (r *InferenceServiceReconciler) checkEndpoint(ctx context.Context, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile) (*endpointCheck, error) {
	endpointRole := profile.Spec.Endpoint.Role
	check := &endpointCheck{Role: endpointRole}
	found := false
	for i := range profile.Spec.Roles {
		if profile.Spec.Roles[i].Name == endpointRole {
			found = true
			break
		}
	}
	if !found {
		check.Reason = EndpointRoleNotFound
		return check, nil
	}

	svc := &corev1.Service{}
	svcName := fmt.Sprintf("%s-%s", isvc.Name, endpointRole)
	err := r.Get(ctx, client.ObjectKey{Name: svcName, Namespace: isvc.Namespace}, svc)
	if apierrors.IsNotFound(err) {
		check.Reason = EndpointNotReady
		return check, nil
	}
	if err != nil {
		check.Err = err
		return check, err
	}

	portName := profile.Spec.Endpoint.PortName
	if portName == "" {
		portName = DefaultEndpointPortName
	}
	var port int32 = -1
	for _, p := range svc.Spec.Ports {
		if p.Name == portName {
			port = p.Port
			break
		}
	}
	if port == -1 {
		check.Reason = EndpointPortNotFound
		return check, nil
	}

	//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; the check reads ready backends from it (design §3.3).
	endpoints := &corev1.Endpoints{}
	err = r.Get(ctx, client.ObjectKey{Name: svcName, Namespace: isvc.Namespace}, endpoints)
	if apierrors.IsNotFound(err) {
		check.Reason = EndpointNotReady
		return check, nil
	}
	if err != nil {
		check.Err = err
		return check, err
	}
	for _, subset := range endpoints.Subsets {
		if len(subset.Addresses) > 0 {
			check.Internal = fmt.Sprintf("%s.%s.svc:%d", svcName, isvc.Namespace, port)
			return check, nil
		}
	}
	check.Reason = EndpointNotReady
	return check, nil
}

// setEndpointReadyCondition sets the EndpointReady condition from the check.
func setEndpointReadyCondition(conditions *[]metav1.Condition, check *endpointCheck) {
	if check.Internal != "" {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionEndpointReady,
			Status:  metav1.ConditionTrue,
			Reason:  "EndpointReady",
			Message: fmt.Sprintf("Internal endpoint %s is reachable", check.Internal),
		})
		return
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionEndpointReady,
		Status:  metav1.ConditionFalse,
		Reason:  check.Reason,
		Message: fmt.Sprintf("Internal endpoint of role %q is not reachable", check.Role),
	})
}

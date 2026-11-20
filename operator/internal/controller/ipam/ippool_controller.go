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

package ipam

import (
	"context"
	"fmt"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
	ipamutil "github.com/suanova/cubestack/internal/ipam"
)

// IPPoolReconciler reconciles an IPPool.
//
// Its whole job is to answer one question: is this pool usable as written? The
// answer goes in status.conditions and nowhere else. In particular there is no
// ledger of allocated addresses here — the set of IPClaims is the only
// authoritative record of who holds what, and a second list would be a second
// thing to keep in step.
//
// The pool's other declared invariant — that its band is disjoint from any other
// NAD serving the same subnet — is deliberately NOT checked. With the shared
// underlay NAD retired, there is no longer a live object to compare against, and
// the remaining overlap risk (an admin hand-writing a conflicting NAD) is bounded
// by RBAC instead: regular users cannot create NADs. What cannot be caught before
// the fact is caught after it, by the audit sweep.
type IPPoolReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ippools,verbs=get;list;watch
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ippools/status,verbs=get;patch;update

// Reconcile validates a pool and publishes the result.
//
// No requeue on any outcome. Nothing here is time-dependent, so the next change
// arrives as a watch event: the pool itself, or — through the IPClaim
// controller's watch on IPPool — the claims that depend on this verdict.
func (r *IPPoolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	pool := &ipamv1alpha1.IPPool{}
	if err := r.Get(ctx, req.NamespacedName, pool); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	original := pool.DeepCopy()

	available := metav1.Condition{
		Type:               ipamv1alpha1.ConditionAvailable,
		Status:             metav1.ConditionTrue,
		Reason:             ipamv1alpha1.ReasonRangeValid,
		ObservedGeneration: pool.Generation,
	}
	// A pool with no template mints nothing, so naming a subnet in the message
	// would point at a field the pool does not have.
	if tmpl := pool.Spec.NADTemplate; tmpl != nil {
		available.Message = fmt.Sprintf("range %s-%s in subnet %s is allocatable", pool.Spec.Range.Start, pool.Spec.Range.End, tmpl.Subnet)
	} else {
		available.Message = fmt.Sprintf("range %s-%s is allocatable", pool.Spec.Range.Start, pool.Spec.Range.End)
	}
	if err := ipamutil.ValidatePoolRange(pool.Spec); err != nil {
		// The CRD schema catches containment but cannot catch IP ordering, because
		// the CEL net library has no ordering overload on IP values. This is where
		// that gap is closed, and the gap is visible to users only through this
		// condition — a pool that fails here is still accepted by the API server.
		available.Status = metav1.ConditionFalse
		available.Reason = ipamv1alpha1.ReasonRangeInvalid
		available.Message = err.Error()
	}
	apimeta.SetStatusCondition(&pool.Status.Conditions, available)

	return ctrl.Result{}, patchStatusIfChanged(ctx, r.Client, original, pool, original.Status, pool.Status)
}

// SetupWithManager sets up the controller with the Manager.
//
// There is deliberately no watch on IPClaim here. A claim's lifecycle changes
// nothing about whether its pool is usable, so mapping claims to this controller
// would buy nothing and cost a reconcile of the pool on every claim in the
// cluster. The dependency runs the other way, and is handled on the other side:
// see IPClaimReconciler.claimsForPool.
func (r *IPPoolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&ipamv1alpha1.IPPool{}).
		Named("ippool").
		Complete(r)
}

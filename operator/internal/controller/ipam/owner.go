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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/utils/ptr"
)

// controllerRef builds the ownerReference that makes owner the controller of a
// dependent — a NAD owned by its IPClaim, the claim owned by whatever created it.
//
// This is metav1.NewControllerRef with blockOwnerDeletion left off, which is the
// difference that matters. blockOwnerDeletion makes an owner's deletion wait for
// its dependents to go, which is worth having when a dependent holds a finalizer.
// The one finalizer in this chain — the claim's, holding its address in the ledger
// until its NAD is gone — does not depend on it: the claim deletes its NAD itself
// before letting go, so the wait would buy nothing.
//
// It would not be free either. The API server enforces blockOwnerDeletion against
// whoever writes the reference, so turning it on would force this controller to
// hold delete permission on the very objects it serves. A tighter RBAC is worth
// more here than a guarantee nothing needs.
//
// Controller: true is kept, and is load-bearing for the ownership checks: it is
// what metav1.IsControlledBy looks for when the reconciler decides whether an
// existing NAD is this claim's to adopt, rewrite or delete (nadNameHeld, ensureNAD
// and the teardown), and what the audit's nadController reads to tell a NAD this
// operator minted from one another controller owns. The NAD watch does NOT depend
// on it: it maps a NAD to its claims by spec.nad, precisely so a NAD the claim was
// refused — and which therefore carries no reference to it — still wakes it.
func controllerRef(owner metav1.Object, gvk schema.GroupVersionKind) metav1.OwnerReference {
	return metav1.OwnerReference{
		APIVersion: gvk.GroupVersion().String(),
		Kind:       gvk.Kind,
		Name:       owner.GetName(),
		UID:        owner.GetUID(),
		Controller: ptr.To(true),
	}
}

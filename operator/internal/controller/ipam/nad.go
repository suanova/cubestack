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
	"errors"
	"fmt"
	"net/netip"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
	ipamutil "github.com/suanova/cubestack/internal/ipam"
)

// networkAttachmentDefinitionGVK is the Multus type this project mints per claim.
//
// Handled as unstructured rather than through the vendor's Go client. The object
// is one field — spec.config — and importing an API module for it would be a
// dependency for a string. This is the opposite call from the VirtualMachine,
// whose spec is far too large to shadow honestly, and the same call for the same
// reason: use unstructured whenever the typed view would be a partial one.
var networkAttachmentDefinitionGVK = schema.GroupVersionKind{
	Group:   "k8s.cni.cncf.io",
	Version: "v1",
	Kind:    "NetworkAttachmentDefinition",
}

// errNADNotOwned reports that the name in spec.nad is already held by an object
// this claim does not control. It is a sentinel so the reconciler can report it as
// the Ready condition's reason rather than as a generic error, which would be
// retried pointlessly forever.
var errNADNotOwned = errors.New("NAD name is already in use by an object this claim does not control")

func newNAD(namespace, name string) *unstructured.Unstructured {
	nad := &unstructured.Unstructured{}
	nad.SetGroupVersionKind(networkAttachmentDefinitionGVK)
	nad.SetNamespace(namespace)
	nad.SetName(name)
	return nad
}

// ensureNAD makes the per-claim NetworkAttachmentDefinition for a bound claim.
//
// The rendered config serves this claim's address and no other, as a literal static
// assignment. Everything else — bridge, DNS, routes — comes from the pool's
// template, which is why the pool has to be reachable here: the NAD is a function
// of the pool and the address, not of the environment that asked for it.
//
// Ownership is the pool of record for what this function may touch. An existing
// NAD is adopted only when it is already controller-owned by this claim, which is
// the ordinary case after a crash between the create and the status write.
// Anything else is somebody else's object and is reported, never overwritten: a
// name collision here means two claims believe they own one network, and silently
// taking it over would give the loser a VM with no network and no explanation.
func ensureNAD(ctx context.Context, c client.Client, claim *ipamv1alpha1.IPClaim, pool *ipamv1alpha1.IPPool, addr netip.Addr) error {
	rendered, err := ipamutil.RenderNAD(pool.Spec.NADTemplate, claim.Spec.NAD, addr)
	if err != nil {
		return err
	}

	existing := newNAD(claim.Namespace, claim.Spec.NAD)
	err = c.Get(ctx, client.ObjectKeyFromObject(existing), existing)
	switch {
	case apierrors.IsNotFound(err):
		return createNAD(ctx, c, claim, rendered)
	case err != nil:
		return fmt.Errorf("reading NAD %s/%s: %w", claim.Namespace, claim.Spec.NAD, err)
	}

	if !metav1.IsControlledBy(existing, claim) {
		return fmt.Errorf("%w: NAD %s/%s exists and %s", errNADNotOwned, claim.Namespace, claim.Spec.NAD, describeController(existing))
	}

	return reconcileNAD(ctx, c, existing, claim, rendered)
}

func createNAD(ctx context.Context, c client.Client, claim *ipamv1alpha1.IPClaim, rendered string) error {
	nad := newNAD(claim.Namespace, claim.Spec.NAD)
	nad.SetLabels(map[string]string{ipamv1alpha1.LabelClaim: ipamutil.ClaimLabelValue(claim.Name)})
	if err := unstructured.SetNestedField(nad.Object, rendered, "spec", "config"); err != nil {
		return fmt.Errorf("building NAD spec: %w", err)
	}

	// The owner is the claim, not the environment. That gives the chain
	// environment -> IPClaim -> NAD, so deleting the environment garbage-collects
	// the claim, which in turn collects the NAD. Nothing in that chain needs a finalizer, which is why there are
	// none: a finalizer would add a failure mode (a stuck object) to a job the
	// garbage collector already does correctly.
	owner := controllerRef(claim, ipamv1alpha1.GroupVersion.WithKind("IPClaim"))
	nad.SetOwnerReferences([]metav1.OwnerReference{owner})

	if err := c.Create(ctx, nad); err != nil {
		if apierrors.IsAlreadyExists(err) {
			// The Get above is served from a cache that can lag the API server, so a
			// name that looked free may not have been. Reported like any other
			// foreign object; the next reconcile reads it directly and decides
			// whether it is ours.
			return fmt.Errorf("%w: NAD %s/%s appeared while creating it", errNADNotOwned, claim.Namespace, claim.Spec.NAD)
		}
		return fmt.Errorf("creating NAD %s/%s: %w", claim.Namespace, claim.Spec.NAD, err)
	}
	return nil
}

// reconcileNAD brings an owned NAD back to its desired content.
//
// The whole config is replaced rather than compared key by key. The object is
// controller-owned by the claim, so its content is a function of the pool template,
// the pool's addressing and the assigned address — and a partial update would let
// a hand-edit survive in whichever fields we happened not to check. The cost is
// that a manual tweak to a live NAD is reverted; that is the standard contract for
// an object carrying a controller ownerReference.
func reconcileNAD(ctx context.Context, c client.Client, nad *unstructured.Unstructured, claim *ipamv1alpha1.IPClaim, rendered string) error {
	changed := false

	label := ipamutil.ClaimLabelValue(claim.Name)
	labels := nad.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	if labels[ipamv1alpha1.LabelClaim] != label {
		labels[ipamv1alpha1.LabelClaim] = label
		nad.SetLabels(labels)
		changed = true
	}

	current, found, err := unstructured.NestedString(nad.Object, "spec", "config")
	if err != nil {
		return fmt.Errorf("reading NAD %s/%s config: %w", nad.GetNamespace(), nad.GetName(), err)
	}
	if !found || current != rendered {
		if err := unstructured.SetNestedField(nad.Object, rendered, "spec", "config"); err != nil {
			return fmt.Errorf("building NAD spec: %w", err)
		}
		changed = true
	}

	if !changed {
		return nil
	}
	if err := c.Update(ctx, nad); err != nil {
		return fmt.Errorf("updating NAD %s/%s: %w", nad.GetNamespace(), nad.GetName(), err)
	}
	return nil
}

// describeController names an existing NAD's controller for an error message, so
// the reader can tell a stale claim of their own from an unrelated object.
func describeController(obj *unstructured.Unstructured) string {
	owner := metav1.GetControllerOf(obj)
	if owner == nil {
		return "has no controller owner"
	}
	return fmt.Sprintf("is controlled by %s %s/%s", owner.Kind, obj.GetNamespace(), owner.Name)
}

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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

// raceAssetDataKey is the data key of the raced asset copy.
const raceAssetDataKey = "start.sh"

// lostRaceClient simulates a reconcile that loses the create race for one
// ConfigMap: its first Get reports NotFound, and its first Create reports
// AlreadyExists after planting the winner's copy (what a concurrent winning
// reconcile would have written) in the underlying client.
type lostRaceClient struct {
	client.Client
	key         types.NamespacedName
	winner      *corev1.ConfigMap
	getServed   bool
	raceCreated bool
}

func (c *lostRaceClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if key.Name == c.key.Name && key.Namespace == c.key.Namespace && !c.getServed {
		c.getServed = true
		return apierrors.NewNotFound(schema.GroupResource{Resource: "configmaps"}, c.key.Name)
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

func (c *lostRaceClient) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if obj.GetName() == c.key.Name && obj.GetNamespace() == c.key.Namespace && !c.raceCreated {
		c.raceCreated = true
		if err := c.Client.Create(ctx, c.winner); err != nil {
			return err
		}
		return apierrors.NewAlreadyExists(schema.GroupResource{Resource: "configmaps"}, c.key.Name)
	}
	return c.Client.Create(ctx, obj, opts...)
}

var _ = Describe("provisionAssets", func() {
	var (
		scheme  *runtime.Scheme
		isvc    *aiv1alpha1.InferenceService
		profile *aiv1alpha1.InferenceRuntimeProfile
	)

	BeforeEach(func() {
		scheme = runtime.NewScheme()
		Expect(clientgoscheme.AddToScheme(scheme)).To(Succeed())
		Expect(aiv1alpha1.AddToScheme(scheme)).To(Succeed())

		isvc = &aiv1alpha1.InferenceService{
			ObjectMeta: metav1.ObjectMeta{Name: "svc-race", Namespace: "team-a", UID: "uid-1"},
		}
		profile = &aiv1alpha1.InferenceRuntimeProfile{Spec: aiv1alpha1.InferenceRuntimeProfileSpec{
			Assets: []aiv1alpha1.Asset{{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "metax-v0.1.0"}}},
		}}
	})

	It("recovers when a concurrent reconcile wins the copy create race", func() {
		copyName := types.NamespacedName{Name: isvc.Name + "-bootstrap", Namespace: isvc.Namespace}
		// The winner planted an owned copy with stale rendered data before this
		// reconcile's create attempt; the loser must sync it, not fail.
		winner := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      copyName.Name,
				Namespace: copyName.Namespace,
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: aiv1alpha1.GroupVersion.String(), Kind: "InferenceService",
					Name: isvc.Name, UID: isvc.UID, Controller: ptrTo(true),
				}},
			},
			Data: map[string]string{raceAssetDataKey: "stale"},
		}
		inner := fake.NewClientBuilder().WithScheme(scheme).Build()
		r := &InferenceServiceReconciler{Client: &lostRaceClient{Client: inner, key: copyName, winner: winner}, Scheme: scheme}
		rendered := &renderer.Result{Assets: map[string]map[string]string{testAssetName: {raceAssetDataKey: "fresh"}}}

		statuses, err := r.provisionAssets(context.Background(), isvc, profile, rendered)
		Expect(err).NotTo(HaveOccurred())
		Expect(statuses).To(HaveLen(1))
		Expect(statuses[0].Name).To(Equal(testAssetName))

		got := &corev1.ConfigMap{}
		Expect(inner.Get(context.Background(), copyName, got)).To(Succeed())
		Expect(got.Data).To(Equal(map[string]string{"start.sh": "fresh"}), "the stale winner copy must be synced to the rendered data")
		Expect(got.Labels[managedByLabelKey]).To(Equal(managedByValue))
		Expect(metav1.GetControllerOf(got).UID).To(Equal(isvc.UID))
	})
})

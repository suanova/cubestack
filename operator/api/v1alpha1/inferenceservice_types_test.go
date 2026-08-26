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

package v1alpha1

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	testModelVersion = "w8a8-v1"
	testRouterRole   = "router"
	testPrefillRole  = "prefill"
	testNamespace    = "default"
	testModelRef     = "deepseek-v4-flash-w8a8-v1"
	testProfileRef   = "metax-sglang-dsv4-pd"
)

func validInferenceService(name string) *InferenceService {
	return &InferenceService{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: InferenceServiceSpec{
			ModelRef:   testModelRef,
			ProfileRef: testProfileRef,
			Overrides: map[string]apiextensionsv1.JSON{
				"prefillReplicas": {Raw: []byte("1")},
				"decodeReplicas":  {Raw: []byte("2")},
				"maxModelLen":     {Raw: []byte("131072")},
			},
			Route: &RouteSpec{
				Publish:        true,
				ModelName:      "dsv4-flash",
				TimeoutSeconds: ptrTo(int64(60)),
			},
		},
	}
}

var _ = Describe("InferenceService", func() {
	Context("valid objects", func() {
		It("accepts a published service and round-trips its spec", func() {
			isvc := validInferenceService("isvc-published")

			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())

			got := &InferenceService{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
			Expect(got.Spec).To(Equal(isvc.Spec))

			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())
		})

		It("accepts an unpublished service without route", func() {
			isvc := validInferenceService("isvc-internal")
			isvc.Spec.Overrides = nil
			isvc.Spec.Route = nil

			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())

			got := &InferenceService{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
			Expect(got.Spec.Route).To(BeNil())
			Expect(got.Spec.Overrides).To(BeEmpty())

			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())
		})

		It("defaults route publish to false and timeoutSeconds to 60", func() {
			isvc := validInferenceService("isvc-defaults")
			isvc.Spec.Route = &RouteSpec{ModelName: "dsv4-flash"}

			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())

			got := &InferenceService{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
			Expect(got.Spec.Route.Publish).To(BeFalse())
			Expect(*got.Spec.Route.TimeoutSeconds).To(Equal(int64(60)))

			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())
		})

		//nolint:dupl // status subresource round-trip mirrors the other CRD tests
		It("updates status through the status subresource", func() {
			isvc := validInferenceService("isvc-status")
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())

			isvc.Status.ObservedGeneration = 3
			isvc.Status.Profile = &ProfileStatus{Name: testProfileRef, Revision: "a1b2c3"}
			isvc.Status.Model = &ModelStatus{Name: testModelName, Version: testModelVersion}
			isvc.Status.Conditions = []metav1.Condition{{
				Type:               ConditionResolved,
				Status:             metav1.ConditionTrue,
				Reason:             "Resolved",
				Message:            "references resolved",
				LastTransitionTime: metav1.Now(),
			}}
			isvc.Status.Roles = []RoleStatus{
				{
					Name:          testRouterRole,
					Kind:          WorkloadKindDeployment,
					Replicas:      1,
					WorkloadName:  "isvc-status-router",
					ServiceName:   "isvc-status-router",
					ReadyReplicas: 1,
					Ready:         true,
				},
				{
					Name:          testPrefillRole,
					Kind:          WorkloadKindLeaderWorkerSet,
					Replicas:      1,
					GroupSize:     ptrTo(int64(1)),
					WorkloadName:  "isvc-status-prefill",
					ServiceName:   "isvc-status-prefill",
					ReadyReplicas: 1,
					Ready:         true,
				},
			}
			isvc.Status.Endpoint = &EndpointStatus{
				Internal: "isvc-status-router.project-a.svc:8001",
				Public:   "https://dsv4-flash.maas.example.com",
			}
			isvc.Status.Assets = []AssetStatus{{
				Name:   "runtime-config",
				Source: "metax-dsv4-runtime-v0.5.12-rc1",
				Hash:   "sha256:9f2c",
			}}
			Expect(k8sClient.Status().Update(ctx, isvc)).To(Succeed())

			got := &InferenceService{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
			Expect(got.Status.ObservedGeneration).To(Equal(int64(3)))
			Expect(got.Status.Profile.Name).To(Equal(testProfileRef))
			Expect(got.Status.Model.Name).To(Equal(testModelName))
			Expect(got.Status.Conditions).To(HaveLen(1))
			Expect(got.Status.Roles).To(HaveLen(2))
			Expect(got.Status.Roles[1].GroupSize).NotTo(BeNil())
			Expect(got.Status.Roles[0].GroupSize).To(BeNil())
			Expect(got.Status.Endpoint.Internal).To(Equal("isvc-status-router.project-a.svc:8001"))
			Expect(got.Status.Assets).To(HaveLen(1))

			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())
		})
	})

	Context("L0 validation", func() {
		DescribeTable("rejects invalid objects",
			func(name string, mutate func(*InferenceServiceSpec), wantMessage string) {
				isvc := validInferenceService(name)
				mutate(&isvc.Spec)

				err := k8sClient.Create(ctx, isvc)
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				if wantMessage != "" {
					Expect(err.Error()).To(ContainSubstring(wantMessage))
				}
			},
			Entry("missing modelRef",
				"isvc-invalid-missing-model-ref",
				func(s *InferenceServiceSpec) { s.ModelRef = "" },
				"spec.modelRef"),
			Entry("missing profileRef",
				"isvc-invalid-missing-profile-ref",
				func(s *InferenceServiceSpec) { s.ProfileRef = "" },
				"spec.profileRef"),
			Entry("modelRef with uppercase",
				"isvc-invalid-model-ref-case",
				func(s *InferenceServiceSpec) { s.ModelRef = "DeepSeek-V4" },
				"spec.modelRef"),
			Entry("modelRef with underscore",
				"isvc-invalid-model-ref-underscore",
				func(s *InferenceServiceSpec) { s.ModelRef = testModelArchitecture },
				"spec.modelRef"),
			Entry("profileRef with trailing dash",
				"isvc-invalid-profile-ref-dash",
				func(s *InferenceServiceSpec) { s.ProfileRef = "metax-sglang-" },
				"spec.profileRef"),
			Entry("modelName with uppercase",
				"isvc-invalid-model-name-case",
				func(s *InferenceServiceSpec) { s.Route.ModelName = "DsV4" },
				"spec.route.modelName"),
			Entry("modelName with dot",
				"isvc-invalid-model-name-dot",
				func(s *InferenceServiceSpec) { s.Route.ModelName = "dsv4.flash" },
				"spec.route.modelName"),
			Entry("timeoutSeconds zero",
				"isvc-invalid-timeout-zero",
				func(s *InferenceServiceSpec) { *s.Route.TimeoutSeconds = 0 },
				"spec.route.timeoutSeconds"),
			Entry("timeoutSeconds too large",
				"isvc-invalid-timeout-large",
				func(s *InferenceServiceSpec) { *s.Route.TimeoutSeconds = 86401 },
				"spec.route.timeoutSeconds"),
		)
	})
})

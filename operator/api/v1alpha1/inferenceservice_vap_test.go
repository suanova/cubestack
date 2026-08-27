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
	"path/filepath"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// isvcVAPPath is the L1 ValidatingAdmissionPolicy manifest for
// InferenceService, loaded from config/vap so the tests exercise the
// deployed artifact rather than a duplicate definition.
var isvcVAPPath = filepath.Join("..", "..", "config", "vap", "inferenceservice_policy.yaml")

// isvcVAPProbeName is an InferenceService that publishes without a
// route.modelName, used to detect whether the InferenceService VAP is
// currently enforcing.
const isvcVAPProbeName = "vap-probe-isvc"

// probeISVCVAPRejects reports whether the InferenceService VAP is currently
// enforcing: it creates a published service whose route omits modelName,
// which the VAP must reject. Returns false (and cleans up) while the VAP is
// not yet active or already removed, since VAP enforcement is registered
// asynchronously by the apiserver.
func probeISVCVAPRejects() bool {
	probe := validInferenceService(isvcVAPProbeName)
	probe.Spec.Route = &RouteSpec{Publish: true}
	err := k8sClient.Create(ctx, probe)
	if err == nil {
		Expect(k8sClient.Delete(ctx, probe)).To(Succeed())
		return false
	}
	if apierrors.IsAlreadyExists(err) {
		Expect(k8sClient.Delete(ctx, probe)).To(Succeed())
		return false
	}
	return true
}

// setupISVCVAP creates the InferenceService VAP and its binding from the
// manifest, deleting any leftover from a previous run first, and waits until
// the VAP is actually enforced.
func setupISVCVAP() {
	objs, err := loadVAPObjects(isvcVAPPath)
	Expect(err).NotTo(HaveOccurred())
	Expect(objs).To(HaveLen(2), "expected VAP and binding in %s", isvcVAPPath)

	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}
	for _, obj := range objs {
		Expect(k8sClient.Create(ctx, obj)).To(Succeed())
	}

	Eventually(probeISVCVAPRejects, "15s", "200ms").Should(BeTrue(), "InferenceService VAP did not become enforcing")
}

// cleanupISVCVAP deletes the InferenceService VAP and its binding and waits
// until enforcement stops, so the L0 tests (which create services without
// modelName) are unaffected regardless of spec order.
func cleanupISVCVAP() {
	objs, err := loadVAPObjects(isvcVAPPath)
	Expect(err).NotTo(HaveOccurred())
	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}

	Eventually(probeISVCVAPRejects, "15s", "200ms").Should(BeFalse(), "InferenceService VAP is still enforcing after removal")
}

var _ = Describe("InferenceService L1 admission", func() {
	Context("route modelName", func() {
		It("rejects a published service without route.modelName", func() {
			setupISVCVAP()
			defer cleanupISVCVAP()

			isvc := validInferenceService("published-no-name")
			isvc.Spec.Route = &RouteSpec{Publish: true}
			err := k8sClient.Create(ctx, isvc)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("route.modelName is required"))
		})

		It("rejects updating a service to publish without route.modelName", func() {
			isvc := validInferenceService("update-to-publish")
			isvc.Spec.Route = &RouteSpec{Publish: false}
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			setupISVCVAP()
			defer cleanupISVCVAP()

			isvc.Spec.Route.Publish = true
			err := k8sClient.Update(ctx, isvc)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("route.modelName is required"))
		})

		It("accepts a published service with route.modelName", func() {
			setupISVCVAP()
			defer cleanupISVCVAP()

			isvc := validInferenceService("published-with-name")
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())
		})

		It("accepts an unpublished service without route.modelName", func() {
			setupISVCVAP()
			defer cleanupISVCVAP()

			isvc := validInferenceService("unpublished-no-name")
			isvc.Spec.Route = &RouteSpec{Publish: false}
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())
		})

		It("accepts a service without route", func() {
			setupISVCVAP()
			defer cleanupISVCVAP()

			isvc := validInferenceService("no-route")
			isvc.Spec.Route = nil
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())
		})
	})
})

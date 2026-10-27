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
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// devEnvironmentVAPPath is the L1 ValidatingAdmissionPolicy manifest for
// DevEnvironment, loaded from config/vap so the tests exercise the deployed
// artifact rather than a duplicate definition.
var devEnvironmentVAPPath = filepath.Join("..", "..", "config", "vap", "devenvironment_policy.yaml")

// devEnvironmentVAPProbeName carries a dot: a name a DNS-1123 subdomain admits
// and a DNS-1035 label does not.
const devEnvironmentVAPProbeName = "vap-probe.env"

// probeDevEnvironmentVAPRejects reports whether the DevEnvironment VAP is
// currently enforcing: it creates a dotted-name DevEnvironment, which the VAP
// must reject. Returns false (and cleans up) while the VAP is not yet active or
// already removed, since VAP enforcement is registered asynchronously by the
// apiserver.
//
// Unlike the ModelVersion probe, any Invalid error is not enough: the error has
// to name the rule, so a fixture the schema refuses on its own cannot read as
// an enforcing policy.
func probeDevEnvironmentVAPRejects() bool {
	probe := validDevEnvironment(devEnvironmentVAPProbeName)
	err := k8sClient.Create(ctx, probe)
	if err == nil || apierrors.IsAlreadyExists(err) {
		Expect(k8sClient.Delete(ctx, probe)).To(Succeed())
		return false
	}
	return apierrors.IsInvalid(err) && strings.Contains(err.Error(), "DNS-1035")
}

// setupDevEnvironmentVAP creates the DevEnvironment VAP and its binding from
// the manifest, deleting any leftover from a previous run first, and waits until
// the VAP is actually enforced.
func setupDevEnvironmentVAP() {
	objs, err := loadVAPObjects(devEnvironmentVAPPath)
	Expect(err).NotTo(HaveOccurred())
	Expect(objs).To(HaveLen(2), "expected VAP and binding in %s", devEnvironmentVAPPath)

	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}
	for _, obj := range objs {
		Expect(k8sClient.Create(ctx, obj)).To(Succeed())
	}

	Eventually(probeDevEnvironmentVAPRejects, "15s", "200ms").Should(BeTrue(), "DevEnvironment VAP did not become enforcing")
}

// cleanupDevEnvironmentVAP deletes the DevEnvironment VAP and its binding and
// waits until enforcement stops, so the L0 tests are unaffected regardless of
// spec order.
func cleanupDevEnvironmentVAP() {
	objs, err := loadVAPObjects(devEnvironmentVAPPath)
	Expect(err).NotTo(HaveOccurred())
	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}

	Eventually(probeDevEnvironmentVAPRejects, "15s", "200ms").Should(BeFalse(), "DevEnvironment VAP is still enforcing after removal")
}

var _ = Describe("DevEnvironment L1 admission", func() {
	Context("name constraint", func() {
		It("rejects a name containing a dot", func() {
			setupDevEnvironmentVAP()
			defer cleanupDevEnvironmentVAP()

			de := validDevEnvironment("de.with.dots")
			err := k8sClient.Create(ctx, de)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("DNS-1035 label"))
		})

		It("rejects a name starting with a digit", func() {
			// A DNS-1123 label admits this; the Service the environment is named
			// after does not, so the rule has to as well.
			setupDevEnvironmentVAP()
			defer cleanupDevEnvironmentVAP()

			de := validDevEnvironment("9lives")
			err := k8sClient.Create(ctx, de)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("DNS-1035 label"))
		})

		It("rejects a name longer than 63 characters", func() {
			setupDevEnvironmentVAP()
			defer cleanupDevEnvironmentVAP()

			de := validDevEnvironment(strings.Repeat("a", 64))
			err := k8sClient.Create(ctx, de)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("63 characters"))
		})

		It("accepts a DNS-1035 name", func() {
			setupDevEnvironmentVAP()
			defer cleanupDevEnvironmentVAP()

			de := validDevEnvironment("de-vap-ok")
			Expect(k8sClient.Create(ctx, de)).To(Succeed())
			Expect(k8sClient.Delete(ctx, de)).To(Succeed())
		})

		It("allows updating a pre-existing object whose name the rule refuses", func() {
			// Created before the policy exists, like an object from an older
			// install: the name rule is CREATE-only, so metadata stays writable.
			de := validDevEnvironment("legacy.name")
			Expect(k8sClient.Create(ctx, de)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, de) }()

			setupDevEnvironmentVAP()
			defer cleanupDevEnvironmentVAP()

			de.Annotations = map[string]string{testAnnotationKey: testMaintenanceAnnotation}
			Expect(k8sClient.Update(ctx, de)).To(Succeed())
		})
	})
})

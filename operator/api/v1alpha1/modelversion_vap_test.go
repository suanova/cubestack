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
	"io"
	"os"
	"path/filepath"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// modelVersionVAPPath is the L1 ValidatingAdmissionPolicy manifest for
// ModelVersion, loaded from config/vap so the tests exercise the deployed
// artifact rather than a duplicate definition.
var modelVersionVAPPath = filepath.Join("..", "..", "config", "vap", "modelversion_policy.yaml")

// loadVAPObjects reads a multi-document VAP manifest and returns its
// ValidatingAdmissionPolicy and ValidatingAdmissionPolicyBinding objects.
func loadVAPObjects(path string) ([]client.Object, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	var objs []client.Object
	dec := yaml.NewYAMLOrJSONDecoder(f, 4096)
	for {
		var u unstructured.Unstructured
		if err := dec.Decode(&u); err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		if len(u.Object) == 0 {
			continue
		}
		switch u.GetKind() {
		case "ValidatingAdmissionPolicy":
			var vap admissionregistrationv1.ValidatingAdmissionPolicy
			if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, &vap); err != nil {
				return nil, err
			}
			objs = append(objs, &vap)
		case "ValidatingAdmissionPolicyBinding":
			var binding admissionregistrationv1.ValidatingAdmissionPolicyBinding
			if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, &binding); err != nil {
				return nil, err
			}
			objs = append(objs, &binding)
		}
	}
	return objs, nil
}

// vapProbeName is a ModelVersion whose name intentionally does not match its
// spec, used to detect whether the VAP is currently enforcing.
const vapProbeName = "vap-probe-mismatch"

// probeVAPRejects reports whether the ModelVersion VAP is currently enforcing:
// it creates a name-mismatched ModelVersion, which the VAP must reject.
// Returns false (and cleans up) while the VAP is not yet active or already
// removed, since VAP enforcement is registered asynchronously by the
// apiserver.
func probeVAPRejects() bool {
	probe := validModelVersion(vapProbeName)
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

// setupModelVersionVAP creates the ModelVersion VAP and its binding from the
// manifest, deleting any leftover from a previous run first, and waits until
// the VAP is actually enforced.
func setupModelVersionVAP() {
	objs, err := loadVAPObjects(modelVersionVAPPath)
	Expect(err).NotTo(HaveOccurred())
	Expect(objs).To(HaveLen(2), "expected VAP and binding in %s", modelVersionVAPPath)

	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}
	for _, obj := range objs {
		Expect(k8sClient.Create(ctx, obj)).To(Succeed())
	}

	Eventually(probeVAPRejects, "15s", "200ms").Should(BeTrue(), "ModelVersion VAP did not become enforcing")
}

// cleanupModelVersionVAP deletes the ModelVersion VAP and its binding and
// waits until enforcement stops, so the L0 tests (which use arbitrary object
// names) are unaffected regardless of spec order.
func cleanupModelVersionVAP() {
	objs, err := loadVAPObjects(modelVersionVAPPath)
	Expect(err).NotTo(HaveOccurred())
	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}

	Eventually(probeVAPRejects, "15s", "200ms").Should(BeFalse(), "ModelVersion VAP is still enforcing after removal")
}

func validModelVersionWithMatchingName() *ModelVersion {
	return validModelVersion(testModelName + "-" + testModelVersion)
}

var _ = Describe("ModelVersion L1 admission", func() {
	Context("name binding", func() {
		It("rejects a ModelVersion whose name does not match <model>-<version>", func() {
			setupModelVersionVAP()
			defer cleanupModelVersionVAP()

			mv := validModelVersion("mismatched-name")
			err := k8sClient.Create(ctx, mv)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("metadata.name must equal"))
		})

		It("accepts a ModelVersion whose name matches <model>-<version>", func() {
			setupModelVersionVAP()
			defer cleanupModelVersionVAP()

			mv := validModelVersionWithMatchingName()
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			Expect(k8sClient.Delete(ctx, mv)).To(Succeed())
		})
	})

	Context("spec immutability", func() {
		It("rejects updating spec", func() {
			setupModelVersionVAP()
			defer cleanupModelVersionVAP()

			mv := validModelVersionWithMatchingName()
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			mv.Spec.Meta = map[string]string{testLauncherSpecKey: "changed"}
			err := k8sClient.Update(ctx, mv)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("spec is immutable"))
		})

		It("allows updating annotations", func() {
			setupModelVersionVAP()
			defer cleanupModelVersionVAP()

			mv := validModelVersionWithMatchingName()
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			mv.Annotations = map[string]string{"note": "maintenance"}
			Expect(k8sClient.Update(ctx, mv)).To(Succeed())
		})

		It("allows updating annotations on a pre-existing name-mismatched ModelVersion", func() {
			// The object is created before the VAP exists, simulating a
			// legacy object created under an older policy; the name binding
			// must not block metadata-only updates of it.
			mv := validModelVersion("legacy-name")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			setupModelVersionVAP()
			defer cleanupModelVersionVAP()

			mv.Annotations = map[string]string{"note": "maintenance"}
			Expect(k8sClient.Update(ctx, mv)).To(Succeed())

			mv.Spec.Meta = map[string]string{testLauncherSpecKey: "changed"}
			err := k8sClient.Update(ctx, mv)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("spec is immutable"))
		})

		It("allows deleting a ModelVersion", func() {
			setupModelVersionVAP()
			defer cleanupModelVersionVAP()

			mv := validModelVersionWithMatchingName()
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			Expect(k8sClient.Delete(ctx, mv)).To(Succeed())
		})
	})
})

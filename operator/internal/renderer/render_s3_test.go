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

package renderer

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// s3RenderModel builds a ModelVersion with S3 storage; creds names the
// credentialsRef, "" means anonymous.
func s3RenderModel(creds bool) *aiv1alpha1.ModelVersion {
	m := renderModel()
	m.Spec.Storage = aiv1alpha1.ModelStorage{
		Strategy: aiv1alpha1.StorageStrategyS3,
		S3: &aiv1alpha1.S3Storage{
			URI: "s3://model-registry/deepseek-v4-flash/w8a8-v1",
		},
	}
	if creds {
		m.Spec.Storage.S3.CredentialsRef = &aiv1alpha1.S3CredentialsRef{Name: "s3-model-registry-ro"}
	}
	return m
}

var _ = Describe("Render (S3 strategy)", func() {
	It("resolves model.path to the uri and model.credentialsPath to the fixed file", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Mounts = nil
		p.Spec.Roles[0].PodTemplate.Env = []aiv1alpha1.EnvVar{
			envValue("MODEL_PATH", "{{ model.path }}"),
			envValue("CREDS_FILE", "{{ model.credentialsPath }}"),
		}
		res := Render(renderISVC(), p, s3RenderModel(true), nil)
		Expect(res.Errors).To(BeEmpty())
		router := res.Roles[0]
		Expect(*router.PodTemplate.Env[0].Value).To(Equal("s3://model-registry/deepseek-v4-flash/w8a8-v1"))
		Expect(*router.PodTemplate.Env[1].Value).To(Equal(aiv1alpha1.ModelCredentialsFilePath))
		// The role referenced the credentials variable: the volume injection
		// must target it (design §4.5).
		Expect(router.UsesCredentials).To(BeTrue())
	})

	It("rejects {{ model.credentialsPath }} when the S3 ModelVersion sets no credentialsRef", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Mounts = nil
		p.Spec.Roles[0].PodTemplate.Env = []aiv1alpha1.EnvVar{
			envValue("CREDS_FILE", "{{ model.credentialsPath }}"),
		}
		res := Render(renderISVC(), p, s3RenderModel(false), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonModelCredentialsUnresolved))
		Expect(res.Roles[0].UsesCredentials).To(BeFalse())
	})

	It("rejects {{ model.credentialsPath }} for non-S3 model storage", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Mounts = nil
		p.Spec.Roles[0].PodTemplate.Env = []aiv1alpha1.EnvVar{
			envValue("CREDS_FILE", "{{ model.credentialsPath }}"),
		}
		res := Render(renderISVC(), p, renderModel(), nil) // no storage strategy
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonUnknownPlaceholder))
		Expect(res.Errors[0].Msg).To(ContainSubstring("not S3"))
	})

	It("keeps model.path mount-free for S3 roles (no ModelNotMounted)", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Mounts = nil
		p.Spec.Roles[0].PodTemplate.Env = []aiv1alpha1.EnvVar{
			envValue("MODEL_PATH", "{{ model.path }}"),
		}
		res := Render(renderISVC(), p, s3RenderModel(false), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(*res.Roles[0].PodTemplate.Env[0].Value).To(Equal("s3://model-registry/deepseek-v4-flash/w8a8-v1"))
	})

	It("keeps {{ model.credentialsPath }} out of the service-level asset context", func() {
		p := renderProfile()
		asset := p.Spec.Assets[0]
		res := Render(renderISVC(), p, s3RenderModel(true),
			map[string]map[string]string{asset.Name: {assetDataKey: "{{ model.credentialsPath }}"}})
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonPhaseViolation))
	})
})

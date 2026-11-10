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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func validDataset(name string) *Dataset {
	size := resource.MustParse("1.2Gi")
	records := int64(120000)
	return &Dataset{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: DatasetSpec{
			Dataset:     "demo-dataset",
			Version:     "v1.0.0",
			Format:      "Parquet",
			Size:        &size,
			RecordCount: &records,
			Storage: DatasetStorage{
				Strategy: StorageStrategyS3,
				S3:       &S3Storage{URI: "s3://datasets/demo-dataset/v1.0.0"},
			},
		},
	}
}

var _ = Describe("Dataset", func() {
	It("accepts a Dataset and round-trips its spec", func() {
		ds := validDataset("ds-roundtrip")

		Expect(k8sClient.Create(ctx, ds)).To(Succeed())

		got := &Dataset{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: ds.Name}, got)).To(Succeed())
		Expect(got.Spec).To(Equal(ds.Spec))

		Expect(k8sClient.Delete(ctx, ds)).To(Succeed())
	})

	DescribeTable("rejects invalid objects",
		func(name string, mutate func(*DatasetSpec), wantMessage string) {
			ds := validDataset(name)
			mutate(&ds.Spec)

			err := k8sClient.Create(ctx, ds)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			if wantMessage != "" {
				Expect(err.Error()).To(ContainSubstring(wantMessage))
			}
		},
		Entry("missing dataset",
			"ds-invalid-missing-dataset",
			func(s *DatasetSpec) { s.Dataset = "" },
			"spec.dataset"),
		Entry("missing version",
			"ds-invalid-missing-version",
			func(s *DatasetSpec) { s.Version = "" },
			"spec.version"),
		Entry("missing format",
			"ds-invalid-missing-format",
			func(s *DatasetSpec) { s.Format = "" },
			"spec.format"),
		Entry("negative record count",
			"ds-invalid-record-count",
			func(s *DatasetSpec) { v := int64(-1); s.RecordCount = &v },
			"spec.recordCount"),
		Entry("two storage blocks",
			"ds-invalid-storage",
			func(s *DatasetSpec) {
				s.Storage.HostPath = &HostPathStorage{Path: "/workspace/dataset"}
			},
			"Exactly one of hostPath, dynamic, static, or s3"),
	)
})

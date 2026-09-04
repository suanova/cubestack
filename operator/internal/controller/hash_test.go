package controller

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

func podSpecWithImage(image string) corev1.PodSpec {
	return corev1.PodSpec{Containers: []corev1.Container{{Name: "main", Image: image}}}
}

var _ = Describe("templateHashAnnotations", func() {
	model := func() *aiv1alpha1.ModelVersion {
		return &aiv1alpha1.ModelVersion{Spec: aiv1alpha1.ModelVersionSpec{
			Model: "m", Version: "v1",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyDynamic,
				Dynamic: &aiv1alpha1.DynamicStorage{
					StorageClassName: "shared", SubPath: "m/v1",
					Capacity: resource.MustParse("1Ti"),
				},
			},
		}}
	}

	It("is stable for identical inputs", func() {
		assets := map[string]map[string]string{"runtime-config": {"K": "v"}}
		a1 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, map[string]string{"replicas": "2"}, assets, model(), true)
		a2 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, map[string]string{"replicas": "2"}, assets, model(), true)
		Expect(a1).To(Equal(a2))
	})

	It("changes when the pod template changes", func() {
		a1 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, nil, model(), true)
		a2 := templateHashAnnotations(podSpecWithImage("img:v2"), nil, nil, nil, nil, model(), true)
		Expect(a1[templateHashAnnotationKey]).NotTo(Equal(a2[templateHashAnnotationKey]))
	})

	It("keeps the combined hash when only resolved overrides change", func() {
		// The rendered pod template already embeds every referenced override,
		// so a replicas-only override change must not roll out (design §5.1
		// scale row): the combined hash stays, the diagnostic overrides hash
		// still tracks the change.
		a1 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, map[string]string{"mode": "pd"}, nil, model(), true)
		a2 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, map[string]string{"mode": "normal"}, nil, model(), true)
		Expect(a1[templateHashAnnotationKey]).To(Equal(a2[templateHashAnnotationKey]))
		Expect(a1[templateHashOverridesAnnotationKey]).NotTo(Equal(a2[templateHashOverridesAnnotationKey]))
	})

	It("changes when asset content changes", func() {
		a1 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, map[string]map[string]string{"c": {"k": "v1"}}, model(), true)
		a2 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, map[string]map[string]string{"c": {"k": "v2"}}, model(), true)
		Expect(a1[templateHashAnnotationKey]).NotTo(Equal(a2[templateHashAnnotationKey]))
	})

	It("includes the model storage hash only for mounting roles", func() {
		with := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, nil, model(), true)
		without := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, nil, model(), false)
		Expect(with[templateHashStorageAnnotationKey]).NotTo(Equal(without[templateHashStorageAnnotationKey]))
		Expect(with[templateHashAnnotationKey]).NotTo(Equal(without[templateHashAnnotationKey]))
	})

	It("normalizes equivalent capacity spellings", func() {
		m1 := model()
		m2 := model()
		m2.Spec.Storage.Dynamic.Capacity = resource.MustParse("1024Gi")
		a1 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, nil, m1, true)
		a2 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, nil, m2, true)
		Expect(a1).To(Equal(a2))
	})

	It("includes pod labels and annotations in the pod hash", func() {
		a1 := templateHashAnnotations(podSpecWithImage("img:v1"), map[string]string{"l": "1"}, nil, nil, nil, model(), true)
		a2 := templateHashAnnotations(podSpecWithImage("img:v1"), nil, nil, nil, nil, model(), true)
		Expect(a1[templateHashPodAnnotationKey]).NotTo(Equal(a2[templateHashPodAnnotationKey]))
	})
})

package renderer

import (
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	overrideReplicas = "replicas"
	overrideMode     = "mode"
	overrideCache    = "cache"
	overrideSize     = "size"
)

func ptrTo[T any](v T) *T { return &v }

func jsonValue(t string) apiextensionsv1.JSON { return apiextensionsv1.JSON{Raw: []byte(t)} }

func declaredOverrides() []aiv1alpha1.Override {
	return []aiv1alpha1.Override{
		{Name: overrideReplicas, Type: aiv1alpha1.OverrideTypeInteger, Min: ptrTo[int64](1), Max: ptrTo[int64](8)},
		{Name: overrideMode, Type: aiv1alpha1.OverrideTypeString, Enum: []apiextensionsv1.JSON{jsonValue(`"pd"`), jsonValue(`"normal"`)}},
		{Name: overrideCache, Type: aiv1alpha1.OverrideTypeBoolean, Default: &apiextensionsv1.JSON{Raw: []byte("true")}},
	}
}

func TestRenderer(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Renderer Suite")
}

var _ = Describe("ResolveOverrides", func() {
	It("resolves user values to canonical strings", func() {
		got, errs := ResolveOverrides(declaredOverrides(), map[string]apiextensionsv1.JSON{
			overrideReplicas: jsonValue("3"), overrideMode: jsonValue(`"pd"`), overrideCache: jsonValue("false"),
		})
		Expect(errs).To(BeEmpty())
		Expect(got).To(Equal(map[string]string{overrideReplicas: "3", overrideMode: "pd", overrideCache: "false"}))
	})

	It("fills defaults for overrides without a user value", func() {
		got, errs := ResolveOverrides(declaredOverrides(), nil)
		Expect(errs).To(BeEmpty())
		Expect(got).To(Equal(map[string]string{overrideCache: "true"}))
	})

	It("rejects unknown user keys", func() {
		_, errs := ResolveOverrides(declaredOverrides(), map[string]apiextensionsv1.JSON{"bogus": jsonValue("1")})
		Expect(errs).To(HaveLen(1))
		Expect(errs[0].Reason).To(Equal(ReasonUnknownOverride))
		Expect(errs[0].Msg).To(ContainSubstring("bogus"))
	})

	It("rejects type mismatches", func() {
		_, errs := ResolveOverrides(declaredOverrides(), map[string]apiextensionsv1.JSON{overrideReplicas: jsonValue(`"many"`)})
		Expect(errs).To(HaveLen(1))
		Expect(errs[0].Reason).To(Equal(ReasonInvalidOverride))
		Expect(errs[0].Msg).To(ContainSubstring(overrideReplicas))
	})

	It("rejects values outside the enum", func() {
		_, errs := ResolveOverrides(declaredOverrides(), map[string]apiextensionsv1.JSON{overrideMode: jsonValue(`"fast"`)})
		Expect(errs).To(HaveLen(1))
		Expect(errs[0].Reason).To(Equal(ReasonInvalidOverride))
	})

	It("rejects integer values outside min and max", func() {
		_, errs := ResolveOverrides(declaredOverrides(), map[string]apiextensionsv1.JSON{overrideReplicas: jsonValue("0")})
		Expect(errs).To(HaveLen(1))
		Expect(errs[0].Reason).To(Equal(ReasonInvalidOverride))
		_, errs = ResolveOverrides(declaredOverrides(), map[string]apiextensionsv1.JSON{overrideReplicas: jsonValue("9")})
		Expect(errs).To(HaveLen(1))
	})

	It("rejects non-integral numbers for integer overrides", func() {
		_, errs := ResolveOverrides(declaredOverrides(), map[string]apiextensionsv1.JSON{overrideReplicas: jsonValue("1.5")})
		Expect(errs).To(HaveLen(1))
		Expect(errs[0].Reason).To(Equal(ReasonInvalidOverride))
	})

	It("accepts numeric enum values", func() {
		declared := []aiv1alpha1.Override{
			{Name: overrideSize, Type: aiv1alpha1.OverrideTypeInteger, Enum: []apiextensionsv1.JSON{jsonValue("1"), jsonValue("2")}},
		}
		got, errs := ResolveOverrides(declared, map[string]apiextensionsv1.JSON{overrideSize: jsonValue("1")})
		Expect(errs).To(BeEmpty())
		Expect(got).To(Equal(map[string]string{overrideSize: "1"}))
		_, errs = ResolveOverrides(declared, map[string]apiextensionsv1.JSON{overrideSize: jsonValue("2")})
		Expect(errs).To(BeEmpty())
		_, errs = ResolveOverrides(declared, map[string]apiextensionsv1.JSON{overrideSize: jsonValue("3")})
		Expect(errs).To(HaveLen(1))
		Expect(errs[0].Reason).To(Equal(ReasonInvalidOverride))
	})

	It("compares numeric enum values semantically", func() {
		declared := []aiv1alpha1.Override{
			{Name: overrideSize, Type: aiv1alpha1.OverrideTypeInteger, Enum: []apiextensionsv1.JSON{jsonValue("1.0")}},
		}
		got, errs := ResolveOverrides(declared, map[string]apiextensionsv1.JSON{overrideSize: jsonValue("1")})
		Expect(errs).To(BeEmpty())
		Expect(got).To(Equal(map[string]string{overrideSize: "1"}))
	})

	It("distinguishes large integers beyond float64 precision", func() {
		declared := []aiv1alpha1.Override{
			{Name: overrideSize, Type: aiv1alpha1.OverrideTypeInteger, Enum: []apiextensionsv1.JSON{jsonValue("9007199254740992")}},
		}
		// 9007199254740993 and 9007199254740992 are distinct int64 values that
		// collide when converted to float64; the enum check must not round.
		_, errs := ResolveOverrides(declared, map[string]apiextensionsv1.JSON{overrideSize: jsonValue("9007199254740993")})
		Expect(errs).To(HaveLen(1))
		Expect(errs[0].Reason).To(Equal(ReasonInvalidOverride))

		got, errs := ResolveOverrides(declared, map[string]apiextensionsv1.JSON{overrideSize: jsonValue("9007199254740992")})
		Expect(errs).To(BeEmpty())
		Expect(got).To(Equal(map[string]string{overrideSize: "9007199254740992"}))
	})

	It("compares exponent-notation enum items exactly", func() {
		declared := []aiv1alpha1.Override{
			{Name: overrideSize, Type: aiv1alpha1.OverrideTypeInteger, Enum: []apiextensionsv1.JSON{jsonValue("1e3")}},
		}
		got, errs := ResolveOverrides(declared, map[string]apiextensionsv1.JSON{overrideSize: jsonValue("1000")})
		Expect(errs).To(BeEmpty())
		Expect(got).To(Equal(map[string]string{overrideSize: "1000"}))
	})

	It("omits declared overrides with neither a value nor a default", func() {
		got, errs := ResolveOverrides([]aiv1alpha1.Override{{Name: "solo", Type: aiv1alpha1.OverrideTypeString}}, nil)
		Expect(errs).To(BeEmpty())
		Expect(got).To(BeEmpty())
	})
})

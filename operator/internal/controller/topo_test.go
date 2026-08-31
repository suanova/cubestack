package controller

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const testRoleRouter = "router"

var _ = Describe("topoOrder", func() {
	role := func(name string, deps ...string) aiv1alpha1.Role {
		return aiv1alpha1.Role{Name: name, DependsOn: deps}
	}

	It("returns the declaration order without dependencies", func() {
		order, err := topoOrder([]aiv1alpha1.Role{role("a"), role("b")}, "a")
		Expect(err).NotTo(HaveOccurred())
		Expect(order).To(Equal([]string{"b", "a"})) // endpoint "a" moved last
	})

	It("orders dependencies first", func() {
		order, err := topoOrder([]aiv1alpha1.Role{role(testRoleRouter, testRolePrefill), role(testRolePrefill)}, testRoleRouter)
		Expect(err).NotTo(HaveOccurred())
		Expect(order).To(Equal([]string{testRolePrefill, testRoleRouter}))
	})

	It("orders a chain of dependencies", func() {
		order, err := topoOrder([]aiv1alpha1.Role{
			role("c", "b"), role("b", "a"), role("a"),
		}, "c")
		Expect(err).NotTo(HaveOccurred())
		Expect(order).To(Equal([]string{"a", "b", "c"}))
	})

	It("detects a dependency cycle", func() {
		_, err := topoOrder([]aiv1alpha1.Role{role("a", "b"), role("b", "a")}, "a")
		Expect(err).To(MatchError("roles form a dependency cycle"))
	})

	It("rejects a dependency on an unknown role", func() {
		_, err := topoOrder([]aiv1alpha1.Role{role("a", "ghost")}, "a")
		Expect(err).To(MatchError(`role "a" depends on unknown role "ghost"`))
	})

	It("keeps the endpoint role in place when something depends on it", func() {
		// x depends on endpoint e: DAG order wins over the endpoint-last rule.
		order, err := topoOrder([]aiv1alpha1.Role{role("x", "e"), role("e")}, "e")
		Expect(err).NotTo(HaveOccurred())
		Expect(order).To(Equal([]string{"e", "x"}))
	})
})

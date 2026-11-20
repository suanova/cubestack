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

package ipam

import (
	"os"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/yaml"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

// The samples in config/samples are what a user copies first, so a broken one is
// the worst possible first impression. Asserting them against the API server rather
// than a client-side dry run is deliberate: a client run never reaches the CEL
// rules or the defaulting, which is where a sample written by hand goes wrong.
//
// The minimal pool is included even though the kustomization deliberately leaves it
// out — it is still shipped, and still has to be accepted when someone copies it.
var _ = Describe("Shipped samples", func() {
	for _, path := range []string{
		"../../../config/samples/ipam_v1alpha1_ippool.yaml",
		"../../../config/samples/ipam_v1alpha1_ippool_minimal.yaml",
		"../../../config/samples/ipam_v1alpha1_ipclaim.yaml",
	} {
		It("satisfies the schema: "+path, func() {
			raw, err := os.ReadFile(path)
			Expect(err).NotTo(HaveOccurred())

			var obj client.Object
			switch {
			case strings.Contains(string(raw), "kind: IPPool"):
				obj = &ipamv1alpha1.IPPool{}
			case strings.Contains(string(raw), "kind: IPClaim"):
				obj = &ipamv1alpha1.IPClaim{}
			default:
				Fail("unrecognised sample kind in " + path)
			}

			Expect(yaml.Unmarshal(raw, obj)).To(Succeed())
			Expect(k8sClient.Create(ctx, obj)).To(Succeed())
			DeferCleanup(func() { _ = k8sClient.Delete(ctx, obj) })
		})
	}
})

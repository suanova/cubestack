//go:build e2e
// +build e2e

package e2e

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family M: the plumbing between an environment and a client outside the
// cluster (§4.M).
//
// The subject is not the environment but the two objects between it and its
// answers: the Gateway, which is the platform's and lives in a namespace of the
// platform's own, and the dataplane Service behind it, which is what the
// published address actually points at. Everything here would hold on an
// environment whose spec is perfectly fine — which is exactly why it is asserted
// separately: a platform can publish an address that is correct in every field
// and leads nowhere.
//
// Realised here are the three that say something about the objects in the middle
// — M1, M4 and M5. The other two are each already a case elsewhere, and a second
// copy would be the same assertion under a second name:
//
//   - M2 (the ssh endpoint answers on a port in the configured pool) is A4, on
//     every one of the twelve environments.
//   - M3 (deleting an environment withdraws its port) is G5: the routes, the
//     listener and the port are read before the environment is allowed to go,
//     which is the only moment an environment being deleted is still there to be
//     read.
//   - M4's other half — the Gateway coming and going underneath a running
//     environment, which is ordinary now that the platform owns it (#232) — is
//     the controller's own integration specs. Provoking it here would mean
//     deleting the cluster's shared Gateway, which takes every environment on
//     the cluster down with this run's.
func describeGatewayPlumbing(open func() *devenv.Environment, img devenv.Image) {
	It("M1 rides the Gateway's own HTTP listener for a notebook, and draws no pool port for it",
		Label(devenv.TierP1, devenv.LabelFamily("M")), func(ctx SpecContext) {
			env := open()
			if !img.ServesJupyter() {
				Skip("the image serves no notebook, so it publishes no web endpoint")
			}
			ep, ok := env.WebEndpoint()
			Expect(ok).To(BeTrue(), "status published no %q endpoint (has %v)", img.Type, env.EndpointNames())

			// The one number that says which listener a user's browser is being
			// sent to. A notebook served on a port drawn from the L4 pool would be
			// published as an address that answers — the pool port is real, the
			// Gateway serves it — while every path rule under the environment's
			// prefix, which is what makes the notebook's base_url work, is attached
			// to a different listener.
			Expect(ep.ListenerPort).To(Equal(cluster.HTTPPort),
				"the notebook is published on listener port %d and the Gateway serves HTTP on %d",
				ep.ListenerPort, cluster.HTTPPort)

			// And the pool is not spent on it. The ListenerSet is the durable
			// record of what an environment holds, so a listener declared on the
			// Gateway's HTTP port would be a second claim on a port the platform
			// itself serves.
			ls, err := env.ListenerSet(ctx)
			Expect(err).NotTo(HaveOccurred())
			for _, l := range ls.Spec.Listeners {
				Expect(int32(l.Port)).NotTo(Equal(cluster.HTTPPort),
					"the environment declares a pool listener on the Gateway's HTTP port (declares %v)",
					devenv.ListenerNames(ls))
			}
		})

	It("M4 attaches its ListenerSet to the Gateway where the Gateway actually lives",
		Label(devenv.TierP1, devenv.LabelFamily("M")), func(ctx SpecContext) {
			env := open()
			ls, err := env.ListenerSet(ctx)
			Expect(err).NotTo(HaveOccurred())

			// The reference, resolved the way the API server resolves it rather
			// than the way it is written: a parentRef with no namespace means the
			// *referring object's* namespace, so an environment whose ListenerSet
			// named the Gateway by name alone would be looking for it in its own
			// namespace, where no Gateway exists — and would be accepted by nobody.
			namespace, name := devenv.ListenerSetParent(ls)
			Expect(name).To(Equal(cluster.GatewayName),
				"the ListenerSet attaches to %q and the manager serves %q", name, cluster.GatewayName)
			Expect(namespace).To(Equal(cluster.GatewayNamespace),
				"the ListenerSet attaches to a Gateway in %q and the manager's is in %q",
				namespace, cluster.GatewayNamespace)

			// The premise of the case, asserted because it is what makes the one
			// above mean anything: the Gateway belongs to the platform and is not
			// in a tenant's namespace, so naming it requires naming a namespace at
			// all. A3 reads the other end of this — the Gateway accepting the
			// reference — and neither is complete without the other.
			Expect(namespace).NotTo(Equal(env.Namespace),
				"the platform's Gateway is in %s, the environment's own namespace; this case asserts the "+
					"cross-namespace reference and there is none to assert", env.Namespace)
		})

	It("M5 publishes every endpoint at the address the Gateway answers on",
		Label(devenv.TierP1, devenv.LabelFamily("M")), func(ctx SpecContext) {
			env := open()

			// Every endpoint the environment publishes, which is one for an ssh
			// environment and two for a notebook that also serves ssh.
			names := env.EndpointNames()
			Expect(names).NotTo(BeEmpty(), "a running environment published no endpoints")

			for _, name := range names {
				ep, ok := env.Endpoint(name)
				Expect(ok).To(BeTrue())

				// The host is the Gateway's own published address and not something
				// assembled here: an address naming the environment's Service, or a
				// cluster DNS name, answers from inside the cluster and from nowhere
				// else — and every transport case in this suite dials an endpoint
				// from outside it.
				host, err := addressHost(ep.Address)
				Expect(err).NotTo(HaveOccurred())
				Expect(host).To(Equal(cluster.Address),
					"the %s endpoint is published at %q and the Gateway answers at %q",
					name, host, cluster.Address)

				// And the port is the one the dataplane actually serves it on,
				// which is the number a client outside the cluster has to use. The
				// listener's own port is the platform's record of the allocation;
				// the two are the same unless the dataplane renumbers, and asking
				// the Service is what makes this hold either way.
				external, found, err := conformance.DataplaneExternalPort(ctx, ep.ListenerPort)
				Expect(err).NotTo(HaveOccurred())
				Expect(found).To(BeTrue(),
					"the %s endpoint names listener port %d and the dataplane Service does not carry it",
					name, ep.ListenerPort)
				port, err := addressPort(ep.Address)
				Expect(err).NotTo(HaveOccurred())
				Expect(port).To(Equal(external),
					"the %s endpoint's address names port %d where the dataplane serves %d",
					name, port, external)
			}
		})
}

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

package controller

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	eventsv1 "k8s.io/api/events/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/events"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/activity"
)

const (
	testDevImage      = "harbor.local/ai-images/base-cuda:11.8-pytorch2.2"
	testBaseMacaImage = "harbor.local/ai-images/base-maca:1.0"
	testCPUImage      = "harbor.local/ai-images/ssh-ubuntu22.04:latest"
	// testMetaxImage is the mirror of the upstream Metax package: the metax token
	// is `maca` in the package's own name, whatever registry path fronts it.
	testMetaxImage = "harbor.isuanova.com/mirrors/cr.metax-tech.com/public-library/maca-pytorch:3.9.0.12-torch2.4-py310-ubuntu22.04-amd64"
	// testBareMacaImage is the same rule against an unqualified reference.
	testBareMacaImage = "maca:3.9.0.12-ubuntu22.04-amd64"
	// testMacaInPathImage spells "maca" in a path segment rather than in the
	// repository name — which the rule accepts, since it reads the whole
	// reference. Kept to pin that: the gate answers "does the name say its
	// vendor", not "is this a real platform image".
	testMacaInPathImage   = "harbor.local/maca-images/ssh-ubuntu22.04:latest"
	testGPUResource       = "nvidia.com/gpu"
	testDevEnvGatewayName = "test-gw"
	// testGatewayDataplaneNamespace is where the test Gateway's proxy pods run.
	// It is deliberately not the Gateway's own namespace: they are separate
	// deployments, and the ingress rule admits the former.
	testGatewayDataplaneNamespace = "envoy-gateway-system"
	testGatewayIP                 = "1.2.3.4"
	testGRPCPortName              = "grpc"
	testJupyterName               = "jupyter"
	testMetricsPortName           = "metrics"
	// testSyslogPortName is the extra udp port the UDP specs expose.
	testSyslogPortName = "syslog"
	// testCollidingPortName is the extra tcp port the specs exposing the Service
	// port the ssh bridge is published on declare: an exposure the bridge would
	// answer for rather than the workload the entry named.
	testCollidingPortName = "user-app"
	// testDevEnvKind is the kind as the API server writes it into an
	// ownerReference.
	testDevEnvKind = "DevEnvironment"
	// testSSHListenerName is a listener named the current way, which carries the
	// endpoint it was declared for, and testLegacyListenerName one named the way
	// before that — the shape an upgrade reads ports back from.
	testSSHListenerName    = "ssh-tcp-20001"
	testLegacyListenerName = "tcp-20000"
	// testL4PortRangeStart is the lowest listener port the suite's reconciler
	// allocates (suite_test.go), so it is the port a fresh environment takes
	// from an empty pool.
	testL4PortRangeStart = 20000
	// testRDMAIBResource and testRDMARoCEResource are the extended resources the
	// suite's reconciler requests (suite_test.go). Deliberately not the
	// production defaults: an assertion against those would pass even if the
	// controller never read the configured names.
	testRDMAIBResource   = "example.com/ib"
	testRDMARoCEResource = "example.com/roce"
	testRuntimeUser      = "jovyan"
	testUserSSHKey       = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ sample-key alice@example.com"
	// testUserKeysSecret is the user-supplied authorized-keys Secret the case-2
	// specs reference by name; testUserKeysKey is the data entry its selector
	// names. Deliberately not "keys": the delegated key is whatever the selector
	// says, and a fixture named after the retired default would pass even if the
	// controller ignored it.
	testUserKeysSecret = "dev-alice-ssh-keys"
	testUserKeysKey    = "team-keys"
	// testSSHUser is the account the self-authored ssh images ship, selected
	// with spec.runtime.user; testSSHHome is the home it implies.
	testSSHUser = "ubuntu"
	testSSHHome = "/home/" + testSSHUser
	// testWorkspaceSize is the claim every spec that needs a workspace declares,
	// and testPinnedMountPath the path one of them pins it to. Named rather than
	// repeated because neither is what those specs are about.
	testWorkspaceSize   = "1Gi"
	testPinnedMountPath = "/data/workspace"
)

// webRootPath is the published web path prefix for environments in the test
// namespace (design §6.4: /dev/<ns>/<env>/).
var webRootPath = "/dev/" + testNamespace + "/"

// testPKCS8HostKey is the shape this controller used to mint the host key in.
// sshd cannot read it — OpenSSH has no PKCS#8 support for Ed25519 — so a Secret
// carrying it has to be migrated.
const testPKCS8HostKey = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----\n"

// sshKeyPairMatches reports whether the private key is an OpenSSH-format PEM
// block and the one-line public key describes the same key: the private blob
// embeds the raw public key, so it must contain the bytes the .pub encodes.
// Both keypairs the controller mints are checked with it — the environment's
// host identity and, in the generated case, the owner's login key.
func sshKeyPairMatches(privPEM, pubOpenSSH []byte) bool {
	block, _ := pem.Decode(privPEM)
	if block == nil || block.Type != sshHostKeyPEMType {
		return false
	}
	if !bytes.HasPrefix(block.Bytes, []byte("openssh-key-v1\x00")) {
		return false
	}
	fields := strings.Fields(string(pubOpenSSH))
	if len(fields) != 2 || fields[0] != sshEd25519Algorithm {
		return false
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) < ed25519.PublicKeySize {
		return false
	}
	return bytes.Contains(block.Bytes, blob[len(blob)-ed25519.PublicKeySize:])
}

// nvidiaGPU and metaxGPU build the requested-accelerator block the way a spec
// would carry it, so the cases below read as the request rather than as struct
// literals. Every case asks for one.
func nvidiaGPU() *aiv1alpha1.GPUSpec {
	return &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Count: ptrTo(int32(1))}
}

func metaxGPU() *aiv1alpha1.GPUSpec {
	return &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorMetax, Count: ptrTo(int32(1))}
}

// validDevEnvironment mirrors the API package fixture (minus the SSH config,
// which individual tests enable when they need it).
func validDevEnvironment(name string) *aiv1alpha1.DevEnvironment {
	return &aiv1alpha1.DevEnvironment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: aiv1alpha1.DevEnvironmentSpec{
			Type:    aiv1alpha1.DevEnvironmentTypeJupyter,
			Image:   testDevImage,
			Running: true,
			Resources: aiv1alpha1.ResourcesSpec{
				GPU:    &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Count: ptrTo(int32(1))},
				CPU:    "16",
				Memory: "64Gi",
			},
			Storage: &aiv1alpha1.StorageSpec{
				Size:         "200Gi",
				PVCRetention: aiv1alpha1.PVCRetentionRetain,
				MountPath:    defaultWorkspacePath,
			},
		},
	}
}

func envKey(name string) client.ObjectKey {
	return client.ObjectKey{Name: name, Namespace: testNamespace}
}

func deleteEnv(name string) {
	env := &aiv1alpha1.DevEnvironment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace}}
	_ = k8sClient.Delete(ctx, env)
}

// updateEnvSpec applies mutate to the stored environment. It retries the
// read-modify-write because the reconciler writes status concurrently: a write
// landing between our Get and Update bumps the resourceVersion and the update
// fails with a conflict. mutate must be idempotent, since it runs more than once.
func updateEnvSpec(name string, mutate func(*aiv1alpha1.DevEnvironment)) {
	Eventually(func(g Gomega) {
		env := &aiv1alpha1.DevEnvironment{}
		g.Expect(k8sClient.Get(ctx, envKey(name), env)).To(Succeed())
		mutate(env)
		g.Expect(k8sClient.Update(ctx, env)).To(Succeed())
	}, "15s", "200ms").Should(Succeed())
}

func deleteGateway() {
	_ = k8sClient.Delete(ctx, &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace}})
}

// createStatefulPod fabricates the ordinal-0 pod that a real scheduler and
// kubelet would create for the environment. The pod's name and labels match
// what the controller looks up, so the fabricated status drives the phase.
func createStatefulPod(env *aiv1alpha1.DevEnvironment, ready bool, waiting *corev1.ContainerStateWaiting) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName(env),
			Namespace: env.Namespace,
			Labels:    map[string]string{devEnvironmentLabelKey: env.Name},
		},
		Spec: corev1.PodSpec{
			NodeName:   "node-a",
			Containers: []corev1.Container{{Name: testJupyterName, Image: testDevImage}},
		},
	}
	Expect(k8sClient.Create(ctx, pod)).To(Succeed())
	pod.Status.Phase = corev1.PodRunning
	if ready {
		pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
	}
	if waiting != nil {
		pod.Status.ContainerStatuses = []corev1.ContainerStatus{{
			Name:  testJupyterName,
			State: corev1.ContainerState{Waiting: waiting},
		}}
	}
	Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
}

// createWorkspaceClaim fabricates the workspace claim a running StatefulSet
// controller would have provisioned for the environment: the name follows the
// template-set-ordinal rule, the labels come from the volumeClaimTemplate, and
// the set is the claim's controller — the reference that decides whether
// deleting the set takes the claim with it.
func createWorkspaceClaim(env *aiv1alpha1.DevEnvironment, sts *appsv1.StatefulSet) *corev1.PersistentVolumeClaim {
	claim := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-%s-0", workspaceClaimName, env.Name),
			Namespace: env.Namespace,
			Labels:    map[string]string{devEnvironmentLabelKey: env.Name, managedByLabelKey: devEnvManagedByValue},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("200Gi")},
			},
		},
	}
	Expect(controllerutil.SetControllerReference(sts, claim, k8sClient.Scheme())).To(Succeed())
	Expect(k8sClient.Create(ctx, claim)).To(Succeed())
	return claim
}

// createGateway creates the shared test Gateway, optionally programming its
// status address (a real controller would assign it).
func createGateway(withAddress bool) {
	gw := &gatewayv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace},
		Spec: gatewayv1.GatewaySpec{
			GatewayClassName: gatewayv1.ObjectName("eg"),
			Listeners: []gatewayv1.Listener{{
				Name:     "http",
				Port:     gatewayv1.PortNumber(80),
				Protocol: gatewayv1.HTTPProtocolType,
			}},
		},
	}
	Expect(k8sClient.Create(ctx, gw)).To(Succeed())
	if withAddress {
		gw.Status.Addresses = []gatewayv1.GatewayStatusAddress{{Type: ptrTo(gatewayv1.IPAddressType), Value: testGatewayIP}}
		Expect(k8sClient.Status().Update(ctx, gw)).To(Succeed())
	}
}

// testRouteConditionTime is the LastTransitionTime stamped on the synthetic
// route conditions. It is fixed rather than metav1.Now(): stampDevEnvRoutes
// writes the status only when it differs from what is stored, and a timestamp
// that changes on every call makes that comparison fail forever.
var testRouteConditionTime = metav1.NewTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))

// gatewayRouteParents renders the status.parents a gateway controller would
// write for a route parented by ref: Accepted and ResolvedRefs pinned to the
// route's current generation, so the controller does not read a stale status as
// a fresh acceptance.
func gatewayRouteParents(ref gatewayv1.ParentReference, generation int64, accepted bool, reason, message string) []gatewayv1.RouteParentStatus {
	acceptedCondition := metav1.Condition{
		Type:               string(gatewayv1.RouteConditionAccepted),
		Status:             metav1.ConditionTrue,
		Reason:             string(gatewayv1.RouteReasonAccepted),
		ObservedGeneration: generation,
		LastTransitionTime: testRouteConditionTime,
	}
	if !accepted {
		acceptedCondition.Status = metav1.ConditionFalse
		acceptedCondition.Reason = reason
		acceptedCondition.Message = message
	}
	return []gatewayv1.RouteParentStatus{{
		ParentRef:      ref,
		ControllerName: gatewayv1.GatewayController("cubestack.io/test"),
		Conditions: []metav1.Condition{
			acceptedCondition,
			{
				Type:               string(gatewayv1.RouteConditionResolvedRefs),
				Status:             metav1.ConditionTrue,
				Reason:             string(gatewayv1.RouteReasonResolvedRefs),
				ObservedGeneration: generation,
				LastTransitionTime: testRouteConditionTime,
			},
		},
	}}
}

// stampDevEnvRoutes stands in for the gateway controller, which envtest does not
// run: it admits the environment's ListenerSet and writes status.parents onto
// every route published for the environment, so RouteReady can converge. Call it
// from inside the Eventually that asserts on the routes' effect — the routes and
// the ListenerSet appear one reconcile at a time, and an object whose spec has
// since changed is re-stamped against its new generation.
//
// The routes' `accepted` does not carry over to the ListenerSet: a gateway
// admits the listeners it is offered whatever it later makes of the routes on
// them. A spec that wants the listeners refused stamps that with
// stampDevEnvListenerSet instead of calling this.
func stampDevEnvRoutes(g Gomega, envName string, accepted bool, reason, message string) {
	stampDevEnvListenerSet(g, envName, true, "", "")
	stampDevEnvRouteParents(g, envName, accepted, reason, message)
}

// stampDevEnvRouteParents writes the gateway's verdict on each route published
// for the environment, leaving the ListenerSet alone.
func stampDevEnvRouteParents(g Gomega, envName string, accepted bool, reason, message string) {
	web := &gatewayv1.HTTPRoute{}
	err := k8sClient.Get(ctx, client.ObjectKey{Name: envName + "-web", Namespace: testNamespace}, web)
	if err != nil {
		g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
	} else {
		wanted := gatewayRouteParents(web.Spec.ParentRefs[0], web.Generation, accepted, reason, message)
		if !apiequality.Semantic.DeepEqual(web.Status.Parents, wanted) {
			web.Status.Parents = wanted
			g.Expect(k8sClient.Status().Update(ctx, web)).To(Succeed())
		}
	}

	routes := &gatewayv1.TCPRouteList{}
	g.Expect(k8sClient.List(ctx, routes, client.InNamespace(testNamespace), client.MatchingLabels{devEnvironmentLabelKey: envName})).To(Succeed())
	for i := range routes.Items {
		route := &routes.Items[i]
		wanted := gatewayRouteParents(route.Spec.ParentRefs[0], route.Generation, accepted, reason, message)
		if apiequality.Semantic.DeepEqual(route.Status.Parents, wanted) {
			continue
		}
		route.Status.Parents = wanted
		g.Expect(k8sClient.Status().Update(ctx, route)).To(Succeed())
	}

	udpRoutes := &gatewayv1.UDPRouteList{}
	g.Expect(k8sClient.List(ctx, udpRoutes, client.InNamespace(testNamespace), client.MatchingLabels{devEnvironmentLabelKey: envName})).To(Succeed())
	for i := range udpRoutes.Items {
		route := &udpRoutes.Items[i]
		wanted := gatewayRouteParents(route.Spec.ParentRefs[0], route.Generation, accepted, reason, message)
		if apiequality.Semantic.DeepEqual(route.Status.Parents, wanted) {
			continue
		}
		route.Status.Parents = wanted
		g.Expect(k8sClient.Status().Update(ctx, route)).To(Succeed())
	}
}

// stampDevEnvListenerSet writes the gateway's verdict on the environment's
// ListenerSet — the one it owes before it will report on the routes attached to
// its listeners at all. An environment with no L4 exposure has no ListenerSet,
// which is not a failure.
func stampDevEnvListenerSet(g Gomega, envName string, accepted bool, reason, message string) {
	ls := &gatewayv1.ListenerSet{}
	err := k8sClient.Get(ctx, client.ObjectKey{Name: envName + l4ListenerSetSuffix, Namespace: testNamespace}, ls)
	if apierrors.IsNotFound(err) {
		return
	}
	g.Expect(err).NotTo(HaveOccurred())
	cond := metav1.Condition{
		Type:               string(gatewayv1.ListenerSetConditionAccepted),
		Status:             metav1.ConditionTrue,
		Reason:             string(gatewayv1.ListenerSetReasonAccepted),
		ObservedGeneration: ls.Generation,
		LastTransitionTime: testRouteConditionTime,
	}
	if !accepted {
		cond.Status = metav1.ConditionFalse
		cond.Reason = reason
		cond.Message = message
	}
	wanted := []metav1.Condition{cond}
	if apiequality.Semantic.DeepEqual(ls.Status.Conditions, wanted) {
		return
	}
	ls.Status.Conditions = wanted
	g.Expect(k8sClient.Status().Update(ctx, ls)).To(Succeed())
}

// devEnvTCPRoutePorts lists the listener ports the environment's TCPRoutes hold.
// It reads the routes rather than status.endpoints, which are withheld while a
// route is unaccepted — the state in which the port pool is easiest to get wrong.
func devEnvTCPRoutePorts(g Gomega, envName string) []int32 {
	routes := &gatewayv1.TCPRouteList{}
	g.Expect(k8sClient.List(ctx, routes, client.InNamespace(testNamespace),
		client.MatchingLabels{devEnvironmentLabelKey: envName})).To(Succeed())
	ports := make([]int32, 0, len(routes.Items))
	for i := range routes.Items {
		if p := tcpRoutePort(routes.Items[i].Name); p != 0 {
			ports = append(ports, p)
		}
	}
	return ports
}

// devEnvEndpointPort is the listener port published under the given endpoint
// name, or 0 when there is no such endpoint.
func devEnvEndpointPort(endpoints []aiv1alpha1.Endpoint, name string) int32 {
	for _, ep := range endpoints {
		if ep.Name == name {
			return ep.ListenerPort
		}
	}
	return 0
}

func sshEndpointPort(endpoints []aiv1alpha1.Endpoint) int32 {
	for _, ep := range endpoints {
		if ep.Name == sshPortName {
			return ep.ListenerPort
		}
	}
	return 0
}

// addressPort extracts the trailing port from a published address such as
// "1.2.3.4:20001" or "[2001:db8::1]:20001"; it returns 0 when the address has
// no parseable port.
func addressPort(addr string) int32 {
	i := strings.LastIndex(addr, ":")
	if i < 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimRight(addr[i+1:], "/"))
	if err != nil {
		return 0
	}
	return int32(n)
}

// listEventsForEnv returns the events.k8s.io/v1 Events recorded for the named
// DevEnvironment with the given reason. Events accumulate in the test namespace
// across specs under the shared manager, so assertions always filter by the
// unique environment name rather than global counts.
func listEventsForEnv(name, reason string) []eventsv1.Event {
	var evts eventsv1.EventList
	if err := k8sClient.List(ctx, &evts, client.InNamespace(testNamespace)); err != nil {
		return nil
	}
	out := []eventsv1.Event{}
	for _, e := range evts.Items {
		if e.Regarding.Name == name && e.Regarding.Kind == "DevEnvironment" && e.Reason == reason {
			out = append(out, e)
		}
	}
	return out
}

var _ = Describe("DevEnvironment resource helpers", func() {
	Describe("generateJupyterToken", func() {
		It("returns distinct non-empty 32-hex tokens", func() {
			a, err := generateJupyterToken()
			Expect(err).NotTo(HaveOccurred())
			b, err := generateJupyterToken()
			Expect(err).NotTo(HaveOccurred())
			Expect(a).To(HaveLen(32))
			Expect(b).To(MatchRegexp("^[0-9a-f]{32}$"))
			Expect(a).NotTo(Equal(b))
		})
	})

	Describe("allocatePort", func() {
		cfg := DevEnvironmentControllerConfig{L4PortRangeStart: 20000, L4PortRangeEnd: 20002}
		r := &DevEnvironmentReconciler{Config: cfg}
		used := func(ports ...int32) map[int32]bool {
			m := map[int32]bool{}
			for _, p := range ports {
				m[p] = true
			}
			return m
		}
		held := func(name string, port int32) map[string]int32 {
			return map[string]int32{name: port}
		}

		It("keeps the environment's own recorded port when it is still free", func() {
			Expect(r.allocatePort(sshPortName, used(20002), held(sshPortName, 20001))).To(Equal(int32(20001)))
		})

		It("skips ports used by other environments and picks the lowest free", func() {
			Expect(r.allocatePort(sshPortName, used(20000), nil)).To(Equal(int32(20001)))
			Expect(r.allocatePort(sshPortName, used(20000, 20001), nil)).To(Equal(int32(20002)))
		})

		It("does not reuse its own recorded port when another environment now holds it", func() {
			Expect(r.allocatePort(sshPortName, used(20001), held(sshPortName, 20001))).To(Equal(int32(20000)))
		})

		It("returns 0 when the whole configured range is used", func() {
			Expect(r.allocatePort(sshPortName, used(20000, 20001, 20002), nil)).To(Equal(int32(0)))
		})
	})

	Describe("heldPorts", func() {
		const envName = "env-b"
		cfg := DevEnvironmentControllerConfig{L4PortRangeStart: 20000, L4PortRangeEnd: 20002}
		r := &DevEnvironmentReconciler{Config: cfg}
		newReconciler := func(objs ...client.Object) *DevEnvironmentReconciler {
			scheme := runtime.NewScheme()
			Expect(gatewayv1.Install(scheme)).To(Succeed())
			live := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
			return &DevEnvironmentReconciler{Config: cfg, APIReader: live}
		}
		// The environment's own ListenerSet, named and labeled the way the
		// controller writes it — the labels are the ones the read selects on, so a
		// fixture that invents its own would pass without ever being found.
		ownListenerSet := func(envName string, listeners ...gatewayv1.ListenerEntry) *gatewayv1.ListenerSet {
			return &gatewayv1.ListenerSet{
				ObjectMeta: metav1.ObjectMeta{
					Name:      listenerSetName(&aiv1alpha1.DevEnvironment{ObjectMeta: metav1.ObjectMeta{Name: envName}}),
					Namespace: testNamespace,
					Labels:    r.envLabels(envName),
				},
				Spec: gatewayv1.ListenerSetSpec{Listeners: listeners},
			}
		}
		sshEnv := func() *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace},
				Spec:       aiv1alpha1.DevEnvironmentSpec{Type: aiv1alpha1.DevEnvironmentTypeSSH},
			}
		}

		It("reads the endpoint list's listener port, not the port in the address", func() {
			// A NodePort dataplane renumbers the endpoint's address away from the
			// listener port the pool allocated; the allocation is the listener port,
			// so the environment keeps it rather than being handed a lower free one.
			env := sshEnv()
			env.Status.Endpoints = []aiv1alpha1.Endpoint{{Name: sshPortName, Address: "1.2.3.4:31001", ListenerPort: 20001}}

			held, err := r.heldPorts(context.Background(), env)
			Expect(err).NotTo(HaveOccurred())
			Expect(held).To(Equal(map[string]int32{sshPortName: 20001}))
		})

		It("recovers a port from the environment's own ListenerSet when the list records none", func() {
			// The withheld-endpoint case: the ListenerSet still declares the port,
			// and the name of the listener is what attributes it to an endpoint.
			r := newReconciler(ownListenerSet(envName, gatewayv1.ListenerEntry{
				Name: "ssh-tcp-20001", Protocol: gatewayv1.TCPProtocolType, Port: 20001,
			}))

			held, err := r.heldPorts(context.Background(), sshEnv())
			Expect(err).NotTo(HaveOccurred())
			Expect(held).To(Equal(map[string]int32{sshPortName: 20001}))
		})

		It("prefers the endpoint list where both record the same endpoint", func() {
			// They can only disagree after a reconcile that applied the ListenerSet
			// and then failed before writing the endpoints; the published port is
			// what the user was last shown.
			r := newReconciler(ownListenerSet(envName, gatewayv1.ListenerEntry{
				Name: "ssh-tcp-20000", Protocol: gatewayv1.TCPProtocolType, Port: 20000,
			}))
			env := sshEnv()
			env.Status.Endpoints = []aiv1alpha1.Endpoint{{Name: sshPortName, Address: "1.2.3.4:20001", ListenerPort: 20001}}

			held, err := r.heldPorts(context.Background(), env)
			Expect(err).NotTo(HaveOccurred())
			Expect(held[sshPortName]).To(Equal(int32(20001)))
		})

		It("reads no port off a listener this operator did not name", func() {
			// A listener left from the naming scheme that did not carry the
			// endpoint: it declares a port, but not whose it is.
			r := newReconciler(ownListenerSet(envName, gatewayv1.ListenerEntry{
				Name: "tcp-20001", Protocol: gatewayv1.TCPProtocolType, Port: 20001,
			}))

			held, err := r.heldPorts(context.Background(), sshEnv())
			Expect(err).NotTo(HaveOccurred())
			Expect(held).To(BeEmpty())
		})

		It("ignores another environment's ListenerSet", func() {
			peer := ownListenerSet("peer-a", gatewayv1.ListenerEntry{
				Name: "ssh-tcp-20001", Protocol: gatewayv1.TCPProtocolType, Port: 20001,
			})
			r := newReconciler(peer)

			held, err := r.heldPorts(context.Background(), sshEnv())
			Expect(err).NotTo(HaveOccurred())
			Expect(held).To(BeEmpty())
		})
	})

	Describe("l4ListenerEndpoint", func() {
		It("recovers the endpoint a listener name was declared for", func() {
			Expect(l4ListenerEndpoint("ssh-tcp-20000")).To(Equal(sshPortName))
			Expect(l4ListenerEndpoint("metrics-udp-30000")).To(Equal("metrics"))
		})

		It("takes the endpoint name as written, delimiters and all", func() {
			Expect(l4ListenerEndpoint("app-tcp-9000-udp-20001")).To(Equal("app-tcp-9000"))
		})

		It("recovers nothing from a name this operator did not write", func() {
			Expect(l4ListenerEndpoint("tcp-20000")).To(BeEmpty())
			Expect(l4ListenerEndpoint("ssh")).To(BeEmpty())
			Expect(l4ListenerEndpoint("ssh-tcp-")).To(BeEmpty())
		})
	})

	// A ListenerSet written before the endpoint became part of the listener name
	// attributes nothing on its own (::l4ListenerEndpoint), so the endpoint list
	// is the only record of which endpoint holds which pool port — and the
	// withdrawal takes that list away. These specs are the moment before it goes.
	Describe("migrateListenerNames", func() {
		const envName = "env-migrate"
		cfg := DevEnvironmentControllerConfig{
			GatewayName: testDevEnvGatewayName, GatewayNamespace: testNamespace,
			L4PortRangeStart: 20000, L4PortRangeEnd: 20002,
		}
		legacyListener := func(name string, protocol gatewayv1.ProtocolType, port int32) gatewayv1.ListenerEntry {
			return gatewayv1.ListenerEntry{Name: gatewayv1.SectionName(name), Protocol: protocol, Port: port}
		}
		// The labels the controller writes, which the read back is selected on.
		labels := (&DevEnvironmentReconciler{}).envLabels(envName)
		// The environment's own ListenerSet as an earlier build left it: named by
		// port alone, owned by the environment.
		ownListenerSet := func(listeners ...gatewayv1.ListenerEntry) *gatewayv1.ListenerSet {
			return &gatewayv1.ListenerSet{
				ObjectMeta: metav1.ObjectMeta{
					Name:      envName + l4ListenerSetSuffix,
					Namespace: testNamespace,
					Labels:    labels,
					OwnerReferences: []metav1.OwnerReference{{
						APIVersion: aiv1alpha1.GroupVersion.String(),
						Kind:       testDevEnvKind,
						Name:       envName,
						UID:        "uid-migrate",
						Controller: ptrTo(true),
					}},
				},
				Spec: gatewayv1.ListenerSetSpec{Listeners: listeners},
			}
		}
		env := func(endpoints ...aiv1alpha1.Endpoint) *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace, UID: "uid-migrate"},
				Spec:       aiv1alpha1.DevEnvironmentSpec{Type: aiv1alpha1.DevEnvironmentTypeSSH},
				Status:     aiv1alpha1.DevEnvironmentStatus{Endpoints: endpoints},
			}
		}
		// The Gateway is absent: the fake client holds no Gateway, which is the
		// state this migration is for.
		newReconciler := func(objs ...client.Object) (client.Client, *DevEnvironmentReconciler) {
			scheme := runtime.NewScheme()
			Expect(gatewayv1.Install(scheme)).To(Succeed())
			live := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
			return live, &DevEnvironmentReconciler{Client: live, Config: cfg}
		}
		listenerNames := func(live client.Client) []string {
			got := &gatewayv1.ListenerSet{}
			Expect(live.Get(context.Background(), client.ObjectKey{Name: envName + l4ListenerSetSuffix, Namespace: testNamespace}, got)).To(Succeed())
			names := make([]string, 0, len(got.Spec.Listeners))
			for _, l := range got.Spec.Listeners {
				names = append(names, string(l.Name))
			}
			return names
		}

		It("names a listener for the endpoint its recorded port belongs to", func() {
			// Otherwise the environment comes back from the Gateway's absence on
			// whatever port is free at the bottom of the pool, and answers at an
			// address its user was never given.
			live, r := newReconciler(ownListenerSet(
				legacyListener("tcp-20001", gatewayv1.TCPProtocolType, 20001),
				legacyListener("udp-20002", gatewayv1.UDPProtocolType, 20002),
			))
			e := env(
				aiv1alpha1.Endpoint{Name: sshPortName, ListenerPort: 20001},
				aiv1alpha1.Endpoint{Name: "metrics", ListenerPort: 20002},
			)

			Expect(r.reconcileGatewayRoutes(context.Background(), e, &e.Status)).To(Succeed())

			Expect(listenerNames(live)).To(Equal([]string{testSSHListenerName, "metrics-udp-20002"}))
			Expect(e.Status.Endpoints).To(BeEmpty())
		})

		It("leaves a listener alone that no endpoint records a port for", func() {
			// Nothing to migrate from: the name is left as it was rather than
			// guessed at, and the allocation stays whatever the routes hold.
			live, r := newReconciler(ownListenerSet(
				legacyListener(testLegacyListenerName, gatewayv1.TCPProtocolType, 20000),
				legacyListener("tcp-20001", gatewayv1.TCPProtocolType, 20001),
			))
			e := env(aiv1alpha1.Endpoint{Name: sshPortName, ListenerPort: 20001})

			Expect(r.reconcileGatewayRoutes(context.Background(), e, &e.Status)).To(Succeed())

			Expect(listenerNames(live)).To(Equal([]string{testLegacyListenerName, testSSHListenerName}))
		})

		It("leaves a name that already carries its endpoint alone", func() {
			live, r := newReconciler(ownListenerSet(
				legacyListener(testSSHListenerName, gatewayv1.TCPProtocolType, 20001),
			))
			e := env(aiv1alpha1.Endpoint{Name: sshPortName, ListenerPort: 20001})

			Expect(r.reconcileGatewayRoutes(context.Background(), e, &e.Status)).To(Succeed())

			Expect(listenerNames(live)).To(Equal([]string{testSSHListenerName}))
		})

		It("migrates nothing where the environment never published a listener", func() {
			live, r := newReconciler()

			e := env()
			Expect(r.reconcileGatewayRoutes(context.Background(), e, &e.Status)).To(Succeed())

			Expect(e.Status.Endpoints).To(BeEmpty())
			Expect(apierrors.IsNotFound(live.Get(context.Background(), client.ObjectKey{Name: envName + l4ListenerSetSuffix, Namespace: testNamespace}, &gatewayv1.ListenerSet{}))).To(BeTrue())
		})
	})

	// Allocation is a read of the pool followed by a create, and the create lands
	// in the API server while the TCPRoute informer catches up on its own
	// schedule. A reconcile that runs inside that window would see the port the
	// previous one just reserved as free and hand it out a second time, so the
	// read has to bypass the cache. The two clients below are that window: the
	// cache has not seen the route, the API server has. Asserting on the port
	// that only the live client knows about fails if the List goes back through
	// r.Client.
	Describe("usedPorts", func() {
		gatewayParent := func() []gatewayv1.ParentReference {
			return []gatewayv1.ParentReference{{
				Group:     ptrTo(gatewayv1.Group(gatewayAPIGroup)),
				Kind:      ptrTo(gatewayv1.Kind(gatewayKind)),
				Namespace: ptrTo(gatewayv1.Namespace(defaultGatewayNamespace)),
				Name:      gatewayv1.ObjectName(defaultGatewayName),
			}}
		}
		newRoute := func(name, ns string) *gatewayv1.TCPRoute {
			return &gatewayv1.TCPRoute{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
				Spec:       gatewayv1.TCPRouteSpec{CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: gatewayParent()}},
			}
		}
		newReconciler := func(objs ...client.Object) *DevEnvironmentReconciler {
			scheme := runtime.NewScheme()
			Expect(gatewayv1.Install(scheme)).To(Succeed())
			live := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
			lagging := fake.NewClientBuilder().WithScheme(scheme).Build()
			return &DevEnvironmentReconciler{Client: lagging, APIReader: live}
		}

		It("reads the pool through APIReader, not the lagging cache", func() {
			r := newReconciler(newRoute("peer-tcp-20001", "ns-a"))

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).To(HaveKey(int32(20001)))
		})

		It("still ignores routes that are not on the configured Gateway", func() {
			foreign := newRoute("peer-tcp-20001", "ns-a")
			foreign.Spec.ParentRefs[0].Name = "some-other-gateway"
			r := newReconciler(foreign, newRoute("peer-tcp-20002", "ns-a"))

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).NotTo(HaveKey(int32(20001)))
			Expect(used).To(HaveKey(int32(20002)))
		})

		It("leaves this environment's own ports free for it to reuse", func() {
			own := newRoute("env-b-tcp-20003", "ns-b")
			own.Labels = map[string]string{devEnvironmentLabelKey: "env-b"}
			r := newReconciler(own, newRoute("peer-tcp-20004", "ns-a"))

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).NotTo(HaveKey(int32(20003)))
			Expect(used).To(HaveKey(int32(20004)))
		})

		// The ListenerSet is where an environment's ports are declared now, and it
		// is the surviving claim: a route may be pruned or reparented while the
		// listener it declared still holds the port.
		newListenerSet := func(name, ns, gw string, ports ...int32) *gatewayv1.ListenerSet {
			listeners := make([]gatewayv1.ListenerEntry, 0, len(ports))
			for _, port := range ports {
				listeners = append(listeners, gatewayv1.ListenerEntry{
					Name: gatewayv1.SectionName(fmt.Sprintf("tcp-%d", port)), Protocol: gatewayv1.TCPProtocolType, Port: port,
				})
			}
			return &gatewayv1.ListenerSet{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
				Spec: gatewayv1.ListenerSetSpec{
					ParentRef: gatewayv1.ParentGatewayReference{
						Group:     ptrTo(gatewayv1.Group(gatewayAPIGroup)),
						Kind:      ptrTo(gatewayv1.Kind(gatewayKind)),
						Namespace: ptrTo(gatewayv1.Namespace(defaultGatewayNamespace)),
						Name:      gatewayv1.ObjectName(gw),
					},
					Listeners: listeners,
				},
			}
		}

		It("counts a peer's ListenerSet listeners", func() {
			r := newReconciler(newListenerSet("peer-a-l4", "ns-a", defaultGatewayName, 20005, 20006))

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).To(HaveKey(int32(20005)))
			Expect(used).To(HaveKey(int32(20006)))
		})

		It("still counts a route attached straight to the Gateway", func() {
			// The carry-over path: ports declared before ListenerSets existed, or
			// declared by a route whose ListenerSet is not in this read.
			r := newReconciler(newRoute("peer-tcp-20007", "ns-a"), newListenerSet("peer-a-l4", "ns-a", defaultGatewayName, 20008))

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).To(HaveKey(int32(20007)))
			Expect(used).To(HaveKey(int32(20008)))
		})

		It("counts a peer's udp listener against the same numbering as tcp", func() {
			// Allocation identity is the bare port number (design §8.3), so a udp
			// listener takes its number out of the one pool: the scan reads the
			// port and neither the protocol nor the listener's name, which is what
			// keeps a udp port from being handed the number a tcp one holds.
			udp := newListenerSet("peer-a-l4", "ns-a", defaultGatewayName, 20011)
			udp.Spec.Listeners[0].Name = "udp-20011"
			udp.Spec.Listeners[0].Protocol = gatewayv1.UDPProtocolType
			r := newReconciler(udp)

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).To(HaveKey(int32(20011)))
		})

		It("leaves its own ListenerSet's ports free and ignores one on another gateway", func() {
			own := newListenerSet("env-b-l4", "ns-b", defaultGatewayName, 20009)
			own.Labels = map[string]string{devEnvironmentLabelKey: "env-b"}
			r := newReconciler(own, newListenerSet("peer-a-l4", "ns-a", "some-other-gateway", 20010))

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).NotTo(HaveKey(int32(20009)))
			Expect(used).NotTo(HaveKey(int32(20010)))
		})

		// A cluster serving the Gateway API's standard channel has no TCPRoute kind
		// at all, so the only way to exercise that cluster here is to make the read
		// itself fail the way its discovery does.
		newReconcilerFailingRouteRead := func(err error) *DevEnvironmentReconciler {
			scheme := runtime.NewScheme()
			Expect(gatewayv1.Install(scheme)).To(Succeed())
			live := fake.NewClientBuilder().WithScheme(scheme).
				WithObjects(newListenerSet("peer-a-l4", "ns-a", defaultGatewayName, 20012)).
				WithInterceptorFuncs(interceptor.Funcs{
					List: func(ctx context.Context, c client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
						if _, ok := list.(*gatewayv1.TCPRouteList); ok {
							return err
						}
						return c.List(ctx, list, opts...)
					},
				}).Build()
			return &DevEnvironmentReconciler{APIReader: live}
		}

		It("tolerates a cluster that serves no TCPRoute kind", func() {
			// Nothing to carry over, and the ListenerSet scan — which still runs —
			// is what holds every port this operator allocates. Read as a failure,
			// this would fail allocation for every L4 environment on such a cluster,
			// including the udp-only and ssh-only ones that never had a route.
			r := newReconcilerFailingRouteRead(&meta.NoKindMatchError{
				GroupKind:        schema.GroupKind{Group: gatewayAPIGroup, Kind: tcpRouteKind},
				SearchedVersions: []string{gatewayv1.GroupVersion.Version},
			})

			used, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).NotTo(HaveOccurred())
			Expect(used).To(HaveKey(int32(20012)))
		})

		It("fails on any other error from the route read", func() {
			// Tolerated here, a transient failure would read as an empty pool and
			// hand out the port a peer's route already holds.
			r := newReconcilerFailingRouteRead(fmt.Errorf("the API server is having a bad day"))

			_, err := r.usedPorts(context.Background(), "ns-b", "env-b")
			Expect(err).To(HaveOccurred())
		})
	})

	Describe("setPhase", func() {
		It("keeps LastTransitionTime stable while the phase name is unchanged", func() {
			status := &aiv1alpha1.DevEnvironmentStatus{}
			setPhase(status, aiv1alpha1.PhasePending, reasonPending)
			first := status.Phase.LastTransitionTime

			setPhase(status, aiv1alpha1.PhasePending, reasonNotScheduled)

			Expect(status.Phase.LastTransitionTime).To(BeIdenticalTo(first))
			Expect(status.Phase.Reason).To(Equal(reasonNotScheduled))
		})

		It("bumps LastTransitionTime when the phase name changes", func() {
			status := &aiv1alpha1.DevEnvironmentStatus{}
			setPhase(status, aiv1alpha1.PhasePending, reasonPending)
			first := status.Phase.LastTransitionTime

			setPhase(status, aiv1alpha1.PhaseRunning, reasonRunning)

			Expect(status.Phase.LastTransitionTime).NotTo(BeIdenticalTo(first))
			Expect(status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
		})
	})

	Describe("condition helper idempotency", func() {
		It("preserves LastTransitionTime when an unchanged condition is re-set", func() {
			conditions := []metav1.Condition{}
			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionTrue, reasonRunning, "ready")
			first := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime

			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionTrue, reasonRunning, "ready")

			Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime).To(Equal(first))
		})

		It("updates LastTransitionTime only when the condition status flips", func() {
			conditions := []metav1.Condition{}
			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionTrue, reasonRunning, "ready")
			first := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime

			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionFalse, reasonStopped, "stopped")

			Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime).NotTo(Equal(first))
		})
	})

	Describe("desiredNetworkPolicy", func() {
		env := &aiv1alpha1.DevEnvironment{
			ObjectMeta: metav1.ObjectMeta{Name: "de-netpol", Namespace: "ns"},
		}

		It("admits nothing while no dataplane namespace is configured", func() {
			np := (&DevEnvironmentReconciler{}).desiredNetworkPolicy(env, nil)

			Expect(np.Spec.Ingress).To(BeEmpty())
			Expect(np.Spec.PolicyTypes).To(Equal([]networkingv1.PolicyType{
				networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress,
			}))
			// DNS, and nothing else. nil is what an environment that carries no
			// activity agent is rendered with, so this is also the assertion that
			// the apiserver allowance does not reach environments that never asked
			// for one.
			Expect(np.Spec.Egress).To(HaveLen(1))
		})

		It("adds the agent's apiserver allowance to the DNS rule", func() {
			agentEgress := []networkingv1.NetworkPolicyEgressRule{{
				To: []networkingv1.NetworkPolicyPeer{{
					IPBlock: &networkingv1.IPBlock{CIDR: "10.96.0.1/32"},
				}},
			}}

			np := (&DevEnvironmentReconciler{}).desiredNetworkPolicy(env, agentEgress)

			// Appended, so DNS stays the first rule an operator reads.
			Expect(np.Spec.Egress).To(HaveLen(2))
			// The DNS rule scopes by port and not by peer: where a cluster
			// resolves is the cluster's to choose, so a peer named here would be
			// a guess that resolves nothing wherever it guessed wrong.
			Expect(np.Spec.Egress[0].To).To(BeEmpty())
			Expect(np.Spec.Egress[0].Ports).To(HaveLen(2))
			Expect(np.Spec.Egress[1]).To(Equal(agentEgress[0]))
		})

		It("admits the configured Gateway's dataplane", func() {
			r := &DevEnvironmentReconciler{Config: DevEnvironmentControllerConfig{
				GatewayDataplaneNamespace: testGatewayDataplaneNamespace,
			}}

			np := r.desiredNetworkPolicy(env, nil)

			Expect(np.Spec.Ingress).To(HaveLen(1))
			Expect(np.Spec.Ingress[0].From).To(HaveLen(1))
			Expect(np.Spec.Ingress[0].From[0].NamespaceSelector.MatchLabels).To(Equal(map[string]string{
				namespaceNameLabel: testGatewayDataplaneNamespace,
			}))
			// The Gateway's own name and namespace are defaulted, not required
			// from config, and both label the peer.
			Expect(np.Spec.Ingress[0].From[0].PodSelector.MatchLabels).To(Equal(map[string]string{
				gatewayDataplaneNameLabel:      defaultGatewayName,
				gatewayDataplaneNamespaceLabel: defaultGatewayNamespace,
			}))
		})

		It("admits the peer without naming a port", func() {
			r := &DevEnvironmentReconciler{Config: DevEnvironmentControllerConfig{
				GatewayDataplaneNamespace: testGatewayDataplaneNamespace,
			}}

			// An environment's ports vary by spec.type and spec.ports, so naming
			// one here would admit it and silently refuse the rest.
			Expect(r.desiredNetworkPolicy(env, nil).Spec.Ingress[0].Ports).To(BeEmpty())
		})
	})

	Describe("apiserverEgress", func() {
		// An Endpoints is a set: neither its addresses nor its ports carry an
		// order, so both are listed below in an order the rendered rule must not
		// inherit. The rule is compared against the live NetworkPolicy to decide
		// whether to write, and that policy is owned by the environment, so a
		// render that followed the object would buy an update — and the reconcile
		// that write enqueues — for the apiserver publishing the same set in a
		// different order.
		newReconciler := func() *DevEnvironmentReconciler {
			scheme := runtime.NewScheme()
			Expect(corev1.AddToScheme(scheme)).To(Succeed())

			live := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
				&corev1.Service{
					ObjectMeta: metav1.ObjectMeta{Name: kubernetesServiceName, Namespace: metav1.NamespaceDefault},
					Spec: corev1.ServiceSpec{
						ClusterIPs: []string{"10.0.0.1"},
						Ports:      []corev1.ServicePort{{Name: "https", Port: 443, Protocol: corev1.ProtocolTCP}},
					},
				},
				//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; it is what the rule reads.
				&corev1.Endpoints{
					ObjectMeta: metav1.ObjectMeta{Name: kubernetesServiceName, Namespace: metav1.NamespaceDefault},
					//nolint:staticcheck // The deprecated object's own subset type.
					Subsets: []corev1.EndpointSubset{{
						Addresses: []corev1.EndpointAddress{{IP: "10.0.0.9"}, {IP: "10.0.0.3"}},
						Ports: []corev1.EndpointPort{
							{Port: 6443, Protocol: corev1.ProtocolTCP},
							{Port: 5000, Protocol: corev1.ProtocolTCP},
						},
					}},
				},
			).Build()
			return &DevEnvironmentReconciler{Client: live}
		}

		idleEnv := func() *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-egress", Namespace: testNamespace},
				Spec: aiv1alpha1.DevEnvironmentSpec{
					Lifecycle: &aiv1alpha1.LifecycleSpec{IdleTimeout: 3600},
				},
			}
		}

		It("renders the apiserver's addresses and ports in a canonical order", func() {
			rules, err := newReconciler().apiserverEgress(context.Background(), idleEnv())
			Expect(err).NotTo(HaveOccurred())
			Expect(rules).To(HaveLen(1))

			tcp := corev1.ProtocolTCP
			port := func(p int32) *intstr.IntOrString { v := intstr.FromInt32(p); return &v }

			// Ascending, so one set of endpoints always renders one rule. The
			// ClusterIP and the endpoint addresses are a single list here: which
			// of them came from which object is not part of the contract.
			Expect(rules[0].To).To(Equal([]networkingv1.NetworkPolicyPeer{
				{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.1/32"}},
				{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.3/32"}},
				{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.9/32"}},
			}))
			Expect(rules[0].Ports).To(Equal([]networkingv1.NetworkPolicyPort{
				{Protocol: &tcp, Port: port(443)},
				{Protocol: &tcp, Port: port(5000)},
				{Protocol: &tcp, Port: port(6443)},
			}))
		})
	})
})

var _ = Describe("emitLifecycleTransition", func() {
	// envName is the DevEnvironment used by the specs below.
	const envName = "de-emit"

	// recordedEvent is one Event the reconciler's recorder saw, reduced to the
	// (type, reason) pair the emit calls use.
	type recordedEvent struct {
		typ    string
		reason string
	}

	// newRecorder returns a reconciler wired to an events.FakeRecorder plus a
	// drain that returns every (type, reason) pair recorded since the last call.
	newRecorder := func() (*DevEnvironmentReconciler, func() []recordedEvent) {
		fr := events.NewFakeRecorder(64)
		r := &DevEnvironmentReconciler{Recorder: fr}
		drain := func() []recordedEvent {
			out := []recordedEvent{}
			for {
				select {
				case msg := <-fr.Events:
					// FakeRecorder formats each emit as "<type> <reason> <note>".
					f := strings.Fields(msg)
					if len(f) >= 2 {
						out = append(out, recordedEvent{typ: f[0], reason: f[1]})
					}
				default:
					return out
				}
			}
		}
		return r, drain
	}

	// at returns an environment whose status records the given phase, i.e. the
	// last phase the controller persisted before the reconcile under test.
	at := func(phase aiv1alpha1.PhaseName) *aiv1alpha1.DevEnvironment {
		env := &aiv1alpha1.DevEnvironment{ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace}}
		if phase != "" {
			setPhase(&env.Status, phase, "")
		}
		return env
	}

	It("records each transition exactly once and stays quiet on a repeat of the same phase", func() {
		r, drain := newRecorder()
		pending := at(aiv1alpha1.PhasePending)

		// Entering Running from Pending records one Started Event.
		running := at(aiv1alpha1.PhaseRunning)
		r.emitLifecycleTransition(pending, running)
		Expect(drain()).To(Equal([]recordedEvent{{typ: corev1.EventTypeNormal, reason: eventReasonStarted}}))

		// A later reconcile that derives Running again must not record another.
		r.emitLifecycleTransition(running, at(aiv1alpha1.PhaseRunning))
		Expect(drain()).To(BeEmpty())

		// Running -> Stopped records one Stopped Event; repeats stay quiet.
		stopped := at(aiv1alpha1.PhaseStopped)
		r.emitLifecycleTransition(running, stopped)
		Expect(drain()).To(Equal([]recordedEvent{{typ: corev1.EventTypeNormal, reason: eventReasonStopped}}))
		r.emitLifecycleTransition(stopped, at(aiv1alpha1.PhaseStopped))
		Expect(drain()).To(BeEmpty())

		// Entering Failed records one Warning Failed Event; repeats stay quiet.
		r.emitLifecycleTransition(running, at(aiv1alpha1.PhaseFailed))
		Expect(drain()).To(Equal([]recordedEvent{{typ: corev1.EventTypeWarning, reason: eventReasonFailed}}))
		r.emitLifecycleTransition(at(aiv1alpha1.PhaseFailed), at(aiv1alpha1.PhaseFailed))
		Expect(drain()).To(BeEmpty())
	})

	It("names an idle stop apart from the one the user asked for", func() {
		r, drain := newRecorder()

		// Reaching Stopped by the clock is the same phase transition, so the
		// reason is the only thing on the timeline that tells the two apart.
		idled := at(aiv1alpha1.PhaseStopped)
		idled.Status.Phase.Reason = reasonIdleTimeout

		r.emitLifecycleTransition(at(aiv1alpha1.PhaseRunning), idled)
		Expect(drain()).To(Equal([]recordedEvent{{typ: corev1.EventTypeNormal, reason: reasonIdleTimeout}}))

		// It is still a repeat of Stopped, so the suppression is unchanged.
		r.emitLifecycleTransition(idled, at(aiv1alpha1.PhaseStopped))
		Expect(drain()).To(BeEmpty())
	})

	It("does not record a Stopped Event for an environment that never started", func() {
		r, drain := newRecorder()
		r.emitLifecycleTransition(at(""), at(aiv1alpha1.PhaseStopped))
		Expect(drain()).To(BeEmpty())
	})
})

var _ = Describe("DevEnvironment object rendering and publishing", func() {
	Describe("mainContainerPort", func() {
		It("maps jupyter to the 8888 web port", func() {
			Expect(mainContainerPort(aiv1alpha1.DevEnvironmentTypeJupyter)).To(Equal(int32(8888)))
		})

		It("maps ssh to the unprivileged port the images' sshd binds", func() {
			Expect(mainContainerPort(aiv1alpha1.DevEnvironmentTypeSSH)).To(Equal(int32(2222)))
		})

		It("maps vscode to the 8080 code-server port", func() {
			Expect(mainContainerPort(aiv1alpha1.DevEnvironmentTypeVSCode)).To(Equal(int32(8080)))
		})
	})

	Describe("desiredResources", func() {
		It("requests and limits the nvidia gpu by count", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPU: &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Count: ptrTo(int32(2))},
			}}}
			got := desiredResources(env, "")
			key := corev1.ResourceName(testGPUResource)
			Expect(got.Requests).To(HaveKey(key))
			Expect(got.Limits).To(HaveKey(key))
			req := got.Requests[key]
			lim := got.Limits[key]
			Expect(req.Value()).To(Equal(int64(2)))
			Expect(lim.Value()).To(Equal(int64(2)))
		})

		It("maps a metax vendor to the metax-tech.com/gpu resource", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPU: &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorMetax, Count: ptrTo(int32(1))},
			}}}
			got := desiredResources(env, "")
			key := corev1.ResourceName("metax-tech.com/gpu")
			Expect(got.Requests).To(HaveKey(key))
			Expect(got.Limits).To(HaveKey(key))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
		})

		It("maps optional cpu and memory to limits only", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPU: &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Count: ptrTo(int32(1))}, CPU: "16", Memory: "32Gi",
			}}}
			got := desiredResources(env, "")
			Expect(got.Limits.Cpu().Cmp(resource.MustParse("16"))).To(Equal(0))
			Expect(got.Limits.Memory().Cmp(resource.MustParse("32Gi"))).To(Equal(0))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceCPU))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceMemory))
		})

		It("omits the gpu entirely when no block is present", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				CPU: "4", Memory: "8Gi",
			}}}
			got := desiredResources(env, "")
			// Neither vendor: a zero request would still pin the pod to a node
			// advertising that resource.
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceName("metax-tech.com/gpu")))
			Expect(got.Limits).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(got.Limits).NotTo(HaveKey(corev1.ResourceName("metax-tech.com/gpu")))
			Expect(got.Limits.Cpu().Cmp(resource.MustParse("4"))).To(Equal(0))
			Expect(got.Limits.Memory().Cmp(resource.MustParse("8Gi"))).To(Equal(0))
		})

		It("treats an unset count as the schema default of 1", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPU: &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorNvidia},
			}}}
			got := desiredResources(env, "")
			key := corev1.ResourceName(testGPUResource)
			Expect(got.Requests).To(HaveKey(key))
			req := got.Requests[key]
			lim := got.Limits[key]
			Expect(req.Value()).To(Equal(int64(1)))
			Expect(lim.Value()).To(Equal(int64(1)))
		})

		// A Go-constructed block that never went through the API server can carry
		// halves the CRD would have filled. Every reader has to resolve them the
		// same way, or the vendor resource and the brand gate disagree about what
		// was asked for — which is the bug the block replaced two flat fields to
		// make unrepresentable.
		It("resolves an unset vendor to nvidia rather than to no vendor at all", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPU: &aiv1alpha1.GPUSpec{Count: ptrTo(int32(1))},
			}}}
			got := desiredResources(env, "")
			Expect(got.Requests).To(HaveKey(corev1.ResourceName(testGPUResource)))
		})

		// Minimum=1 means the API can never produce a count of zero; only a
		// hand-built spec can. Clamping it to the schema default is what keeps the
		// resource request and the brand gate in agreement — reading it as "no
		// accelerator" would put a second route to CPU-only back into the model.
		It("clamps a count below the minimum to 1 rather than reading it as no gpu", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPU: &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Count: ptrTo(int32(0))},
			}}}
			vendor, count, ok := desiredGPU(env)
			Expect(ok).To(BeTrue())
			Expect(vendor).To(Equal(aiv1alpha1.AcceleratorVendorNvidia))
			Expect(count).To(Equal(int32(1)))

			got := desiredResources(env, "")
			key := corev1.ResourceName(testGPUResource)
			Expect(got.Requests).To(HaveKey(key))
			req := got.Requests[key]
			Expect(req.Value()).To(Equal(int64(1)))
		})

		// One device is what the shared plugin advertises per environment; its
		// rdmaHcaMax is the cap on how many environments may share an HCA, not a
		// per-pod count, so there is nothing for the spec to vary.
		//
		// Requests and limits both carry it: a resource in limits alone would be
		// counted against the node's allocatable and the scheduler would still
		// admit the pod to a node without the device.
		It("requests and limits a single rdma device", func() {
			key := corev1.ResourceName("rdma/ib_shared_devices")
			got := desiredResources(&aiv1alpha1.DevEnvironment{}, key)
			Expect(got.Requests).To(HaveKey(key))
			Expect(got.Limits).To(HaveKey(key))
			req := got.Requests[key]
			lim := got.Limits[key]
			Expect(req.Value()).To(Equal(int64(1)))
			Expect(lim.Value()).To(Equal(int64(1)))
		})

		It("adds no rdma resource when none is requested", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPU: &aiv1alpha1.GPUSpec{Count: ptrTo(int32(1))},
			}}}
			gpu := corev1.ResourceName(testGPUResource)
			got := desiredResources(env, "")
			// The accelerator is all there is: an RDMA entry left at zero would
			// still pin the pod to a node advertising the device.
			Expect(got.Requests).To(HaveLen(1))
			Expect(got.Limits).To(HaveLen(1))
			req := got.Requests[gpu]
			lim := got.Limits[gpu]
			Expect(req.Value()).To(Equal(int64(1)))
			Expect(lim.Value()).To(Equal(int64(1)))
		})
	})

	Describe("rdmaResource", func() {
		envWith := func(network *aiv1alpha1.NetworkSpec) *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Network: network}}
		}

		It("resolves the configured names, and hostNetwork only for roce", func() {
			r := &DevEnvironmentReconciler{Config: DevEnvironmentControllerConfig{
				RDMAIBResource: testRDMAIBResource, RDMARoCEResource: testRDMARoCEResource,
			}}
			name, hostNetwork := r.rdmaResource(envWith(&aiv1alpha1.NetworkSpec{
				RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeInfiniBand,
			}))
			Expect(name).To(Equal(corev1.ResourceName(testRDMAIBResource)))
			Expect(hostNetwork).To(BeFalse())

			name, hostNetwork = r.rdmaResource(envWith(&aiv1alpha1.NetworkSpec{
				RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeRoCE,
			}))
			Expect(name).To(Equal(corev1.ResourceName(testRDMARoCEResource)))
			Expect(hostNetwork).To(BeTrue())
		})

		It("falls back to the plugin's conventional names when unconfigured", func() {
			r := &DevEnvironmentReconciler{}
			name, _ := r.rdmaResource(envWith(&aiv1alpha1.NetworkSpec{
				RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeInfiniBand,
			}))
			Expect(name).To(Equal(corev1.ResourceName(defaultRDMAIBResource)))
			name, _ = r.rdmaResource(envWith(&aiv1alpha1.NetworkSpec{
				RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeRoCE,
			}))
			Expect(name).To(Equal(corev1.ResourceName(defaultRDMARoCEResource)))
		})

		It("requests nothing when network is absent or RDMA is off", func() {
			r := &DevEnvironmentReconciler{}
			// spec.network has no CRD default on the parent, so it is nil on an
			// environment that never mentioned it — which is the common case.
			name, hostNetwork := r.rdmaResource(envWith(nil))
			Expect(name).To(BeEmpty())
			Expect(hostNetwork).To(BeFalse())

			// rdmaType carries a default of roce even here, so the enabled flag is
			// what has to gate this: branching on the type alone would put every
			// environment in the cluster on the host network.
			name, hostNetwork = r.rdmaResource(envWith(&aiv1alpha1.NetworkSpec{RDMAEnabled: false}))
			Expect(name).To(BeEmpty())
			Expect(hostNetwork).To(BeFalse())
		})
	})

	Describe("brandMismatchReason", func() {
		DescribeTable("gates the image brand against the requested accelerator",
			func(image string, gpu *aiv1alpha1.GPUSpec, wantMatch bool) {
				env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
					Image:     image,
					Resources: aiv1alpha1.ResourcesSpec{GPU: gpu},
				}}
				reason := brandMismatchReason(env)
				if wantMatch {
					Expect(reason).To(BeEmpty())
				} else {
					Expect(reason).NotTo(BeEmpty())
				}
			},
			Entry("nvidia with a base-cuda image matches", testDevImage, nvidiaGPU(), true),
			Entry("nvidia with a base-maca image mismatches", testBaseMacaImage, nvidiaGPU(), false),
			Entry("metax with a base-cuda image mismatches", testDevImage, metaxGPU(), false),
			Entry("metax with a mirrored maca-pytorch image matches", testMetaxImage, metaxGPU(), true),
			Entry("metax with an unqualified maca image matches", testBareMacaImage, metaxGPU(), true),
			Entry("metax with an uppercase reference matches", strings.ToUpper(testMetaxImage), metaxGPU(), true),
			// The rule reads the whole reference, so a path segment alone can
			// satisfy it. That is the price of one rule for both vendors: the
			// gate asks whether the name states its vendor, not whether the
			// reference points at a real platform image.
			Entry("metax with maca only in the path matches", testMacaInPathImage, metaxGPU(), true),
			// base-maca spells the metax token, so it satisfies the rule on its
			// own terms — the token is what is checked, not the product name the
			// platform happens to publish under.
			Entry("metax with a base-maca image matches", testBaseMacaImage, metaxGPU(), true),
			// No accelerator ⇒ nothing to match, whatever the image. The block's
			// absence is the only spelling of this, so there is no count to zero out
			// and no vendor left over to contradict it.
			Entry("an absent block exempts a non-brand image", testCPUImage, nil, true),
			Entry("an absent block exempts a mismatched image", testBaseMacaImage, nil, true),
			// desiredGPU resolves the vendor before the comparison, and it
			// recognises metax as the only alternative to its nvidia default — so
			// a value the API can never store lands on the nvidia rule rather
			// than falling out of the switch and disabling the gate. The first
			// entry holds because base-maca carries the metax token, which the
			// nvidia rule does not accept; the second pins the resolution itself,
			// since that image satisfies the metax rule but not this one.
			Entry("an unrecognised vendor is still gated",
				testBaseMacaImage, &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendor("amd"), Count: ptrTo(int32(1))}, false),
			Entry("an unrecognised vendor follows the nvidia rule",
				testDevImage, &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendor("amd"), Count: ptrTo(int32(1))}, true),
		)

		It("names the CPU-only escape in the mismatch message", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Image:     testBaseMacaImage,
				Resources: aiv1alpha1.ResourcesSpec{GPU: nvidiaGPU()},
			}}
			Expect(brandMismatchReason(env)).To(ContainSubstring("omit spec.resources.gpu"))
		})
	})

	Describe("specFindings", func() {
		// The smallest environment these checks are about: a jupyter environment
		// with no gpu block, so the brand gate stays out of every case that is not
		// about it.
		newJupyter := func() *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Type: aiv1alpha1.DevEnvironmentTypeJupyter, Image: testDevImage,
			}}
		}
		// root resolves the security context the launcher checks read, without
		// touching any runtime env the case declares.
		root := func(env *aiv1alpha1.DevEnvironment) *aiv1alpha1.DevEnvironment {
			if env.Spec.Runtime == nil {
				env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{}
			}
			env.Spec.Runtime.SecurityContext = &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))}
			return env
		}
		declaring := func(env *aiv1alpha1.DevEnvironment, vars ...corev1.EnvVar) *aiv1alpha1.DevEnvironment {
			if env.Spec.Runtime == nil {
				env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{}
			}
			env.Spec.Runtime.Env = append(env.Spec.Runtime.Env, vars...)
			return env
		}
		// A workspace claim, so the controller states a home at all.
		claiming := func(env *aiv1alpha1.DevEnvironment) *aiv1alpha1.DevEnvironment {
			env.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize}
			return env
		}
		// The derivation prefers a usable declared home, so a pinned mountPath is
		// the one way a declared home loses.
		pinned := func(env *aiv1alpha1.DevEnvironment) *aiv1alpha1.DevEnvironment {
			claiming(env)
			env.Spec.Storage.MountPath = testPinnedMountPath
			return env
		}
		// A home the derivation cannot use, which is why the claim is what decides
		// the path here.
		homeFrom := func(env *aiv1alpha1.DevEnvironment) *aiv1alpha1.DevEnvironment {
			return declaring(env, corev1.EnvVar{
				Name: homeEnv,
				ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: "platform-home"}, Key: "workspace",
				}},
			})
		}
		// A mismatch needs a gpu block and an image that does not name its vendor.
		mismatched := func() *aiv1alpha1.DevEnvironment {
			env := newJupyter()
			env.Spec.Image = testBaseMacaImage
			env.Spec.Resources.GPU = nvidiaGPU()
			return env
		}
		// unreadable NOTEBOOK_ARGS: the one refusal that is not about the brand.
		fromValueFrom := func() *aiv1alpha1.DevEnvironment {
			return declaring(newJupyter(), corev1.EnvVar{
				Name: notebookArgsEnv,
				ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: "notebook-args"}, Key: "args",
				}},
			})
		}
		// An extra application port, and an ssh exposure for it to collide with.
		exposing := func(env *aiv1alpha1.DevEnvironment, ports ...aiv1alpha1.PortSpec) *aiv1alpha1.DevEnvironment {
			env.Spec.Ports = append(env.Spec.Ports, ports...)
			return env
		}
		withSSH := func(env *aiv1alpha1.DevEnvironment) *aiv1alpha1.DevEnvironment {
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			return env
		}

		// Each entry states the disposition it expects, not just that something was
		// reported: the whole point of the condition is which of the two a value
		// gets, so a check that quietly refused a value the render path resolves
		// would pass a message-only assertion.
		DescribeTable("classifies every value the controller resolves",
			func(env *aiv1alpha1.DevEnvironment, wantBlocking int, want []string) {
				found := specFindings(env)
				Expect(mustUpdateFindings(found)).To(HaveLen(wantBlocking))
				message := findingsMessage(found)
				for _, clause := range want {
					Expect(message).To(ContainSubstring(clause))
				}
			},
			Entry("a brand mismatch must be updated",
				mismatched(), 1, []string{`spec.resources.gpu.vendor: must be updated — image "` + testBaseMacaImage}),
			Entry("an unreadable NOTEBOOK_ARGS must be updated",
				fromValueFrom(), 1, []string{"spec.runtime.env[NOTEBOOK_ARGS]: must be updated"}),
			Entry("a declared launcher account is ignored when the environment is root",
				declaring(root(newJupyter()), corev1.EnvVar{Name: nbGIDEnv, Value: "1000"}), 0,
				[]string{"spec.runtime.env[NB_GID]: ignored — "}),
			Entry("a declared JUPYTER_TOKEN is ignored",
				declaring(newJupyter(), corev1.EnvVar{Name: jupyterTokenEnv, Value: "chosen"}), 0,
				[]string{"spec.runtime.env[JUPYTER_TOKEN]: ignored — "}),
			Entry("a declared base_url is ignored",
				declaring(newJupyter(), corev1.EnvVar{Name: notebookArgsEnv, Value: "--ServerApp.allow_origin=* " + notebookBaseURLFlag + "/served/elsewhere/"}), 0,
				[]string{"spec.runtime.env[NOTEBOOK_ARGS]: ignored — " + notebookBaseURLFlag + "/served/elsewhere/ is replaced by " + notebookBaseURLFlag}),
			Entry("a declared runtime account is ignored when the environment is root",
				root(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
					Type: aiv1alpha1.DevEnvironmentTypeJupyter, Image: testDevImage,
					Runtime: &aiv1alpha1.RuntimeSpec{User: testRuntimeUser},
				}}), 0, []string{"spec.runtime.user: ignored — "}),
			// The claim is the workspace and the container is told where it is, so a
			// declared home is not outranked but replaced — by the path the claim
			// mounts at, which a pinned mountPath has already moved.
			Entry("a declared home a pinned mountPath outranks",
				pinned(declaring(newJupyter(), corev1.EnvVar{Name: homeEnv, Value: "/srv/elsewhere"})), 0,
				[]string{"spec.runtime.env[HOME]: ignored — "}),
			Entry("a home the derivation cannot use",
				claiming(homeFrom(newJupyter())), 0,
				[]string{"spec.runtime.env[HOME]: ignored — "}),
			// An exposure on a port the Service already publishes is folded into the
			// entry that carries it, and which disposition it gets is decided by
			// where that entry forwards (::portCollisionFindings).
			//
			// A repeat of the type's own main port folds into an entry forwarding to
			// the same container port, so the exposure is served exactly as declared
			// and only the name it was declared under goes unused.
			Entry("a repeat of the notebook's own port is ignored",
				exposing(newJupyter(), aiv1alpha1.PortSpec{
					Name: "notebook-again", Type: aiv1alpha1.PortTypeHTTP,
					ContainerPort: mainContainerPort(aiv1alpha1.DevEnvironmentTypeJupyter),
				}), 0, []string{"spec.ports[0]: ignored — "}),
			// As does a repeat of an earlier exposure: the Service carries the number
			// once, and both entries forward to the port they name.
			Entry("a second exposure on one container port is ignored",
				exposing(newJupyter(),
					aiv1alpha1.PortSpec{Name: testMetricsPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 9090},
					aiv1alpha1.PortSpec{Name: "metrics-again", Type: aiv1alpha1.PortTypeTCP, ContainerPort: 9090},
				), 0, []string{"spec.ports[1]: ignored — "}),
			// The other side of the ssh bridge is not published, so an exposure on it
			// is an entry of its own rather than a repeat.
			Entry("an exposure on the port the ssh bridge forwards to",
				exposing(withSSH(newJupyter()), aiv1alpha1.PortSpec{
					Name: "raw-ssh", Type: aiv1alpha1.PortTypeTCP, ContainerPort: sshContainerPort,
				}), 0, nil),
			// The same number under another protocol is a different Service port, so
			// neither folds into the other.
			Entry("a udp exposure on the notebook's port",
				exposing(newJupyter(), aiv1alpha1.PortSpec{
					Name: testSyslogPortName, Type: aiv1alpha1.PortTypeUDP,
					ContainerPort: mainContainerPort(aiv1alpha1.DevEnvironmentTypeJupyter),
				}), 0, nil),
			// Both dispositions in one spec: the refusal is what the phase follows,
			// and the resolved value is reported beside it rather than instead of it.
			Entry("reports a refusal and a resolved value together",
				declaring(root(mismatched()), corev1.EnvVar{Name: nbUIDEnv, Value: "1000"}), 1,
				[]string{
					"spec.resources.gpu.vendor: must be updated — ",
					"spec.runtime.env[NB_UID]: ignored — ",
				}),
		)

		// The fold that is not lossless, and so is not a resolved value: the ssh
		// bridge is published at 22 and forwards to the sshd on 2222, so an exposure
		// declaring container port 22 would have its route reach sshd rather than
		// the workload it named, and no other port carries what it asks for. Only
		// the user can choose another port, which is what mustUpdate says.
		It("fails an exposure the ssh bridge would answer for", func() {
			env := exposing(withSSH(newJupyter()),
				aiv1alpha1.PortSpec{Name: testCollidingPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: sshServicePort})
			blocking := mustUpdateFindings(specFindings(env))
			Expect(blocking).To(HaveLen(1))
			Expect(blocking[0].reason).To(Equal(reasonPortCollision))
			Expect(blocking[0].field).To(Equal("ports[0]"))
			Expect(blocking[0].detail).To(ContainSubstring(
				fmt.Sprintf("forwards to container port %d rather than the %d this entry declares",
					sshContainerPort, sshServicePort)))
		})

		// The ssh type publishes its own bridge as the main entry, so its two sides
		// are the same divergence and the same refusal.
		It("fails an exposure on the ssh type's own bridge port", func() {
			env := exposing(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Type: aiv1alpha1.DevEnvironmentTypeSSH, Image: testDevImage,
			}}, aiv1alpha1.PortSpec{Name: testCollidingPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: sshServicePort})
			blocking := mustUpdateFindings(specFindings(env))
			Expect(blocking).To(HaveLen(1))
			Expect(blocking[0].reason).To(Equal(reasonPortCollision))
		})

		It("fails the environment on the brand mismatch before any other refusal", func() {
			env := fromValueFrom()
			env.Spec.Image = testBaseMacaImage
			env.Spec.Resources.GPU = nvidiaGPU()
			// The phase and the Accepted reason come from the first must-update
			// finding, so which one leads is part of the contract.
			blocking := mustUpdateFindings(specFindings(env))
			Expect(blocking).To(HaveLen(2))
			Expect(blocking[0].reason).To(Equal(reasonBrandMismatch))
			Expect(blocking[1].reason).To(Equal(reasonNotebookArgsUnusable))
		})

		It("reports nothing for a spec the controller applies as written", func() {
			Expect(specFindings(newJupyter())).To(BeEmpty())
			// And nothing for a value the render path does not resolve either: a
			// non-root environment keeps the account it declares.
			Expect(specFindings(declaring(newJupyter(), corev1.EnvVar{Name: nbGIDEnv, Value: "1000"}))).To(BeEmpty())
		})

		// The home is the mount path, so a spec naming that path agrees with what
		// the container is told rather than losing to it — and an environment with
		// no claim is not resolved at all, home or no home.
		It("reports nothing for the homes the controller applies as written", func() {
			Expect(specFindings(claiming(declaring(newJupyter(),
				corev1.EnvVar{Name: homeEnv, Value: defaultWorkspacePath})))).To(BeEmpty())
			Expect(specFindings(declaring(newJupyter(),
				corev1.EnvVar{Name: homeEnv, Value: "/srv/elsewhere"}))).To(BeEmpty())
			Expect(specFindings(homeFrom(newJupyter()))).To(BeEmpty())
		})

		It("reports nothing for the values an ssh environment's image never reads", func() {
			env := newJupyter()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			declaring(root(env),
				corev1.EnvVar{Name: nbGIDEnv, Value: "1000"},
				corev1.EnvVar{Name: jupyterTokenEnv, Value: "chosen"},
				corev1.EnvVar{Name: notebookArgsEnv, Value: notebookBaseURLFlag + "/served/elsewhere/"},
			)
			Expect(specFindings(env)).To(BeEmpty())
		})

		It("keeps every other NOTEBOOK_ARGS flag out of the message", func() {
			message := findingsMessage(specFindings(declaring(newJupyter(), corev1.EnvVar{
				Name: notebookArgsEnv, Value: "--ServerApp.allow_origin=* " + notebookBaseURLFlag + "/served/elsewhere/ --debug",
			})))
			Expect(message).NotTo(ContainSubstring("allow_origin"))
			Expect(message).NotTo(ContainSubstring("--debug"))
		})
	})

	Describe("desiredSecurityContext", func() {
		It("defaults a nil runtime to non-root uid and gid 1000", func() {
			sc := desiredSecurityContext(nil)
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(true)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(1000))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(1000))))
			Expect(sc.Privileged).To(BeNil())
		})

		It("keeps the non-root defaults when runtime has no security context", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{Command: []string{"sleep"}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(true)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(1000))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(1000))))
		})

		It("honors runAsUser=0 as root and disables runAsNonRoot", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(false)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(0))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(1000))))
		})

		It("honors the explicit runAsGroup when root is requested", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{
				RunAsUser: ptrTo(int64(0)), RunAsGroup: ptrTo(int64(2000)),
			}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(false)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(0))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(2000))))
		})

		It("keeps runAsNonRoot enabled for an explicit non-root user", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(1001))}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(true)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(1001))))
		})
	})

	// The init container is the only thing that makes a claim-backed home
	// writable, and it is deliberately a narrower mechanism than the pod-level
	// fsGroup it replaces: it sees the workspace claim and nothing else, and the
	// privilege it carries is bounded to what changing an owner takes.
	Describe("desiredPermissionInitContainer", func() {
		rt := func(user, group int64) *aiv1alpha1.RuntimeSpec {
			return &aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{
				RunAsUser: ptrTo(user), RunAsGroup: ptrTo(group),
			}}
		}
		initContainer := func(mut func(*aiv1alpha1.DevEnvironment)) corev1.Container {
			// The container reads the spec only, so the fixture carries no metadata.
			env := &aiv1alpha1.DevEnvironment{
				Spec: aiv1alpha1.DevEnvironmentSpec{
					Type: aiv1alpha1.DevEnvironmentTypeSSH, Image: testDevImage,
				},
			}
			if mut != nil {
				mut(env)
			}
			return desiredPermissionInitContainer(env)
		}

		It("initializes the workspace claim to the identity the container runs as", func() {
			c := initContainer(nil)
			Expect(c.Env).To(ContainElements(
				corev1.EnvVar{Name: permissionInitPathEnv, Value: permissionInitMountPath},
				corev1.EnvVar{Name: permissionInitUIDEnv, Value: "1000"},
				corev1.EnvVar{Name: permissionInitGIDEnv, Value: "1000"},
			))
		})

		It("follows an explicit runtime identity, such as the jupyter image's stock gid", func() {
			c := initContainer(func(env *aiv1alpha1.DevEnvironment) { env.Spec.Runtime = rt(1000, 100) })
			Expect(c.Env).To(ContainElements(
				corev1.EnvVar{Name: permissionInitUIDEnv, Value: "1000"},
				corev1.EnvVar{Name: permissionInitGIDEnv, Value: "100"},
			))
		})

		// FOWNER and FSETID are part of the contract, not incidental: the claim
		// outlives the identity it was initialized for, so a root that belongs to
		// the identity the spec used to name is one the container neither owns nor
		// is grouped with — the chmod needs FOWNER to succeed at all, and FSETID to
		// keep the setgid bit. Measured on cs2: without FOWNER the init container
		// dies on EPERM; with FOWNER alone the root lands 0775.
		It("runs as root with CAP_CHOWN, CAP_FOWNER and CAP_FSETID and nothing else", func() {
			sc := initContainer(nil).SecurityContext
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(0))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(0))))
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(false)))
			Expect(sc.Privileged).To(Equal(ptrTo(false)))
			Expect(sc.AllowPrivilegeEscalation).To(Equal(ptrTo(false)))
			Expect(sc.Capabilities.Drop).To(ConsistOf(allCapabilities))
			Expect(sc.Capabilities.Add).To(ConsistOf(
				corev1.Capability("CHOWN"), corev1.Capability("FOWNER"), corev1.Capability("FSETID")))
		})

		It("mounts the workspace claim and no other volume", func() {
			Expect(initContainer(nil).VolumeMounts).To(Equal([]corev1.VolumeMount{
				{Name: workspaceClaimName, MountPath: permissionInitMountPath},
			}))
		})

		// The properties the security model rests on: the script fails the
		// environment rather than letting it start against a volume it could not
		// initialize; the repair is conditional and recursive, so a workspace with
		// the right owner is never walked; and the chmod precedes the chown, so the
		// common path — a claim the container owns — sets the mode with no
		// capability involved. Correctness on the identity-change path rests on the
		// capabilities asserted above, not on that order.
		It("fails closed, and repairs only on a mismatch, all the way down", func() {
			script := initContainer(nil).Command[2]
			Expect(script).To(HavePrefix("set -e\n"))
			Expect(script).To(ContainSubstring(
				`if [ "$current" != "$WORKSPACE_UID:$WORKSPACE_GID" ]; then`))
			Expect(script).To(ContainSubstring(`chown -R "$WORKSPACE_UID:$WORKSPACE_GID" "$WORKSPACE_PATH"`))
			chmod, chown := strings.Index(script, "chmod 2775"),
				strings.Index(script, `chown -R "$WORKSPACE_UID`)
			Expect(chmod).To(BeNumerically("<", chown),
				"the chmod precedes the chown: see ::permissionInitScript")
		})
	})

	Describe("resolveMountPath", func() {
		// The path depends only on spec.storage.mountPath, a declared HOME in
		// spec.runtime.env, and the runtime identity, so the fixture carries
		// nothing else.
		home := func(value string) []corev1.EnvVar {
			return []corev1.EnvVar{{Name: homeEnv, Value: value}}
		}

		env := func(mutate func(*aiv1alpha1.DevEnvironmentSpec)) *aiv1alpha1.DevEnvironment {
			e := &aiv1alpha1.DevEnvironment{}
			if mutate != nil {
				mutate(&e.Spec)
			}
			return e
		}

		It("falls back to the platform default when nothing is set", func() {
			// The default account is "user", but an unset spec.runtime.user means
			// /workspace — not /home/user.
			Expect(resolveMountPath(env(nil))).To(Equal(defaultWorkspacePath))
		})

		It("derives /home/<user> from a named account", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser}
			}))).To(Equal("/home/jovyan"))
		})

		It("derives /root when the container runs as root", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))}}
			}))).To(Equal("/root"))
		})

		It("lets an explicit mountPath win over the derivation", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser}
				s.Storage = &aiv1alpha1.StorageSpec{MountPath: "/mnt/data"}
			}))).To(Equal("/mnt/data"))
		})

		It("prefers root's home when root is requested alongside a named account", func() {
			// Contradictory config: the container runs as root, so /root is the
			// home the workspace has to follow.
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{
					User:            "alice",
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				}
			}))).To(Equal("/root"))
		})

		It("keeps an explicit non-root runAsUser on the account's home", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{
					User:            testRuntimeUser,
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(1000))},
				}
			}))).To(Equal("/home/jovyan"))
		})

		// The root case: a declared HOME beats the /root the identity alone implies.
		// The declaration is where the claim was mounted and where the launcher looks
		// — /home/root is the home a stock docker-stacks image relocates root to, so naming
		// it is how a root environment there keeps its workspace. Otherwise the claim is unused.
		It("lets a declared HOME override the home root's identity implies", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
					Env:             home("/home/root"),
				}
			}))).To(Equal("/home/root"))
		})

		It("lets a declared HOME override a named account's home", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser, Env: home("/srv/jovyan")}
			}))).To(Equal("/srv/jovyan"))
		})

		It("lets an explicit mountPath win over a declared HOME", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser, Env: home("/home/root")}
				s.Storage = &aiv1alpha1.StorageSpec{MountPath: "/mnt/data"}
			}))).To(Equal("/mnt/data"))
		})

		It("ignores a HOME that does not name a path", func() {
			// Each of these is unusable as a mount path — relative, empty, a
			// valueFrom that cannot be read while reconciling, and a $(VAR) the
			// kubelet expands elsewhere — so the convention stands rather than the
			// claim being pinned somewhere arbitrary.
			for _, envVars := range [][]corev1.EnvVar{
				home("relative/home"),
				home(""),
				home("/home/$(USER)"),
				{{Name: homeEnv, ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: podNameFieldPath}}}},
			} {
				Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
					s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser, Env: envVars}
				}))).To(Equal("/home/jovyan"))
			}
		})

		It("lets an unusable final HOME clear an earlier usable one", func() {
			// The container applies the last entry, so an earlier /first is not the
			// home it uses. Falling through beats mounting the claim at a path the
			// workload does not read.
			for _, envVars := range [][]corev1.EnvVar{
				append(home("/first"), home("relative")...),
				append(home("/first"), corev1.EnvVar{Name: homeEnv, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: "some-secret"}, Key: "home",
				}}}),
			} {
				Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
					s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser, Env: envVars}
				}))).To(Equal("/home/jovyan"))
			}
		})

		It("takes the last of several declared HOMEs", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{
					User: testRuntimeUser,
					Env:  append(home("/first"), home("/second")...),
				}
			}))).To(Equal("/second"))
		})
	})

	Describe("runtimeUser", func() {
		It("advertises the account the spec names", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Runtime: &aiv1alpha1.RuntimeSpec{User: testRuntimeUser},
			}})).To(Equal(testRuntimeUser))
		})

		It("falls back to the platform default account", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{})).To(Equal("user"))
		})

		It("falls back when the runtime is present but names no account", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Runtime: &aiv1alpha1.RuntimeSpec{Command: []string{"sleep"}},
			}})).To(Equal("user"))
		})

		It("serves root when the environment runs as root, naming no account", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Runtime: &aiv1alpha1.RuntimeSpec{
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				},
			}})).To(Equal(rootRuntimeUser))
		})

		It("serves root when the environment runs as root and names an image account", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Runtime: &aiv1alpha1.RuntimeSpec{
					User:            testRuntimeUser,
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				},
			}})).To(Equal(rootRuntimeUser))
		})
	})

	Describe("buildEndpoints", func() {
		// The account in the address is the only place a user learns which account
		// to log in as, so a root environment must not publish the spec's account
		// there: its sshd runs as root and serves that uid.
		It("advertises root for an environment that runs as root", func() {
			env := &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-root", Namespace: testNamespace},
				Spec: aiv1alpha1.DevEnvironmentSpec{
					Type: aiv1alpha1.DevEnvironmentTypeJupyter,
					SSH:  &aiv1alpha1.SSHSpec{Enabled: true},
					Runtime: &aiv1alpha1.RuntimeSpec{
						User:            testRuntimeUser,
						SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
					},
				},
			}
			status := &aiv1alpha1.DevEnvironmentStatus{}
			(&DevEnvironmentReconciler{}).buildEndpoints(env, status, testGatewayIP,
				map[string]int32{sshPortName: 20001}, map[int32]int32{20001: 20001})
			Expect(status.Endpoints).To(ContainElement(aiv1alpha1.Endpoint{
				Name:         sshPortName,
				Address:      fmt.Sprintf("ssh://%s@%s:20001", rootRuntimeUser, testGatewayIP),
				ListenerPort: 20001,
			}))
		})
	})

	Describe("withdrawStoppedEndpoints", func() {
		// The phase is what says an environment is stopped, and both its reasons —
		// a user's running=false and an idle auto-stop — land on the same name, so
		// one rule covers them both (::setPhaseAndReady).
		endpoints := func() []aiv1alpha1.Endpoint {
			return []aiv1alpha1.Endpoint{{
				Name: sshPortName, Address: testGatewayIP + ":20001", ListenerPort: 20001,
			}}
		}

		It("withdraws the address of a stopped environment", func() {
			// An ssh exposure loses its address whether this withholds it or not:
			// the gateway rejects its L4 route once the workload is scaled to zero.
			// A web address has no such route to go away for it, which is what makes
			// this the case the rule exists for.
			status := &aiv1alpha1.DevEnvironmentStatus{
				Phase:     &aiv1alpha1.Phase{Name: aiv1alpha1.PhaseStopped},
				Endpoints: endpoints(),
			}
			withdrawStoppedEndpoints(status)
			Expect(status.Endpoints).To(BeEmpty())
		})

		It("keeps the address of a running environment", func() {
			status := &aiv1alpha1.DevEnvironmentStatus{
				Phase:     &aiv1alpha1.Phase{Name: aiv1alpha1.PhaseRunning},
				Endpoints: endpoints(),
			}
			withdrawStoppedEndpoints(status)
			Expect(status.Endpoints).To(HaveLen(1))
		})

		It("keeps the address of an environment whose phase is not recorded yet", func() {
			// Nothing about an absent phase says the environment is stopped, and the
			// address is what a user was handed the moment it was published.
			status := &aiv1alpha1.DevEnvironmentStatus{Endpoints: endpoints()}
			withdrawStoppedEndpoints(status)
			Expect(status.Endpoints).To(HaveLen(1))
		})
	})

	Describe("desiredPodSpec", func() {
		newEnv := func() *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-render", Namespace: "default"},
				Spec: aiv1alpha1.DevEnvironmentSpec{
					Type: aiv1alpha1.DevEnvironmentTypeVSCode, Image: testDevImage,
				},
			}
		}
		render := func(mut func(*aiv1alpha1.DevEnvironment)) corev1.PodSpec {
			env := newEnv()
			if mut != nil {
				mut(env)
			}
			return (&DevEnvironmentReconciler{}).desiredPodSpec(env)
		}

		// An unset profile is Unconfined on Kubernetes, which the Restricted Pod
		// Security Standard refuses outright: without this, no environment could
		// run in a restricted namespace, storage or not. Pod-level rather than
		// per-container, so the workspace-ownership init container inherits it.
		It("applies the runtime default seccomp profile to the pod", func() {
			Expect(render(nil).SecurityContext).To(Equal(&corev1.PodSecurityContext{
				SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
			}))
		})

		// Host networking is the difference between the two fabrics, not an
		// independent switch: a RoCE device derives its GID table from the
		// addresses of the interfaces in the pod's network namespace, and a
		// pod-only namespace has none of the fabric's.
		It("keeps an InfiniBand environment on the pod network", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Network = &aiv1alpha1.NetworkSpec{
					RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeInfiniBand,
				}
			})
			Expect(spec.HostNetwork).To(BeFalse())
			Expect(spec.DNSPolicy).NotTo(Equal(corev1.DNSClusterFirstWithHostNet))
			c := spec.Containers[0]
			Expect(c.Resources.Requests).To(HaveKey(corev1.ResourceName(defaultRDMAIBResource)))
			Expect(c.Resources.Limits).To(HaveKey(corev1.ResourceName(defaultRDMAIBResource)))
			Expect(c.Resources.Requests).NotTo(HaveKey(corev1.ResourceName(defaultRDMARoCEResource)))
			// Nothing is bound on the node, so nothing is declared: the ports
			// only exist to tell the scheduler what a host-network environment
			// has taken.
			Expect(c.Ports).To(BeEmpty())
			Expect(c.SecurityContext.Capabilities.Add).To(ContainElement(corev1.Capability("IPC_LOCK")))
		})

		It("runs a RoCE environment on the host network, with its ports declared as host ports", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Network = &aiv1alpha1.NetworkSpec{
					RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeRoCE,
				}
			})
			Expect(spec.HostNetwork).To(BeTrue())
			// ClusterFirst degrades to the node's own resolver on the host
			// network, which stops cluster service names resolving.
			Expect(spec.DNSPolicy).To(Equal(corev1.DNSClusterFirstWithHostNet))
			c := spec.Containers[0]
			Expect(c.Resources.Requests).To(HaveKey(corev1.ResourceName(defaultRDMARoCEResource)))
			Expect(c.Resources.Requests).NotTo(HaveKey(corev1.ResourceName(defaultRDMAIBResource)))
			// The declaration, not the container's own listen, is what keeps a
			// second environment wanting 8080 off this node.
			Expect(c.Ports).To(ConsistOf(corev1.ContainerPort{
				Name: mainPortName, ContainerPort: 8080, HostPort: 8080, Protocol: corev1.ProtocolTCP,
			}))
		})

		// spec.ports is free to name a port the platform already declared — the
		// schema reserves none of those numbers — and the ssh type's main port
		// *is* the ssh port. A container port may not be declared twice, so the
		// list dedupes; the same number in another protocol is a different port
		// and survives.
		It("declares each host-network port once, per protocol", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
				env.Spec.Network = &aiv1alpha1.NetworkSpec{
					RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeRoCE,
				}
				env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
				env.Spec.Ports = []aiv1alpha1.PortSpec{
					{Name: "jupyter-again", Type: aiv1alpha1.PortTypeHTTP, ContainerPort: 8888},
					{Name: testSyslogPortName, Type: aiv1alpha1.PortTypeUDP, ContainerPort: 8888},
				}
			})
			Expect(spec.Containers[0].Ports).To(Equal([]corev1.ContainerPort{
				{Name: mainPortName, ContainerPort: 8888, Protocol: corev1.ProtocolTCP, HostPort: 8888},
				{Name: sshPortName, ContainerPort: sshContainerPort, Protocol: corev1.ProtocolTCP, HostPort: sshContainerPort},
				{Name: testSyslogPortName, ContainerPort: 8888, Protocol: corev1.ProtocolUDP, HostPort: 8888},
			}))
		})

		// rdmaType carries a default of roce, so an environment that never
		// mentioned RDMA still reads as roce here. Gating on the enabled flag is
		// what keeps the default from putting the whole cluster on the host
		// network.
		It("leaves an environment without RDMA untouched", func() {
			for _, network := range []*aiv1alpha1.NetworkSpec{
				nil,
				{},
				{RDMAEnabled: false},
				{RDMAEnabled: false, RDMAType: aiv1alpha1.RDMATypeRoCE},
			} {
				spec := render(func(env *aiv1alpha1.DevEnvironment) { env.Spec.Network = network })
				Expect(spec.HostNetwork).To(BeFalse())
				Expect(spec.DNSPolicy).NotTo(Equal(corev1.DNSClusterFirstWithHostNet))
				c := spec.Containers[0]
				Expect(c.Resources.Requests).NotTo(HaveKey(corev1.ResourceName(defaultRDMAIBResource)))
				Expect(c.Resources.Requests).NotTo(HaveKey(corev1.ResourceName(defaultRDMARoCEResource)))
				Expect(c.SecurityContext.Capabilities).To(BeNil())
				Expect(c.Ports).To(BeEmpty())
			}
		})

		It("probes the main port per type", func() {
			for _, tt := range []struct {
				typ  aiv1alpha1.DevEnvironmentType
				port int32
			}{
				{typ: aiv1alpha1.DevEnvironmentTypeJupyter, port: 8888},
				{typ: aiv1alpha1.DevEnvironmentTypeSSH, port: 2222},
				{typ: aiv1alpha1.DevEnvironmentTypeVSCode, port: 8080},
			} {
				spec := render(func(env *aiv1alpha1.DevEnvironment) { env.Spec.Type = tt.typ })
				Expect(spec.Containers).To(HaveLen(1))
				c := spec.Containers[0]
				Expect(c.Name).To(Equal(string(tt.typ)))
				Expect(c.Image).To(Equal(testDevImage))
				Expect(c.ReadinessProbe).NotTo(BeNil())
				Expect(c.ReadinessProbe.ProbeHandler.TCPSocket.Port.IntVal).To(Equal(tt.port))
			}
		})

		// The environment's own storage is initialized by an init container, so
		// the pod carries no fsGroup: an fsGroup is Pod-scoped and would chown
		// every read-write volume in the pod, including a referenced PVC. (What
		// else the pod-level context holds is the seccomp spec's business.)
		It("initializes the workspace claim from an init container, without an fsGroup", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Storage = &aiv1alpha1.StorageSpec{Size: "10Gi"}
			})
			Expect(spec.SecurityContext.FSGroup).To(BeNil())
			Expect(spec.InitContainers).To(HaveLen(1))
			Expect(spec.InitContainers[0].Name).To(Equal(permissionInitContainerName))
			Expect(spec.InitContainers[0].Image).To(Equal(permissionInitImage))
		})

		It("has no init container when the environment has no storage of its own", func() {
			Expect(render(nil).InitContainers).To(BeEmpty())
		})

		It("never mounts a referenced PVC into the init container", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Storage = &aiv1alpha1.StorageSpec{Size: "10Gi"}
				env.Spec.Volumes = []aiv1alpha1.VolumeMount{
					{Name: "datasets", PVCName: "shared-dataset", MountPath: "/datasets", ReadOnly: true},
				}
			})
			Expect(spec.InitContainers).To(HaveLen(1))
			Expect(spec.InitContainers[0].VolumeMounts).To(ConsistOf(corev1.VolumeMount{
				Name: workspaceClaimName, MountPath: permissionInitMountPath,
			}))
			// The volume itself still reaches the main container, mounted as asked.
			Expect(spec.Containers[0].VolumeMounts).To(ContainElement(corev1.VolumeMount{
				Name: "datasets", MountPath: "/datasets", ReadOnly: true,
			}))
		})

		It("copies runtime command, args and env onto the container", func() {
			command := []string{"/bin/sh"}
			args := []string{"-c", "sleep infinity"}
			runtimeEnv := []corev1.EnvVar{
				{Name: "FOO", Value: "bar"},
				{Name: "FROM_SECRET", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: "creds"}, Key: "k",
				}}},
			}
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Command: command, Args: args, Env: runtimeEnv}
			})
			c := spec.Containers[0]
			Expect(c.Command).To(Equal(command))
			Expect(c.Args).To(Equal(args))
			Expect(c.Env).To(Equal(runtimeEnv))
		})

		It("mounts the workspace claim at spec.storage.mountPath and none when storage is omitted", func() {
			mountPath := "/data/workspace"
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Storage = &aiv1alpha1.StorageSpec{MountPath: mountPath}
			})
			Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{{
				Name: workspaceClaimName, MountPath: mountPath,
			}}))

			spec = render(nil)
			Expect(spec.Containers[0].VolumeMounts).To(BeEmpty())
		})

		It("mounts spec.volumes with pvc, path, subPath and readOnly fidelity", func() {
			ro := aiv1alpha1.VolumeMount{Name: "artifacts", PVCName: "artifacts-pvc", MountPath: "/data/artifacts", ReadOnly: true, SubPath: "artifacts/v3"}
			rw := aiv1alpha1.VolumeMount{Name: "cache", PVCName: "cache-pvc", MountPath: "/cache"}
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Volumes = []aiv1alpha1.VolumeMount{ro, rw}
			})
			c := spec.Containers[0]
			Expect(c.VolumeMounts).To(Equal([]corev1.VolumeMount{
				{Name: ro.Name, MountPath: ro.MountPath, ReadOnly: ro.ReadOnly, SubPath: ro.SubPath},
				{Name: rw.Name, MountPath: rw.MountPath, ReadOnly: rw.ReadOnly},
			}))
			Expect(spec.Volumes).To(Equal([]corev1.Volume{
				{Name: ro.Name, VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: ro.PVCName, ReadOnly: ro.ReadOnly}}},
				{Name: rw.Name, VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: rw.PVCName, ReadOnly: rw.ReadOnly}}},
			}))
		})

		// The images' sshd reads both entries in place, so the operator mounts them
		// rather than staging them: the host key as a subPath file where sshd looks
		// for its identity, and the platform keys as a whole Secret under /run, the
		// absolute path the images' AuthorizedKeysFile names — outside any home,
		// since a claim mounted on the home is not writable by the account and a
		// mount target created beneath it would be root-owned. The two differ in
		// kind on purpose: a subPath file is frozen at container start and a
		// directory mount is not, and only the authorized keys ever change.
		It("mounts the ssh keys as a file and a directory at absolute paths", func() {
			var env *aiv1alpha1.DevEnvironment
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				env = e
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{User: testSSHUser}
			})
			Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{
				{Name: sshHostKeyVolumeName, MountPath: sshHostKeyPath, SubPath: sshHostKeyKey, ReadOnly: true},
				{Name: sshAuthorizedKeysVolumeName, MountPath: sshAuthorizedKeysDir, ReadOnly: true},
			}))
			// 0644 is load-bearing: a tighter mode makes a non-root sshd refuse
			// its own root-owned host key and exit. The keyed volume names no
			// subPath: items maps the one entry the pod may see onto the filename
			// sshd reads, which is what keeps the generated login keypair — sharing
			// that Secret — out of the container.
			Expect(spec.Volumes).To(Equal([]corev1.Volume{
				{
					Name:         sshHostKeyVolumeName,
					VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: sshHostKeySecretName(env), DefaultMode: ptrTo(int32(0o644))}},
				},
				{
					Name: sshAuthorizedKeysVolumeName,
					VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
						SecretName:  sshClientKeySecretName(env),
						DefaultMode: ptrTo(int32(0o644)),
						Items:       []corev1.KeyToPath{{Key: sshClientPubKeyKey, Path: sshAuthorizedKeysFile}},
					}},
				},
			}))
		})

		// The mode is not a property of the file but of whoever reads it, which is
		// why it cannot be a constant: a Secret volume materialises its files
		// root-owned, and OpenSSH's private-key check fires only on a file owned by
		// the uid reading it. A root sshd (runAsUser 0) *is* that owner, so 0644 —
		// the mode the non-root path needs — is refused with "Permissions 0644 ...
		// are too open", and the images' entrypoint turns that into a failed start
		// rather than an environment that is merely missing ssh.
		It("mounts the ssh Secrets 0600 for an environment running as root", func() {
			var env *aiv1alpha1.DevEnvironment
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				env = e
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				}
			})
			Expect(spec.Volumes).To(Equal([]corev1.Volume{
				{
					Name:         sshHostKeyVolumeName,
					VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: sshHostKeySecretName(env), DefaultMode: ptrTo(int32(0o600))}},
				},
				{
					Name: sshAuthorizedKeysVolumeName,
					VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
						SecretName:  sshClientKeySecretName(env),
						DefaultMode: ptrTo(int32(0o600)),
						Items:       []corev1.KeyToPath{{Key: sshClientPubKeyKey, Path: sshAuthorizedKeysFile}},
					}},
				},
			}))
		})

		// With keysSecret of its own the environment supplies the authorized keys,
		// so that mount follows the selector's data key rather than a name the
		// controller generates.
		It("mounts the referenced keys Secret under the selector's data key", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
				e.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true, AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: testUserKeysSecret},
					Key:                  testUserKeysKey,
				}}
			})
			Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{
				{Name: sshHostKeyVolumeName, MountPath: sshHostKeyPath, SubPath: sshHostKeyKey, ReadOnly: true},
				{Name: sshAuthorizedKeysVolumeName, MountPath: sshAuthorizedKeysDir, ReadOnly: true},
			}))
			Expect(spec.Volumes[1]).To(Equal(corev1.Volume{
				Name: sshAuthorizedKeysVolumeName,
				VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
					SecretName:  testUserKeysSecret,
					DefaultMode: ptrTo(int32(0o644)),
					Items:       []corev1.KeyToPath{{Key: testUserKeysKey, Path: sshAuthorizedKeysFile}},
				}},
			}))
		})

		// A claim mounted on the account's home hides the ~/.ssh the image bakes.
		// Nothing is mounted in its place: the platform keys live under /run, the
		// account creates its own ~/.ssh (which the init container's chown of the
		// claim makes possible), and no mount target is built inside the claim.
		It("keeps every mount out of a home the workspace claim covers", func() {
			var env *aiv1alpha1.DevEnvironment
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				env = e
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{User: testSSHUser}
				// No mountPath: the claim lands on the account's home.
				e.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize}
			})
			Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{
				{Name: workspaceClaimName, MountPath: testSSHHome},
				{Name: sshHostKeyVolumeName, MountPath: sshHostKeyPath, SubPath: sshHostKeyKey, ReadOnly: true},
				{Name: sshAuthorizedKeysVolumeName, MountPath: sshAuthorizedKeysDir, ReadOnly: true},
			}))
			// The ssh Secrets alone: no emptyDir stands in for ~/.ssh any more.
			Expect(spec.Volumes).To(Equal([]corev1.Volume{
				{
					Name:         sshHostKeyVolumeName,
					VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: sshHostKeySecretName(env), DefaultMode: ptrTo(int32(0o644))}},
				},
				{
					Name: sshAuthorizedKeysVolumeName,
					VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
						SecretName:  sshClientKeySecretName(env),
						DefaultMode: ptrTo(int32(0o644)),
						Items:       []corev1.KeyToPath{{Key: sshClientPubKeyKey, Path: sshAuthorizedKeysFile}},
					}},
				},
			}))
		})

		// The declared HOME reaches the VolumeMount, not just resolveMountPath: a
		// root environment telling the image its home is /home/root must have its
		// claim mounted there, or the notebook writes to the container filesystem.
		It("mounts the workspace claim at a declared HOME", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
				e.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize}
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
					User:            rootRuntimeUser,
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0)), RunAsGroup: ptrTo(int64(0))},
					Env:             []corev1.EnvVar{{Name: homeEnv, Value: "/home/root"}, {Name: "NB_USER", Value: rootRuntimeUser}},
				}
			})
			Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{
				{Name: workspaceClaimName, MountPath: "/home/root"},
			}))
		})

		// The claim the platform mounts is the environment's workspace, so the
		// container is told where it is: HOME names the path the claim mounts at,
		// resolved once, and a launcher that serves HOME serves the workspace
		// whatever its image bakes (::withWorkspaceHome). Every type gets it — a
		// claim's path is no jupyter notion.
		//
		// The mount and the home are asserted against one literal, so the two
		// cannot drift apart into two derivations of the same path.
		homes := func(envVars []corev1.EnvVar) []corev1.EnvVar {
			found := []corev1.EnvVar{}
			for _, v := range envVars {
				if v.Name == homeEnv {
					found = append(found, v)
				}
			}
			return found
		}
		DescribeTable("states the workspace mount as the container's home",
			func(mut func(*aiv1alpha1.DevEnvironment), wantPath string) {
				spec := render(func(e *aiv1alpha1.DevEnvironment) {
					e.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize}
					mut(e)
				})
				c := spec.Containers[0]
				Expect(c.VolumeMounts).To(ContainElement(corev1.VolumeMount{Name: workspaceClaimName, MountPath: wantPath}))
				Expect(homes(c.Env)).To(Equal([]corev1.EnvVar{{Name: homeEnv, Value: wantPath}}))
			},
			Entry("for an environment running as root", func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				}
			}, "/root"),
			Entry("for a named account", func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser}
			}, "/home/"+testRuntimeUser),
			Entry("for an environment naming no account", func(*aiv1alpha1.DevEnvironment) {}, defaultWorkspacePath),
			Entry("for a pinned mountPath on another type", func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
				e.Spec.Storage.MountPath = testPinnedMountPath
			}, testPinnedMountPath),
		)

		// A declared home the derivation resolves to is the value the controller
		// states, so the container carries one entry and not two.
		It("keeps a declared home that already names the mount path", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize}
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
					User: testRuntimeUser,
					Env:  []corev1.EnvVar{{Name: homeEnv, Value: "/home/" + testRuntimeUser}},
				}
			})
			Expect(homes(spec.Containers[0].Env)).To(Equal([]corev1.EnvVar{
				{Name: homeEnv, Value: "/home/" + testRuntimeUser},
			}))
		})

		// Only the last of several declared entries ever reaches the container, so
		// the earlier ones are dead already: the controller states one home rather
		// than reproducing which of them the container would have taken.
		It("collapses several declared homes into the one the container applies", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize, MountPath: testPinnedMountPath}
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
					User: testRuntimeUser,
					Env: []corev1.EnvVar{
						{Name: homeEnv, Value: "/srv/first"},
						{Name: homeEnv, Value: "/srv/second"},
					},
				}
			})
			Expect(homes(spec.Containers[0].Env)).To(Equal([]corev1.EnvVar{
				{Name: homeEnv, Value: testPinnedMountPath},
			}))
		})

		// The kubelet expands $(VAR) in a single pass down the env list, so a
		// declared value that names HOME resolves only against a HOME it has
		// already passed: the controller states the home first for that reason.
		// Asserted on the whole list, since the order is the assertion.
		It("states the home ahead of the entries that name it", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize}
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{
					{Name: homeEnv, Value: "/srv/workspace"},
					{Name: "PROJECT", Value: "$(" + homeEnv + ")/project"},
				}}
			})
			Expect(spec.Containers[0].Env).To(Equal([]corev1.EnvVar{
				{Name: homeEnv, Value: "/srv/workspace"},
				{Name: "PROJECT", Value: "$(" + homeEnv + ")/project"},
			}))
		})

		// The claim mounts at the path as written, while the kubelet expands
		// every EnvVar.Value: a doubled dollar is reduced to one, and a $(NAME)
		// reference is resolved against the other variables. A path containing
		// either has to be stated escaped, or the container is told to work in a
		// directory the claim is not mounted at — so both the mount and the
		// stated value are asserted, the escape being the whole difference.
		DescribeTable("states a mount path containing a dollar as the claim mounts it",
			func(mountPath, wantValue string) {
				spec := render(func(e *aiv1alpha1.DevEnvironment) {
					e.Spec.Storage = &aiv1alpha1.StorageSpec{Size: testWorkspaceSize, MountPath: mountPath}
				})
				c := spec.Containers[0]
				Expect(c.VolumeMounts).To(ContainElement(corev1.VolumeMount{Name: workspaceClaimName, MountPath: mountPath}))
				Expect(homes(c.Env)).To(Equal([]corev1.EnvVar{{Name: homeEnv, Value: wantValue}}))
			},
			Entry("for a doubled dollar the kubelet reduces to one", "/data/$$work", "/data/$$$$work"),
			Entry("for a reference the kubelet would resolve", "/data/$(USER)", "/data/$$(USER)"),
		)

		// No claim, no workspace to name: the controller states no home, so the
		// one the spec declares is the one the container runs with. This is the
		// case the launchers' own guards still cover.
		It("states no home for an environment with no workspace claim", func() {
			env := newEnv()
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{{Name: homeEnv, Value: testSSHHome}}}
			c := (&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0]
			Expect(c.Env).To(Equal([]corev1.EnvVar{{Name: homeEnv, Value: testSSHHome}}))
			Expect(c.VolumeMounts).To(BeEmpty())
		})

		It("injects JUPYTER_TOKEN from the managed auth secret and drops a user override", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{
				{Name: jupyterTokenEnv, Value: "user-override"},
				{Name: "KEEP", Value: "me"},
			}}
			c := (&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0]
			Expect(c.Env).To(Equal([]corev1.EnvVar{
				{Name: "KEEP", Value: "me"},
				{Name: jupyterTokenEnv, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: jupyterTokenSecretName(env)},
					Key:                  jupyterTokenKey,
				}}},
				{Name: notebookArgsEnv, Value: notebookBaseURLFlag + webPath(env)},
			}))
			// A jupyter environment without ssh.enabled mounts no ssh volume.
			Expect(c.VolumeMounts).To(BeEmpty())
		})

		// The prefix Jupyter is told to serve under has to be the prefix its route
		// publishes: the route forwards the path unchanged, so a container serving
		// anywhere else 404s on every published URL. Asserting both against one
		// literal is what catches the two drifting apart.
		It("tells jupyter to serve under the prefix its route publishes", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			r := &DevEnvironmentReconciler{}
			route := r.desiredHTTPRoute(env, &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{
				Name: testDevEnvGatewayName, Namespace: testNamespace,
			}})
			published := route.Spec.Rules[0].Matches[0].Path.Value
			Expect(*published).To(Equal("/dev/default/de-render/"))
			Expect(r.desiredPodSpec(env).Containers[0].Env).To(ContainElement(corev1.EnvVar{
				Name: notebookArgsEnv, Value: notebookBaseURLFlag + *published,
			}))
		})

		It("merges the base_url into a declared NOTEBOOK_ARGS, keeping its other flags", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{
					{Name: notebookArgsEnv, Value: "--ServerApp.allow_origin=*"},
				}}
			})
			Expect(spec.Containers[0].Env).To(ContainElement(corev1.EnvVar{
				Name:  notebookArgsEnv,
				Value: "--ServerApp.allow_origin=* --ServerApp.base_url=/dev/default/de-render/",
			}))
		})

		// The route forwards webPath unchanged, so a notebook serving under any
		// other prefix 404s on every published URL. The controller's flag replaces
		// the environment's rather than letting the two disagree.
		It("replaces a base_url the environment declares, keeping its other flags", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
				e.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{
					{Name: notebookArgsEnv, Value: "--ServerApp.base_url=/served/elsewhere/ --ServerApp.allow_origin=*"},
				}}
			})
			declared := []string{}
			for _, v := range spec.Containers[0].Env {
				if v.Name == notebookArgsEnv {
					declared = append(declared, v.Value)
				}
			}
			Expect(declared).To(Equal([]string{
				"--ServerApp.allow_origin=* --ServerApp.base_url=/dev/default/de-render/",
			}))
		})

		It("leaves an environment that does not serve a notebook without NOTEBOOK_ARGS", func() {
			spec := render(func(e *aiv1alpha1.DevEnvironment) { e.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH })
			Expect(spec.Containers[0].Env).NotTo(ContainElement(HaveField("Name", notebookArgsEnv)))
		})

		// A root environment has to be startable from spec.runtime.securityContext
		// alone: the launcher reads the account it serves and the uid/gid to serve it
		// as from the container's own environment, and exits outright without the root
		// flag. The declared group is 2000 here, and NB_GID is still 0: these name the
		// account in the image's passwd database, and docker-stacks rewrites the account
		// when they disagree with the identity the pod runs as — a rewrite that cannot
		// succeed for root, which is a container that exits before sshd is reachable
		// (::withRootLauncherEnv).
		It("injects the launcher environment a root jupyter environment needs", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
				SecurityContext: &aiv1alpha1.RuntimeSecurityContext{
					RunAsUser: ptrTo(int64(0)), RunAsGroup: ptrTo(int64(2000)),
				},
			}
			c := (&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0]
			Expect(c.Env).To(ContainElements(
				corev1.EnvVar{Name: nbUserEnv, Value: rootRuntimeUser},
				corev1.EnvVar{Name: nbUIDEnv, Value: "0"},
				corev1.EnvVar{Name: nbGIDEnv, Value: "0"},
			))
			// Both flags in the one NOTEBOOK_ARGS the launcher reads.
			Expect(c.Env).To(ContainElement(corev1.EnvVar{
				Name:  notebookArgsEnv,
				Value: notebookBaseURLFlag + webPath(env) + " " + notebookAllowRootFlag,
			}))
			// What the pod itself runs as is the spec's, and is unchanged by any of this.
			Expect(c.SecurityContext.RunAsGroup).To(Equal(ptrTo(int64(2000))))
		})

		// The account and the flags follow from the security context, which is the
		// controller's to resolve, so a declared value is dropped rather than merged —
		// leaving both would put a contradiction in the container's environment
		// (::withRootLauncherEnv).
		It("replaces a launcher value the spec declares", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
				SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				Env: []corev1.EnvVar{
					{Name: nbUserEnv, Value: testRuntimeUser},
					{Name: nbUIDEnv, Value: "1000"},
				},
			}
			rendered := []corev1.EnvVar{}
			for _, v := range (&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0].Env {
				switch v.Name {
				case nbUserEnv, nbUIDEnv, nbGIDEnv:
					rendered = append(rendered, v)
				}
			}
			// The group is the platform's default here, and NB_GID is 0 all the same:
			// the one configuration a pod group could have been derived into, and the
			// one that does not start (::withRootLauncherEnv).
			Expect(rendered).To(Equal([]corev1.EnvVar{
				{Name: nbUserEnv, Value: rootRuntimeUser},
				{Name: nbUIDEnv, Value: "0"},
				{Name: nbGIDEnv, Value: "0"},
			}))
		})

		It("keeps a --allow-root the environment declares instead of repeating it", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
				SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				Env: []corev1.EnvVar{
					{Name: notebookArgsEnv, Value: notebookAllowRootFlag + " --ServerApp.allow_origin=*"},
				},
			}
			Expect((&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0].Env).To(ContainElement(corev1.EnvVar{
				Name:  notebookArgsEnv,
				Value: notebookAllowRootFlag + " --ServerApp.allow_origin=* " + notebookBaseURLFlag + webPath(env),
			}))
		})

		// The common path: an environment that is not root runs the launcher's stock
		// account, so none of this may reach it.
		It("leaves a jupyter environment that does not run as root without the launcher environment", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			c := (&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0]
			Expect(c.Env).NotTo(ContainElement(HaveField("Name", BeElementOf(nbUserEnv, nbUIDEnv, nbGIDEnv))))
			Expect(c.Env).To(ContainElement(corev1.EnvVar{
				Name: notebookArgsEnv, Value: notebookBaseURLFlag + webPath(env),
			}))
		})

		// The other axis, with the uid that would otherwise qualify: it is the notebook
		// launcher that reads any of this, and an ssh environment runs none.
		It("injects nothing into a root ssh environment", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
				SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
			}
			Expect((&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0].Env).To(BeEmpty())
		})

		// The whole rollout story of this feature is that an environment which
		// asks for no idle timeout is a pod spec that has not changed. Asserting
		// it here is what keeps that a property rather than a coincidence: the
		// hash is hand-assembled (::stsSpecHash), so a field added to the template
		// without a matching entry there would reach every environment in the
		// cluster the moment the next reconcile ran.
		It("leaves an environment with no idle timeout exactly as it was", func() {
			spec := render(nil)
			Expect(spec.Containers).To(HaveLen(1))
			// Nil, not false: unset is what serializes away, so an untouched
			// field is the one thing that cannot enter the template.
			Expect(spec.ShareProcessNamespace).To(BeNil())
			Expect(spec.ServiceAccountName).To(BeEmpty())
		})

		// IdleTimeout 0 is the schema default and the API's own way of saying
		// "disabled", so a lifecycle block that states it must be read as no
		// request at all rather than as a request for an agent that would stop
		// the environment the moment it was idle.
		It("leaves an environment with a zero idle timeout alone too", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 0}
			})
			Expect(spec.Containers).To(HaveLen(1))
			Expect(spec.ShareProcessNamespace).To(BeNil())
		})

		It("carries the activity agent when an idle timeout is asked for", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 3600}
			})
			Expect(spec.ShareProcessNamespace).To(Equal(ptrTo(true)))
			Expect(spec.ServiceAccountName).To(Equal("de-render" + activityAgentNameSuffix))
			// Appended, never prepended: Containers[0] is the environment itself.
			Expect(spec.Containers).To(HaveLen(2))
			Expect(spec.Containers[0].Name).To(Equal(string(aiv1alpha1.DevEnvironmentTypeVSCode)))
			s := spec.Containers[1]
			Expect(s.Name).To(Equal(activityAgentContainerName))
			Expect(s.Image).To(Equal(activityAgentImage))
			// The image is a mutable tag, so a node that cached an older layer
			// would keep running an older agent: only the pull policy makes a
			// rebuilt agent reach a node that already has the tag.
			Expect(s.ImagePullPolicy).To(Equal(corev1.PullAlways))
			Expect(s.Args).To(Equal([]string{"--ports=8080"}))
			// A probe is the one thing a sidecar must not have: a failing one
			// makes the pod NotReady, and the environment with it.
			Expect(s.ReadinessProbe).To(BeNil())
			Expect(s.LivenessProbe).To(BeNil())
			Expect(s.StartupProbe).To(BeNil())
			// The agent names itself through the downward API, so the controller
			// never has to name a pod that does not exist until this creates it.
			Expect(s.Env).To(ConsistOf(
				corev1.EnvVar{Name: "POD_NAME", ValueFrom: &corev1.EnvVarSource{
					FieldRef: &corev1.ObjectFieldSelector{FieldPath: podNameFieldPath},
				}},
				corev1.EnvVar{Name: "POD_NAMESPACE", ValueFrom: &corev1.EnvVarSource{
					FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.namespace"},
				}},
			))
		})

		// The ports are the ones the environment's own services bind *inside* the
		// pod. ssh is published on sshServicePort, but that port belongs to the
		// platform's proxy rather than to the container, so an agent watching it
		// would watch a socket that never appears in the pod.
		It("watches the ssh port of a jupyter environment that exposes it", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
				env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
				env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 60}
			})
			Expect(spec.Containers[1].Args).To(Equal([]string{"--ports=8888,2222"}))
		})

		// An ssh-typed environment's main port *is* the ssh port, and a container
		// port may not be declared twice.
		It("names the ssh port once for an ssh-typed environment", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
				env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
				env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 60}
			})
			Expect(spec.Containers[1].Args).To(Equal([]string{"--ports=2222"}))
		})

		// Reading /proc/<pid>/io is a ptrace permission check, and a process may
		// only trace one of its own uid — so a sidecar on a uid of its own would
		// come up, report CPU progress, and silently lose the IO dimension, which
		// is the one that catches a training job using almost no CPU.
		It("runs the sidecar as the environment's own account", func() {
			for _, uid := range []int64{1000, 2000, 0} {
				spec := render(func(env *aiv1alpha1.DevEnvironment) {
					env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
						SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(uid)},
					}
					env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 60}
				})
				main, sidecar := spec.Containers[0].SecurityContext, spec.Containers[1].SecurityContext
				Expect(sidecar.RunAsUser).To(Equal(main.RunAsUser), "uid %d", uid)
				Expect(sidecar.RunAsGroup).To(Equal(main.RunAsGroup), "uid %d", uid)
				// A sidecar that disagrees with its own pod on this is a
				// CreateContainerConfigError, and a sidecar that cannot start
				// fails the whole environment.
				Expect(sidecar.RunAsNonRoot).To(Equal(main.RunAsNonRoot), "uid %d", uid)
			}
		})

		It("grants the sidecar nothing it does not need", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 60}
			})
			s := spec.Containers[1].SecurityContext
			Expect(s.AllowPrivilegeEscalation).To(Equal(ptrTo(false)))
			Expect(s.ReadOnlyRootFilesystem).To(Equal(ptrTo(true)))
			Expect(s.Capabilities).To(Equal(&corev1.Capabilities{Drop: []corev1.Capability{allCapabilities}}))
			// The environment's own container keeps the context it had: these
			// are the sidecar's, not a change to how a tenant's work runs.
			Expect(spec.Containers[0].SecurityContext.Capabilities).To(BeNil())
			Expect(spec.Containers[0].SecurityContext.ReadOnlyRootFilesystem).To(BeNil())
		})

		// An agent that is throttled skips a sample; one that asks for more memory
		// than the node has is evicted, and takes the user's work with it.
		It("bounds what the sidecar can take from the environment", func() {
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 60}
			})
			res := spec.Containers[1].Resources
			Expect(res.Requests[corev1.ResourceCPU]).To(Equal(resource.MustParse("10m")))
			Expect(res.Requests[corev1.ResourceMemory]).To(Equal(resource.MustParse("32Mi")))
			Expect(res.Limits[corev1.ResourceCPU]).To(Equal(resource.MustParse("50m")))
			Expect(res.Limits[corev1.ResourceMemory]).To(Equal(resource.MustParse("64Mi")))
		})
	})

	Describe("desiredService", func() {
		render := func(mut func(*aiv1alpha1.DevEnvironment)) *corev1.Service {
			env := &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-svc", Namespace: "default"},
				Spec:       aiv1alpha1.DevEnvironmentSpec{Type: aiv1alpha1.DevEnvironmentTypeVSCode, Image: testDevImage},
			}
			if mut != nil {
				mut(env)
			}
			return (&DevEnvironmentReconciler{}).desiredService(env)
		}

		// The container's sshd binds the unprivileged 2222, so the Service has
		// to bridge the conventional 22 onto it. publishPort is the Service
		// port; the container side is asserted in the pod-spec specs above.
		It("publishes the ssh container port as the Service's 22", func() {
			svc := render(func(env *aiv1alpha1.DevEnvironment) { env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH })
			Expect(svc.Spec.Ports).To(HaveLen(1))
			Expect(svc.Spec.Ports[0].Name).To(Equal(mainPortName))
			Expect(svc.Spec.Ports[0].Port).To(Equal(int32(22)))
			Expect(svc.Spec.Ports[0].TargetPort.IntVal).To(Equal(int32(2222)))
		})

		It("adds the ssh port beside the main port for a jupyter environment with ssh", func() {
			svc := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
				env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			})
			// The main port is the port the container serves, published verbatim.
			Expect(svc.Spec.Ports).To(HaveLen(2))
			Expect(svc.Spec.Ports[0].Name).To(Equal(mainPortName))
			Expect(svc.Spec.Ports[0].Port).To(Equal(int32(8888)))
			Expect(svc.Spec.Ports[0].TargetPort.IntVal).To(Equal(int32(8888)))
			Expect(svc.Spec.Ports[1].Name).To(Equal(sshPortName))
			Expect(svc.Spec.Ports[1].Port).To(Equal(int32(22)))
			Expect(svc.Spec.Ports[1].TargetPort.IntVal).To(Equal(int32(2222)))
		})

		It("publishes no ssh port when ssh is not exposed", func() {
			svc := render(nil)
			Expect(svc.Spec.Ports).To(HaveLen(1))
			Expect(svc.Spec.Ports[0].Port).To(Equal(int32(8080)))
			Expect(svc.Spec.Ports[0].TargetPort.IntVal).To(Equal(int32(8080)))
		})

		// spec.ports is free to name a port the platform already publishes, and
		// the platform publishes two the user did not write: the type's main port
		// and, with ssh, the number sshd is bridged from. A Service may not carry
		// one (port, protocol) twice — the API server refuses the write outright,
		// and that error aborts the reconcile before its status write — so the
		// list dedupes the way the container port list does (::desiredContainerPorts).
		// The exposure is not lost by that: the Service keeps publishing the
		// number, and a route names a Service port by number, not by name.
		It("publishes each Service port once, per protocol", func() {
			svc := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
				env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
				env.Spec.Ports = []aiv1alpha1.PortSpec{
					{Name: "jupyter-again", Type: aiv1alpha1.PortTypeHTTP, ContainerPort: 8888},
					{Name: "sshd-again", Type: aiv1alpha1.PortTypeTCP, ContainerPort: sshServicePort},
					{Name: testSyslogPortName, Type: aiv1alpha1.PortTypeUDP, ContainerPort: 8888},
				}
			})
			// Both repeats of a platform-published port are gone; the udp entry
			// on the same number as the notebook is a different port and stays.
			Expect(svc.Spec.Ports).To(Equal([]corev1.ServicePort{
				{Name: mainPortName, Port: 8888, TargetPort: intstr.FromInt32(8888), Protocol: corev1.ProtocolTCP},
				{Name: sshPortName, Port: sshServicePort, TargetPort: intstr.FromInt32(sshContainerPort), Protocol: corev1.ProtocolTCP},
				{Name: testSyslogPortName, Port: 8888, TargetPort: intstr.FromInt32(8888), Protocol: corev1.ProtocolUDP},
			}))
		})

		// The ssh type publishes its main port at 22 targeting the container's
		// 2222, so the two sides of the bridge diverge and only the Service side
		// can collide there.
		It("keeps a spec port on the ssh type's container port, which the Service does not carry", func() {
			svc := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
				env.Spec.Ports = []aiv1alpha1.PortSpec{
					{Name: "sshd-direct", Type: aiv1alpha1.PortTypeTCP, ContainerPort: sshContainerPort},
				}
			})
			Expect(svc.Spec.Ports).To(Equal([]corev1.ServicePort{
				{Name: mainPortName, Port: sshServicePort, TargetPort: intstr.FromInt32(sshContainerPort), Protocol: corev1.ProtocolTCP},
				{Name: "sshd-direct", Port: sshContainerPort, TargetPort: intstr.FromInt32(sshContainerPort), Protocol: corev1.ProtocolTCP},
			}))
		})
	})

	Describe("desiredListenerSet", func() {
		// render declares the listeners for an environment whose spec carries the
		// given extra ports, allocated the given listener ports by port name.
		render := func(spec []aiv1alpha1.PortSpec, ports map[string]int32) *gatewayv1.ListenerSet {
			env := &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-l4", Namespace: "project-llm"},
				Spec:       aiv1alpha1.DevEnvironmentSpec{Type: aiv1alpha1.DevEnvironmentTypeJupyter, Ports: spec},
			}
			gw := &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: defaultGatewayName, Namespace: systemNamespace}}
			return (&DevEnvironmentReconciler{}).desiredListenerSet(env, gw, ports)
		}

		It("declares one listener per allocated port, of the protocol it is exposed over", func() {
			// Allocated out of ascending order: the listeners come back sorted by
			// port anyway, so that a stored ListenerSet spec is stable.
			ls := render([]aiv1alpha1.PortSpec{
				{Name: testMetricsPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 9090},
				{Name: "syslog", Type: aiv1alpha1.PortTypeUDP, ContainerPort: 514},
			}, map[string]int32{testMetricsPortName: 20002, "syslog": 20000})
			Expect(ls.Name).To(Equal("de-l4-l4"))
			Expect(ls.Namespace).To(Equal("project-llm"))
			Expect(ls.Spec.Listeners).To(HaveLen(2))

			Expect(ls.Spec.Listeners[0].Name).To(Equal(gatewayv1.SectionName("syslog-udp-20000")))
			Expect(ls.Spec.Listeners[0].Protocol).To(Equal(gatewayv1.UDPProtocolType))
			Expect(ls.Spec.Listeners[0].Port).To(Equal(int32(20000)))
			Expect(ls.Spec.Listeners[0].AllowedRoutes.Kinds).To(Equal([]gatewayv1.RouteGroupKind{{
				Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)),
				Kind:  gatewayv1.Kind(udpRouteKind),
			}}))
			Expect(ls.Spec.Listeners[0].AllowedRoutes.Namespaces.From).To(Equal(ptrTo(gatewayv1.NamespacesFromSame)))

			// The UDP listener is not enough on its own: a tcp port beside it is
			// still a TCP listener, on its own allocated number, admitting only
			// TCPRoutes.
			Expect(ls.Spec.Listeners[1].Name).To(Equal(gatewayv1.SectionName(testMetricsPortName + "-tcp-20002")))
			Expect(ls.Spec.Listeners[1].Protocol).To(Equal(gatewayv1.TCPProtocolType))
			Expect(ls.Spec.Listeners[1].Port).To(Equal(int32(20002)))
			Expect(ls.Spec.Listeners[1].AllowedRoutes.Kinds).To(Equal([]gatewayv1.RouteGroupKind{{
				Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)),
				Kind:  gatewayv1.Kind(tcpRouteKind),
			}}))
		})

		// applyListenerSet compares the stored spec against this one to decide
		// whether to update, so every field the API server would default has to be
		// set here — otherwise the object is rewritten on every reconcile.
		It("spells out the fields the API server would otherwise default", func() {
			ls := render([]aiv1alpha1.PortSpec{{Name: testMetricsPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 9090}},
				map[string]int32{testMetricsPortName: 20000})
			Expect(ls.Spec.ParentRef).To(Equal(gatewayv1.ParentGatewayReference{
				Group:     ptrTo(gatewayv1.Group(gatewayAPIGroup)),
				Kind:      ptrTo(gatewayv1.Kind(gatewayKind)),
				Namespace: ptrTo(gatewayv1.Namespace(systemNamespace)),
				Name:      gatewayv1.ObjectName(defaultGatewayName),
			}))
		})
	})

	Describe("listenerSetRejection", func() {
		// acceptedSet renders a ListenerSet as the gateway would report it, so the
		// condition reads back the way the real status does.
		acceptedSet := func(mut func(*gatewayv1.ListenerSet)) *gatewayv1.ListenerSet {
			ls := &gatewayv1.ListenerSet{
				ObjectMeta: metav1.ObjectMeta{Name: "de-l4-l4", Namespace: "project-llm", Generation: 3},
				Spec: gatewayv1.ListenerSetSpec{Listeners: []gatewayv1.ListenerEntry{
					{Name: "tcp-20000", Protocol: gatewayv1.TCPProtocolType, Port: 20000},
				}},
			}
			ls.Status.Conditions = []metav1.Condition{{
				Type:               string(gatewayv1.ListenerSetConditionAccepted),
				Status:             metav1.ConditionTrue,
				Reason:             string(gatewayv1.ListenerSetReasonAccepted),
				ObservedGeneration: ls.Generation,
			}}
			if mut != nil {
				mut(ls)
			}
			return ls
		}

		It("passes an environment with no L4 exposure", func() {
			Expect(listenerSetRejection(nil)).To(BeEmpty())
		})

		It("accepts a ListenerSet the gateway admitted", func() {
			Expect(listenerSetRejection(acceptedSet(nil))).To(BeEmpty())
		})

		// The documented prerequisite: a Gateway that has not opted the namespace
		// into allowedListeners refuses the ListenerSet, and its reason is the only
		// thing that names the missing label.
		It("surfaces the gateway's own reason for refusing the ListenerSet", func() {
			ls := acceptedSet(func(ls *gatewayv1.ListenerSet) {
				ls.Status.Conditions[0].Status = metav1.ConditionFalse
				ls.Status.Conditions[0].Reason = string(gatewayv1.ListenerSetReasonNotAllowed)
				ls.Status.Conditions[0].Message = "namespace project-llm is not allowed to attach to gateway cubestack-gateway"
			})
			Expect(listenerSetRejection(ls)).To(ContainSubstring(string(gatewayv1.ListenerSetReasonNotAllowed)))
			Expect(listenerSetRejection(ls)).To(ContainSubstring("not allowed to attach"))
		})

		It("withholds an environment whose ListenerSet the gateway has not reported on", func() {
			ls := acceptedSet(func(ls *gatewayv1.ListenerSet) { ls.Status.Conditions = nil })
			Expect(listenerSetRejection(ls)).To(ContainSubstring("has not been accepted"))
		})

		It("ignores a verdict on a previous generation", func() {
			ls := acceptedSet(func(ls *gatewayv1.ListenerSet) {
				ls.Status.Conditions[0].Status = metav1.ConditionFalse
				ls.Status.Conditions[0].Reason = string(gatewayv1.ListenerSetReasonNotAllowed)
				ls.Status.Conditions[0].ObservedGeneration = ls.Generation - 1
			})
			Expect(listenerSetRejection(ls)).To(ContainSubstring("has not been accepted"))
		})

		// Gateway API resolves a port conflict in the older listener's favour, so
		// an accepted ListenerSet can still carry a listener that never reaches a
		// dataplane — the hand-made Gateway listeners' state during a cutover.
		It("names a listener that lost its port to another listener", func() {
			ls := acceptedSet(func(ls *gatewayv1.ListenerSet) {
				ls.Status.Listeners = []gatewayv1.ListenerEntryStatus{{
					Name: "tcp-20000",
					Conditions: []metav1.Condition{{
						Type:    string(gatewayv1.ListenerEntryConditionConflicted),
						Status:  metav1.ConditionTrue,
						Reason:  string(gatewayv1.ListenerEntryReasonListenerConflict),
						Message: "port 20000 is already in use",
					}},
				}}
			})
			Expect(listenerSetRejection(ls)).To(ContainSubstring("tcp-20000"))
			Expect(listenerSetRejection(ls)).To(ContainSubstring("already in use"))
		})
	})

	Describe("podTemplateAnnotations", func() {
		It("carries the ssh keys revision only while ssh is exposed", func() {
			env := &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Annotations: map[string]string{
					sshKeysRevisionAnnotationKey: "sha256:deadbeef",
				}},
				Spec: aiv1alpha1.DevEnvironmentSpec{Type: aiv1alpha1.DevEnvironmentTypeSSH},
			}
			Expect(podTemplateAnnotations(env)).To(Equal(map[string]string{sshKeysRevisionAnnotationKey: "sha256:deadbeef"}))

			// Without ssh there is no revision to record, and an annotation on
			// the object must not leak onto the template.
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			Expect(podTemplateAnnotations(env)).To(BeNil())
		})
	})
})
var _ = Describe("DevEnvironmentReconciler construction", func() {
	// Only the config guard is testable here. A range that passes it reaches
	// builder.Complete, and controller-runtime's controller names are unique
	// per *process*, not per manager — the suite registered "devenvironment" in
	// BeforeSuite, so no second registration can succeed however it is built.
	// The valid path is therefore covered by the suite's own construction, and
	// these specs cover the guard by returning before the manager is touched.
	//
	// The error is asserted by message, not just by occurrence: with the guard
	// gone, registration fails on the duplicate name instead, and
	// HaveOccurred() alone would pass for that reason.
	It("rejects an L4 port range with no ports in it", func() {
		r := &DevEnvironmentReconciler{
			Config: DevEnvironmentControllerConfig{L4PortRangeStart: 30000, L4PortRangeEnd: 20000},
		}
		Expect(r.SetupWithManager(testMgr)).To(
			MatchError(ContainSubstring("L4 port range is empty")))
	})

	It("rejects an unset end that defaults below an explicit start", func() {
		// The guard runs on the defaulted config, so an unset end is 20999
		// rather than 0 — otherwise start=30000 would compare as valid.
		r := &DevEnvironmentReconciler{
			Config: DevEnvironmentControllerConfig{L4PortRangeStart: 30000},
		}
		Expect(r.SetupWithManager(testMgr)).To(
			MatchError(ContainSubstring("L4 port range is empty")))
	})

	It("rejects an L4 port range outside the port numbers", func() {
		// A range that is ordered but out of bounds reaches the ListenerSet as
		// a port the dataplane cannot listen on. The command-line flags reject
		// it too, but this is the last guard before it is used, and it is the
		// one a directly constructed controller meets.
		r := &DevEnvironmentReconciler{
			Config: DevEnvironmentControllerConfig{L4PortRangeStart: 20000, L4PortRangeEnd: 70000},
		}
		Expect(r.SetupWithManager(testMgr)).To(
			MatchError(ContainSubstring("outside the usable ports")))
	})
})

// countingClient counts the writes a reconciler issues. "Issued no write"
// cannot be observed on the stored object: the API server re-defaults a no-op
// update, finds nothing changed and keeps the resourceVersion. The call itself
// still runs the optimistic-concurrency check, and that is what surfaces as a
// conflict when it races another writer — so the assertion has to be on the
// call, not on the resource.
type countingClient struct {
	client.Client
	updates int
}

func (c *countingClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	c.updates++
	return c.Client.Update(ctx, obj, opts...)
}

var _ = Describe("DevEnvironment apply is idempotent", func() {
	It("issues no write when the stored resources already match", func() {
		env := validDevEnvironment("de-idem")
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		defer deleteEnv(env.Name)

		stored := &aiv1alpha1.DevEnvironment{}
		Expect(k8sClient.Get(ctx, envKey(env.Name), stored)).To(Succeed())

		counter := &countingClient{Client: k8sClient}
		r := &DevEnvironmentReconciler{Client: counter, Scheme: testScheme, Config: DevEnvironmentControllerConfig{
			GatewayName:               testDevEnvGatewayName,
			GatewayNamespace:          testNamespace,
			GatewayDataplaneNamespace: testGatewayDataplaneNamespace,
		}}
		gw := &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace}}

		// Creating the environment enqueues the reconciler the suite runs, so a
		// helper's Get may find nothing and then lose the Create to it. That
		// race is not what this spec is about: ignore the loser's
		// AlreadyExists and compare against whatever is stored.
		apply := func() {
			Expect(client.IgnoreAlreadyExists(r.applyService(ctx, stored))).To(Succeed())
			Expect(client.IgnoreAlreadyExists(r.applyNetworkPolicy(ctx, stored))).To(Succeed())
			_, err := r.applyHTTPRoute(ctx, stored, gw)
			Expect(client.IgnoreAlreadyExists(err)).To(Succeed())
			_, err = r.applyTCPRoute(ctx, stored, sshPortName, sshServicePort)
			Expect(client.IgnoreAlreadyExists(err)).To(Succeed())
		}

		apply() // every object is created
		Expect(counter.updates).To(BeZero())
		// The second pass is only meaningful against objects an API server
		// actually stored: assert they are there rather than letting a failed
		// create make the comparison below vacuous.
		Expect(k8sClient.Get(ctx, envKey(env.Name), &corev1.Service{})).To(Succeed())
		Expect(k8sClient.Get(ctx, envKey(env.Name), &networkingv1.NetworkPolicy{})).To(Succeed())
		Expect(k8sClient.Get(ctx, client.ObjectKey{
			Name: webRouteName(stored), Namespace: testNamespace,
		}, &gatewayv1.HTTPRoute{})).To(Succeed())
		Expect(k8sClient.Get(ctx, client.ObjectKey{
			Name: tcpRouteName(stored, sshServicePort), Namespace: testNamespace,
		}, &gatewayv1.TCPRoute{})).To(Succeed())

		// The objects are now stored by a real API server. Nothing the
		// controller owns has changed, so the second pass must not write: a
		// write here means the server's own defaults read as drift.
		apply()
		Expect(counter.updates).To(BeZero())

		// The deferred delete at the top only reaches the controller's cleanup
		// once the controller has adopted the environment, and adoption is the
		// finalizer its first reconcile patches on. Until then the API server
		// deletes the object outright: the reconciler is handed a name that is
		// already gone, runs no cleanup, and the objects this spec wrote itself —
		// Service, NetworkPolicy and routes above — outlive the environment that
		// owns them. envtest runs no garbage collector, so nothing reclaims them
		// on the ownerReference either, and a leaked TCPRoute keeps claiming its
		// pool port against every later spec that starts from an empty pool.
		// This is the only spec that creates controller-owned objects outside the
		// controller, which is why it is the only one that has to wait.
		Eventually(func(g Gomega) {
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			g.Expect(got.Finalizers).To(ContainElement(devEnvFinalizer))
		}, "15s", "200ms").Should(Succeed())
	})
})

var _ = Describe("DevEnvironment controller", func() {
	Context("provisioning", func() {
		It("creates the StatefulSet with the desired pod template", func() {
			env := validDevEnvironment("de-shape")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(1))))
				g.Expect(sts.Spec.ServiceName).To(Equal(env.Name))
				g.Expect(sts.Spec.Selector.MatchLabels).To(HaveKeyWithValue(devEnvironmentLabelKey, env.Name))
				g.Expect(sts.Spec.Template.Spec.Containers).To(HaveLen(1))
				c := sts.Spec.Template.Spec.Containers[0]
				g.Expect(c.Image).To(Equal(testDevImage))
				gpuLimit := c.Resources.Limits[corev1.ResourceName(testGPUResource)]
				gpuRequest := c.Resources.Requests[corev1.ResourceName(testGPUResource)]
				g.Expect(gpuLimit.Value()).To(Equal(int64(1)))
				g.Expect(gpuRequest.Value()).To(Equal(int64(1)))
				g.Expect(c.SecurityContext.RunAsUser).To(Equal(ptrTo(int64(1000))))
				g.Expect(c.SecurityContext.RunAsNonRoot).To(Equal(ptrTo(true)))
				g.Expect(c.ReadinessProbe).NotTo(BeNil())
				g.Expect(sts.Spec.VolumeClaimTemplates).To(HaveLen(1))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Name).To(Equal(workspaceClaimName))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.AccessModes).To(ContainElement(corev1.ReadWriteMany))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName).To(Equal(ptrTo(workspaceStorageClassName)))
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted).To(Equal(appsv1.RetainPersistentVolumeClaimRetentionPolicyType))
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled).To(Equal(appsv1.RetainPersistentVolumeClaimRetentionPolicyType))
				g.Expect(metav1.GetControllerOf(sts).UID).To(Equal(env.UID))
			}, "15s", "200ms").Should(Succeed())
		})

		It("requests the configured RDMA resource and shares the host network for roce", func() {
			env := validDevEnvironment("de-rdma-roce")
			env.Spec.Network = &aiv1alpha1.NetworkSpec{
				RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeRoCE,
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				tmpl := sts.Spec.Template.Spec
				g.Expect(tmpl.HostNetwork).To(BeTrue())
				g.Expect(tmpl.DNSPolicy).To(Equal(corev1.DNSClusterFirstWithHostNet))
				c := tmpl.Containers[0]
				key := corev1.ResourceName(testRDMARoCEResource)
				g.Expect(c.Resources.Limits).To(HaveKey(key))
				g.Expect(c.Resources.Requests).To(HaveKey(key))
				requested := c.Resources.Requests[key]
				g.Expect(requested.Value()).To(Equal(int64(1)))
				g.Expect(c.Resources.Limits).NotTo(HaveKey(corev1.ResourceName(testRDMAIBResource)))
				g.Expect(c.SecurityContext.Capabilities.Add).To(ContainElement(corev1.Capability("IPC_LOCK")))
				g.Expect(c.Ports).To(ContainElement(corev1.ContainerPort{
					Name: mainPortName, ContainerPort: 8888, HostPort: 8888, Protocol: corev1.ProtocolTCP,
				}))
			}, "15s", "200ms").Should(Succeed())
		})

		// The pod template is only reapplied when this annotation changes, so a
		// hash that did not cover spec.network would leave an RDMA environment
		// running the template it was created with, indefinitely.
		It("rolls the StatefulSet when RDMA is turned on", func() {
			env := validDevEnvironment("de-rdma-roll")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var before string
			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				before = sts.Annotations[stsSpecHashAnnotationKey]
				g.Expect(before).NotTo(BeEmpty())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeFalse())
			}, "15s", "200ms").Should(Succeed())

			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Network = &aiv1alpha1.NetworkSpec{
					RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeInfiniBand,
				}
			})

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Annotations[stsSpecHashAnnotationKey]).NotTo(Equal(before))
				g.Expect(sts.Spec.Template.Spec.Containers[0].Resources.Requests).
					To(HaveKey(corev1.ResourceName(testRDMAIBResource)))
			}, "15s", "200ms").Should(Succeed())
		})

		// A host-network environment's ports are host ports, so spec.ports
		// reaches the pod template rather than only the Service. The Service and
		// the routes are reconciled on their own, which is what makes a stale
		// template easy to miss: the port would be published end to end and
		// bound by nothing.
		It("rolls a host-network environment when its ports change", func() {
			env := validDevEnvironment("de-rdma-port-roll")
			env.Spec.Network = &aiv1alpha1.NetworkSpec{
				RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeRoCE,
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var before string
			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				before = sts.Annotations[stsSpecHashAnnotationKey]
				g.Expect(before).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Ports = []aiv1alpha1.PortSpec{
					{Name: testMetricsPortName, Type: aiv1alpha1.PortTypeHTTP, ContainerPort: 9090},
				}
			})

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Annotations[stsSpecHashAnnotationKey]).NotTo(Equal(before))
				g.Expect(sts.Spec.Template.Spec.Containers[0].Ports).To(ContainElement(corev1.ContainerPort{
					Name: testMetricsPortName, ContainerPort: 9090, HostPort: 9090, Protocol: corev1.ProtocolTCP,
				}))
			}, "15s", "200ms").Should(Succeed())
		})

		// The sidecar reads /proc, and a pod's containers each get their own PID
		// namespace unless the pod shares one — so without this the agent would
		// see nothing but itself and record an environment nobody is using. It
		// reads and writes only its own pod, through an account the controller
		// mints for it and deletes with the environment.
		It("gives an idle-enabled environment the activity agent and its account", func() {
			env := validDevEnvironment("de-agent")
			env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 3600}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			account := env.Name + activityAgentNameSuffix
			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				tmpl := sts.Spec.Template.Spec
				g.Expect(tmpl.ShareProcessNamespace).To(Equal(ptrTo(true)))
				g.Expect(tmpl.ServiceAccountName).To(Equal(account))
				g.Expect(tmpl.Containers).To(HaveLen(2))
				g.Expect(tmpl.Containers[0].Name).To(Equal(string(aiv1alpha1.DevEnvironmentTypeJupyter)))
				g.Expect(tmpl.Containers[1].Name).To(Equal(activityAgentContainerName))
				g.Expect(tmpl.Containers[1].Args).To(Equal([]string{"--ports=8888"}))
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				sa := &corev1.ServiceAccount{}
				g.Expect(k8sClient.Get(ctx, envKey(account), sa)).To(Succeed())
				g.Expect(metav1.GetControllerOf(sa).UID).To(Equal(env.UID))

				role := &rbacv1.Role{}
				g.Expect(k8sClient.Get(ctx, envKey(account), role)).To(Succeed())
				g.Expect(metav1.GetControllerOf(role).UID).To(Equal(env.UID))
				g.Expect(role.Rules).To(Equal([]rbacv1.PolicyRule{{
					APIGroups:     []string{""},
					Resources:     []string{"pods"},
					ResourceNames: []string{podName(env)},
					Verbs:         []string{"get", "patch"},
				}}))

				binding := &rbacv1.RoleBinding{}
				g.Expect(k8sClient.Get(ctx, envKey(account), binding)).To(Succeed())
				g.Expect(metav1.GetControllerOf(binding).UID).To(Equal(env.UID))
				g.Expect(binding.RoleRef.Name).To(Equal(account))
				g.Expect(binding.Subjects).To(Equal([]rbacv1.Subject{{
					Kind: rbacv1.ServiceAccountKind, Name: account, Namespace: testNamespace,
				}}))
			}, "15s", "200ms").Should(Succeed())
		})

		// The environment's NetworkPolicy is default-deny egress with a DNS
		// allowance, and NetworkPolicy admits traffic per pod rather than per
		// container. Without the apiserver rule the agent's PATCH is dropped, and
		// the agent deploys, runs, looks healthy and never records anything — the
		// one failure in this feature that is invisible from every direction.
		It("admits the activity agent to the apiserver, and DNS wherever the cluster resolves", func() {
			// The suite creates default/kubernetes (suite_test.go); read back the
			// address it was given rather than naming one, so this asserts the
			// controller read that Service instead of assuming an address.
			apiserver := &corev1.Service{}
			Expect(k8sClient.Get(ctx,
				client.ObjectKey{Name: kubernetesServiceName, Namespace: metav1.NamespaceDefault}, apiserver)).To(Succeed())
			Expect(netip.MustParseAddr(apiserver.Spec.ClusterIP).Is4()).To(BeTrue(),
				"envtest allocates an IPv4 service address, which is what the /32 below assumes")

			// The address a CNI that filters after the service rewrite sees in place
			// of the ClusterIP. Every cluster's kube-apiserver publishes its own
			// address and port here — envtest's does too, which is why this reads
			// the object rather than writing one: the test then asserts the rule
			// against the apiserver the suite is really talking to, on the port it
			// really listens on.
			//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; it is what the rule reads.
			endpoints := &corev1.Endpoints{}
			Expect(k8sClient.Get(ctx,
				client.ObjectKey{Name: kubernetesServiceName, Namespace: metav1.NamespaceDefault}, endpoints)).To(Succeed())
			Expect(endpoints.Subsets).To(HaveLen(1))
			Expect(endpoints.Subsets[0].Addresses).To(HaveLen(1))
			Expect(endpoints.Subsets[0].Ports).To(HaveLen(1))
			endpointAddress := endpoints.Subsets[0].Addresses[0].IP
			endpointPort := endpoints.Subsets[0].Ports[0].Port

			env := validDevEnvironment("de-agent-netpol")
			env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 3600}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				np := &networkingv1.NetworkPolicy{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), np)).To(Succeed())
				// The DNS allowance stays first; the apiserver's is appended.
				g.Expect(np.Spec.Egress).To(HaveLen(2))

				// The DNS rule names no peer: where a cluster resolves is the
				// cluster's choice — the DNS Service's ClusterIP, a node-local
				// cache's address, whatever --cluster-dns says — and a rule
				// peering on the kube-dns pods admits nothing at all on a
				// cluster whose pods dial a cache instead. Port 53 is the whole
				// of the allowance.
				dns := np.Spec.Egress[0]
				g.Expect(dns.To).To(BeEmpty())
				g.Expect(dns.Ports).To(HaveLen(2))
				g.Expect(*dns.Ports[0].Port).To(Equal(intstr.FromInt32(53)))
				g.Expect(*dns.Ports[1].Port).To(Equal(intstr.FromInt32(53)))

				// Both addresses the apiserver answers at, on both ports: the
				// ClusterIP on the Service's port for a CNI that filters before
				// the service rewrite, the endpoint on its target port for one
				// that filters after it. Asserted as a set — the controller sorts
				// both lists so that a reordered Endpoints cannot churn the
				// render, and which of the two addresses sorts first is a
				// property of the addresses, not a contract.
				rule := np.Spec.Egress[1]
				g.Expect(rule.To).To(HaveLen(2))
				g.Expect(rule.To).To(ContainElement(
					networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{CIDR: apiserver.Spec.ClusterIP + "/32"}}))
				g.Expect(rule.To).To(ContainElement(
					networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{CIDR: endpointAddress + "/32"}}))

				tcp := corev1.ProtocolTCP
				servicePort := intstr.FromInt32(443)
				apiserverPort := intstr.FromInt32(endpointPort)
				g.Expect(rule.Ports).To(HaveLen(2))
				g.Expect(rule.Ports).To(ContainElement(
					networkingv1.NetworkPolicyPort{Protocol: &tcp, Port: &servicePort}))
				g.Expect(rule.Ports).To(ContainElement(
					networkingv1.NetworkPolicyPort{Protocol: &tcp, Port: &apiserverPort}))
			}, "15s", "200ms").Should(Succeed())
		})

		// An environment that asks for no idle timeout must not gain one, and must
		// not be rewritten for not having one — the hash is hand-assembled
		// (::stsSpecHash), so a template field it does not cover would roll every
		// environment in the cluster on the next reconcile.
		It("rolls the StatefulSet when an idle timeout is turned on", func() {
			env := validDevEnvironment("de-idle-roll")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var before string
			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				before = sts.Annotations[stsSpecHashAnnotationKey]
				g.Expect(before).NotTo(BeEmpty())
				g.Expect(sts.Spec.Template.Spec.Containers).To(HaveLen(1))
				sa := &corev1.ServiceAccount{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx,
					envKey(env.Name+activityAgentNameSuffix), sa))).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 3600}
			})

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Annotations[stsSpecHashAnnotationKey]).NotTo(Equal(before))
				g.Expect(sts.Spec.Template.Spec.Containers).To(HaveLen(2))
				g.Expect(sts.Spec.Template.Spec.ShareProcessNamespace).To(Equal(ptrTo(true)))
			}, "15s", "200ms").Should(Succeed())
		})

		// The grant is worth having only while the sidecar exists to use it, so
		// turning an idle timeout off has to take the account away with it: it can
		// read and patch the pod, and nothing else would ever come back for it.
		It("withdraws the agent's account when the idle timeout is turned off", func() {
			env := validDevEnvironment("de-idle-off")
			env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 3600}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			account := env.Name + activityAgentNameSuffix
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(account), &corev1.ServiceAccount{})).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 0}
			})

			Eventually(func(g Gomega) {
				sa := &corev1.ServiceAccount{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(account), sa))).To(BeTrue())
				role := &rbacv1.Role{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(account), role))).To(BeTrue())
				binding := &rbacv1.RoleBinding{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(account), binding))).To(BeTrue())

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.Containers).To(HaveLen(1))
				g.Expect(sts.Spec.Template.Spec.ShareProcessNamespace).To(BeNil())
				g.Expect(sts.Spec.Template.Spec.ServiceAccountName).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("admits the platform Gateway's dataplane into the environment", func() {
			env := validDevEnvironment("de-netpol")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				np := &networkingv1.NetworkPolicy{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), np)).To(Succeed())
				g.Expect(np.Spec.Ingress).To(HaveLen(1))
				g.Expect(np.Spec.Ingress[0].From).To(HaveLen(1))
				g.Expect(np.Spec.Ingress[0].From[0].NamespaceSelector.MatchLabels).To(HaveKeyWithValue(
					"kubernetes.io/metadata.name", testGatewayDataplaneNamespace))
				g.Expect(np.Spec.Ingress[0].From[0].PodSelector.MatchLabels).To(HaveKeyWithValue(
					gatewayDataplaneNameLabel, testDevEnvGatewayName))
				g.Expect(metav1.GetControllerOf(np).UID).To(Equal(env.UID))
			}, "15s", "200ms").Should(Succeed())
		})

		It("scales the StatefulSet with running and reports Stopped", func() {
			env := validDevEnvironment("de-scale")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(1))))
			}, "15s", "200ms").Should(Succeed())

			fresh := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), fresh)).To(Succeed())
			fresh.Spec.Running = false
			Expect(k8sClient.Update(ctx, fresh)).To(Succeed())

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(0))))

				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("fails a gpu vendor/image brand mismatch without provisioning", func() {
			env := validDevEnvironment("de-brand-bad")
			env.Spec.Image = "harbor.local/ai-images/base-maca:1.0"
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionAccepted)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got.Status.Phase.Reason).To(Equal(reasonBrandMismatch))
				// The refusal has to say what the user can change: the condition is
				// the only place the finding is reported.
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Reason).To(Equal(reasonBrandMismatch))
				g.Expect(cond.Message).To(ContainSubstring("must be updated"))
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(env.Name), sts))).To(BeTrue())
		})

		// NOTEBOOK_ARGS is where the controller tells the notebook which prefix to
		// serve, and the published route is the prefix it picked. A valueFrom
		// source cannot be read while reconciling, so the environment is refused
		// rather than provisioned with an address that 404s.
		It("refuses a jupyter environment whose NOTEBOOK_ARGS comes from valueFrom", func() {
			env := validDevEnvironment("de-notebook-args-from")
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{{
				Name: notebookArgsEnv,
				ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: "notebook-args"},
					Key:                  "args",
				}},
			}}}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionAccepted)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got.Status.Phase.Reason).To(Equal(reasonNotebookArgsUnusable))
				// This refusal used to be reported by Ready alone; the condition is
				// what now carries it, and the message has to name the variable and
				// the flag: it is the only place the user learns what to change.
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Reason).To(Equal(reasonNotebookArgsUnusable))
				g.Expect(cond.Message).To(ContainSubstring("runtime.env[" + notebookArgsEnv + "]: must be updated"))
				g.Expect(cond.Message).To(ContainSubstring(notebookBaseURLFlag))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(env.Name), sts))).To(BeTrue())
		})

		// The gate must not catch a plain value: the controller can read one, and
		// rewrites it in the pod spec instead of refusing the environment.
		It("provisions a jupyter environment that declares NOTEBOOK_ARGS as a plain value", func() {
			env := validDevEnvironment("de-notebook-args-plain")
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{
				{Name: notebookArgsEnv, Value: "--ServerApp.base_url=/served/elsewhere/"},
			}}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.Containers[0].Env).To(ContainElement(corev1.EnvVar{
					Name: notebookArgsEnv, Value: notebookBaseURLFlag + webPath(env),
				}))
			}, "15s", "200ms").Should(Succeed())

			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			Expect(got.Status.Phase).NotTo(BeNil())
			Expect(got.Status.Phase.Name).NotTo(Equal(aiv1alpha1.PhaseFailed))
		})

		It("accepts a matching image brand and provisions", func() {
			env := validDevEnvironment("de-brand-good")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionAccepted)).To(BeTrue())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(cond.Reason).To(Equal(reasonAccepted))
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
		})

		It("provisions a CPU-only environment from a non-brand image", func() {
			env := validDevEnvironment("de-cpu-only")
			// A CPU image the brand gate would reject if a GPU were requested, and
			// no gpu block — which is the whole request.
			env.Spec.Resources.GPU = nil
			env.Spec.Image = testCPUImage
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				// No gpu block is not a finding: there is no brand to disagree with,
				// which is what this condition reports rather than the exemption.
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(cond.Reason).To(Equal(reasonAccepted))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).NotTo(Equal(aiv1alpha1.PhaseFailed))
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
			c := sts.Spec.Template.Spec.Containers[0]
			// No vendor key in either map: a zero request would still pin the
			// pod to a node advertising that resource.
			Expect(c.Resources.Requests).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(c.Resources.Limits).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(c.Resources.Limits).NotTo(HaveKey(corev1.ResourceName("metax-tech.com/gpu")))
		})

		// The other disposition, end to end: the controller resolves a declared value
		// rather than refusing it, and the environment runs with the controller's
		// value. The condition naming every field it replaced is the only place a
		// user learns that what they wrote is not what is running.
		It("accepts an environment whose declared values the controller resolves", func() {
			env := validDevEnvironment("de-accepted-overridden")
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
				User:            testRuntimeUser,
				SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				Env: []corev1.EnvVar{
					{Name: nbGIDEnv, Value: "1000"},
					{Name: jupyterTokenEnv, Value: "chosen-by-the-user"},
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(cond.Reason).To(Equal(reasonOverridden))
				for _, field := range []string{nbGIDEnv, jupyterTokenEnv} {
					g.Expect(cond.Message).To(ContainSubstring("spec.runtime.env[" + field + "]: ignored — "))
				}
				// The advertised account is the second half of running as root: this
				// one is a field rather than an env entry, and is reported the same way.
				g.Expect(cond.Message).To(ContainSubstring("spec.runtime.user: ignored — "))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).NotTo(Equal(aiv1alpha1.PhaseFailed))
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
		})

		It("withdraws compute and routes when a running environment becomes mismatched", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-brand-transition")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, true, nil)
			// The synthetic pod has no owner reference, so deleteEnv cannot
			// remove it; clean it up here so it does not leak into later specs.
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			// The environment provisions and runs: the StatefulSet is scaled to
			// 1 and the routes are published.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).NotTo(BeNil())
				g.Expect(*sts.Spec.Replicas).To(Equal(int32(1)))
			}, "15s", "200ms").Should(Succeed())

			// Editing the image into a brand mismatch must withdraw the
			// previously-provisioned compute and access before marking Failed.
			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			got.Spec.Image = "harbor.local/ai-images/base-maca:1.0"
			Expect(k8sClient.Update(ctx, got)).To(Succeed())

			Eventually(func(g Gomega) {
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got2)).To(Succeed())
				g.Expect(got2.Status.Phase).NotTo(BeNil())
				g.Expect(got2.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got2.Status.Phase.Reason).To(Equal(reasonBrandMismatch))
				g.Expect(got2.Status.Endpoints).To(BeEmpty())
				// Compute is withdrawn: the StatefulSet is scaled to zero.
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).NotTo(BeNil())
				g.Expect(*sts.Spec.Replicas).To(Equal(int32(0)))
				// Access is withdrawn: no HTTP or TCP routes remain.
				var hrs gatewayv1.HTTPRouteList
				g.Expect(k8sClient.List(ctx, &hrs, client.InNamespace(testNamespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name})).To(Succeed())
				g.Expect(hrs.Items).To(BeEmpty())
				var trs gatewayv1.TCPRouteList
				g.Expect(k8sClient.List(ctx, &trs, client.InNamespace(testNamespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name})).To(Succeed())
				g.Expect(trs.Items).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("phase", func() {
		It("reports Pending while the pod does not exist", func() {
			env := validDevEnvironment("de-phase-no-pod")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhasePending))
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionPodScheduled)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports Running when the pod is running and ready", func() {
			env := validDevEnvironment("de-phase-running")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, true, nil)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionPodScheduled)).To(BeTrue())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports Failed when the pod is crash-looping", func() {
			env := validDevEnvironment("de-phase-failed")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, false,
				&corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff", Message: "back-off"})

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got.Status.Phase.Reason).To(Equal(crashLoopBackOff))
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports Running but not Ready while the pod runs without passing readiness", func() {
			env := validDevEnvironment("de-phase-running-unready")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, false, nil)
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionPodScheduled)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("status generation", func() {
		It("tracks observedGeneration and re-derives status after a spec change", func() {
			env := validDevEnvironment("de-gen")
			env.Spec.Running = false
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.ObservedGeneration).To(Equal(got.Generation))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
			}, "15s", "200ms").Should(Succeed())

			// A spec edit bumps metadata.generation; the status is re-derived for
			// the new generation (observedGeneration catches up), never left stale.
			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Running = true
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.ObservedGeneration).To(Equal(got.Generation))
				g.Expect(got.Status.Phase).NotTo(BeNil())
			}, "15s", "200ms").Should(Succeed())
		})

		// StorageReady left the API with the workspace claim's lifecycle (the
		// StatefulSet owns it now), and BrandMatchValid left it when the brand gate
		// was folded into Accepted. An environment reconciled by a manager that
		// still reported either would keep the condition on status forever, with
		// nothing left that can clear it, so each is dropped during reconcile.
		DescribeTable("drops a condition the controller no longer reports",
			func(name, condition string) {
				env := validDevEnvironment(name)
				Expect(k8sClient.Create(ctx, env)).To(Succeed())
				defer deleteEnv(env.Name)

				Eventually(func(g Gomega) {
					got := &aiv1alpha1.DevEnvironment{}
					g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
					g.Expect(got.Finalizers).To(ContainElement(devEnvFinalizer))
				}, "15s", "200ms").Should(Succeed())

				// Restore the condition an older manager wrote. The merge patch adds it
				// by type without touching the conditions already on status.
				legacy := []byte(`{"status":{"conditions":[{"type":"` + condition + `","status":"True","reason":"Bound",` +
					`"message":"left over from a manager that still reported it","lastTransitionTime":"2026-01-01T00:00:00Z"}]}}`)
				Expect(k8sClient.Status().Patch(ctx, env, client.RawPatch(types.MergePatchType, legacy))).To(Succeed())

				// The patch is itself a watched update, so it drives the reconcile that
				// has to drop the condition again.
				Eventually(func(g Gomega) {
					got := &aiv1alpha1.DevEnvironment{}
					g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
					g.Expect(meta.FindStatusCondition(got.Status.Conditions, condition)).To(BeNil())
					g.Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionReady)).NotTo(BeNil())
				}, "15s", "200ms").Should(Succeed())
			},
			Entry("StorageReady", "de-legacy-storage", legacyStorageReadyCondition),
			Entry("BrandMatchValid", "de-legacy-brand", legacyBrandMatchValidCondition),
		)
	})

	Context("lifecycle events", func() {
		It("records a Created event on adoption and a Started event on running", func() {
			env := validDevEnvironment("de-ev-start")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				g.Expect(listEventsForEnv(env.Name, eventReasonCreated)).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			createStatefulPod(env, true, nil)
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				g.Expect(listEventsForEnv(env.Name, eventReasonStarted)).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("records a Stopped event when running is set to false", func() {
			env := validDevEnvironment("de-ev-stop")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, true, nil)
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			// Converge to Running first, so the later stop is a real transition.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Running = false
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(listEventsForEnv(env.Name, eventReasonStopped)).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("records a Warning Failed event on a gpu vendor/image brand mismatch", func() {
			env := validDevEnvironment("de-ev-fail")
			env.Spec.Image = testBaseMacaImage
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				evts := listEventsForEnv(env.Name, eventReasonFailed)
				g.Expect(evts).NotTo(BeEmpty())
				g.Expect(evts[0].Type).To(Equal(corev1.EventTypeWarning))
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("idle auto-stop", func() {
		// idleTimeout is an hour, and the agent's mark below is two hours old, so
		// the window has certainly elapsed by the time the controller reads it —
		// the stale mark is the clock, and no spec waits on a real timeout. The
		// hour is what keeps the far end of the specs honest too: a freshly
		// reported environment is an hour from its deadline, so nothing stops
		// again while a spec is looking at it.
		const idleTimeout int32 = 3600
		staleMark := func() time.Time { return time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second) }

		// idleWithTimeout builds the environment these specs drive: valid, with the
		// idle timeout on. Everything else about it is the ordinary fixture, so the
		// workspace it declares is the one the retention spec gives it.
		idleWithTimeout := func(name string, seconds int32) *aiv1alpha1.DevEnvironment {
			env := validDevEnvironment(name)
			env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: seconds}
			return env
		}

		// markActivity writes the agent's mark onto the fabricated pod, the way the
		// agent would. A raw patch rather than an Update: the manager is watching
		// this pod, and an Update would carry back the whole spec and
		// resourceVersion of a copy read moments earlier.
		markActivity := func(env *aiv1alpha1.DevEnvironment, at time.Time) {
			pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}}
			body := []byte(`{"metadata":{"annotations":{"` + activity.AnnotationKey + `":"` + stampActivity(at) + `"}}}`)
			Expect(k8sClient.Patch(ctx, pod, client.RawPatch(types.MergePatchType, body))).To(Succeed())
		}

		// deletePod removes the fabricated pod. Left behind it keeps driving its
		// environment, and the next spec of the same environment would not be able
		// to create its own.
		//
		// The zero grace period is not incidental. The pod is bound to a node, and
		// envtest runs no kubelet to confirm the termination, so an ordinary delete
		// leaves it Terminating forever — visible, but never gone.
		deletePod := func(env *aiv1alpha1.DevEnvironment) {
			pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}}
			_ = k8sClient.Delete(ctx, pod, client.GracePeriodSeconds(0))
		}

		// replacePod stands in for the StatefulSet controller, which envtest does
		// not run: stopping the environment deletes the pod, and starting it brings
		// a fresh one up whose agent is only beginning to report.
		//
		// The other half of that controller's job — the gap between the scale-down
		// being written and the pod actually going away — is not simulated here.
		// It is exercised where it matters, by the specs below that clear the mark
		// with the old pod still standing.
		replacePod := func(env *aiv1alpha1.DevEnvironment, at time.Time) {
			deletePod(env)
			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(podName(env)), &corev1.Pod{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
			createStatefulPod(env, true, nil)
			markActivity(env, at)
		}

		// stopForIdle drives an environment to the auto-stopped state and returns
		// the instant the agent had reported, which the caller asserts on.
		stopForIdle := func(g Gomega, env *aiv1alpha1.DevEnvironment) {
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})).To(Succeed())
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			g.Expect(got.Status.Phase).NotTo(BeNil())
			g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
			g.Expect(got.Status.Phase.Reason).To(Equal(reasonIdleTimeout))
		}

		It("stops an idle environment without touching spec.running, and keeps its workspace", func() {
			env := idleWithTimeout("de-idle-stop", idleTimeout)
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// The StatefulSet the controller renders is what owns the workspace
			// claim, so the claim has to be built against it.
			sts := &appsv1.StatefulSet{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			stale := staleMark()
			createStatefulPod(env, true, nil)
			defer deletePod(env)
			markActivity(env, stale)
			claim := createWorkspaceClaim(env, sts)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())

				// The mark is the whole of the state, and it is what says stopped:
				// the spec still says what the user asked for, which is the point
				// of stopping this way at all.
				g.Expect(got.Annotations).To(HaveKeyWithValue(autoStoppedAnnotationKey, autoStoppedValue))
				g.Expect(got.Spec.Running).To(BeTrue())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(got.Status.Phase.Reason).To(Equal(reasonIdleTimeout))

				// lastActivityTime is the agent's own report — the instant the pod
				// annotation carries — and not the pod's start, which is the fallback
				// the judgement uses but never records.
				g.Expect(got.Status.LastActivityTime).NotTo(BeNil())
				g.Expect(got.Status.LastActivityTime.Time).To(BeTemporally("==", stale))

				// The workload is scaled to zero and the workspace survives it.
				cur := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				g.Expect(cur.Spec.Replicas).NotTo(BeNil())
				g.Expect(*cur.Spec.Replicas).To(Equal(int32(0)))
				g.Expect(k8sClient.Get(ctx, envKey(claim.Name), &corev1.PersistentVolumeClaim{})).To(Succeed())

				// And the stop is reported in the audit trail under its own reason,
				// so it can be told apart from a stop the user asked for.
				evts := listEventsForEnv(env.Name, eventReasonIdleTimeout)
				g.Expect(evts).NotTo(BeEmpty())
				g.Expect(evts[0].Type).To(Equal(corev1.EventTypeNormal))
			}, "15s", "200ms").Should(Succeed())
		})

		It("stops an environment that has never reported any activity", func() {
			// Nothing has ever marked this pod active, which is what an environment
			// created and then abandoned looks like — and an ssh-only one whose
			// only workload the agent denylists looks like it forever. Its own
			// start is the newest instant it could have been used, so the fallback
			// cannot stop a pod before the timeout has passed.
			env := idleWithTimeout("de-idle-silent", 1)
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			createStatefulPod(env, true, nil)
			defer deletePod(env)

			Eventually(func(g Gomega) {
				stopForIdle(g, env)
			}, "20s", "200ms").Should(Succeed())

			// The pod's start is not an activity time, so status says nothing about
			// when anyone worked rather than claiming the pod's own start.
			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			Expect(got.Status.LastActivityTime).To(BeNil())
		})

		// clearMark is a client starting an auto-stopped environment the way §4.4
		// says the console does: the mark goes and spec.running, which the platform
		// deliberately left true, stays as it is.
		clearMark := func(env *aiv1alpha1.DevEnvironment) {
			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				delete(cur.Annotations, autoStoppedAnnotationKey)
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())
		}

		It("keeps a start that clears the mark while the stopped pod is still with it", func() {
			// The pod a stop takes away does not leave the instant the mark is
			// written — the scale-down lands a moment later — and until it does, the
			// old pod is the one the controller observes: running, ready, and still
			// carrying the activity mark that made it look idle. Clearing the mark is
			// a start, and judging that start against the pod of the session before
			// it would re-mark the environment the user has just restarted.
			//
			// envtest is in that state by construction, which is why the pod here is
			// deliberately left standing: nothing runs the StatefulSet controller, so
			// nothing deletes it and it carries no deletion timestamp.
			env := idleWithTimeout("de-idle-race", idleTimeout)
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			createStatefulPod(env, true, nil)
			defer deletePod(env)
			markActivity(env, staleMark())
			Eventually(func(g Gomega) {
				stopForIdle(g, env)
			}, "15s", "200ms").Should(Succeed())

			clearMark(env)

			// The start is kept: the mark stays off, the phase goes back to Running,
			// and the workload is asked back for.
			kept := func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Annotations).NotTo(HaveKey(autoStoppedAnnotationKey))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))

				cur := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				g.Expect(cur.Spec.Replicas).NotTo(BeNil())
				g.Expect(*cur.Spec.Replicas).To(Equal(int32(1)))
			}
			// eventually before consistently, because the phase is the controller's:
			// until the pass that reads the cleared mark has written its own, the
			// environment still reports the stop that pass is undoing.
			Eventually(kept, "15s", "200ms").Should(Succeed())
			Consistently(kept, "3s", "200ms").Should(Succeed())
		})

		It("restarts the idle clock at the stop rather than disarming it", func() {
			// The floor is a floor, not a veto. The pod above outlives its own stop
			// and its activity mark is older than the stop, so if the floor simply
			// disqualified it the environment would run until the pod was replaced —
			// the timeout silently off with nothing to say so. Measuring from the
			// stop instead gives it the timeout over again, which is what this spec
			// watches happen.
			env := idleWithTimeout("de-idle-floor", 1)
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			createStatefulPod(env, true, nil)
			defer deletePod(env)
			markActivity(env, staleMark())
			Eventually(func(g Gomega) {
				stopForIdle(g, env)
			}, "15s", "200ms").Should(Succeed())

			// When the controller made that stop, which is what distinguishes it from
			// the one the spec waits for below.
			first := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), first)).To(Succeed())
			firstStop := first.Annotations[autoStoppedAtAnnotationKey]
			Expect(firstStop).NotTo(BeEmpty())

			clearMark(env)

			// The same pod, one timeout after the stop it survived — and a *second*
			// stop, rather than the first one read again. Until the pass that reads the
			// cleared mark has written its own status, the environment still reports
			// the stop the clear is undoing, so waiting for Stopped alone would be
			// satisfied by the stop just made and would prove nothing.
			//
			// The stop's own timestamp is the evidence, rather than an intervening
			// Running: the environment is Running for barely the timeout — a second
			// here — before it stops again, and a lookup that misses that window would
			// fail a spec that had watched the clock restart perfectly well. The
			// timestamp cannot be missed, and only the controller writes it.
			Eventually(func(g Gomega) {
				stopForIdle(g, env)

				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Annotations[autoStoppedAtAnnotationKey]).NotTo(Equal(firstStop))
			}, "20s", "200ms").Should(Succeed())
		})

		It("returns to Running when the user stops and starts the environment", func() {
			env := idleWithTimeout("de-idle-restart", idleTimeout)
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			createStatefulPod(env, true, nil)
			defer deletePod(env)
			markActivity(env, staleMark())
			Eventually(func(g Gomega) {
				stopForIdle(g, env)
			}, "15s", "200ms").Should(Succeed())

			// The user stops it. An explicit stop is the user speaking for
			// themselves, so the platform's own mark goes with it — and the phase
			// reports the stop the user made, not the one the timeout made.
			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Running = false
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Annotations).NotTo(HaveKey(autoStoppedAnnotationKey))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(got.Status.Phase.Reason).To(Equal(reasonStopped))
			}, "15s", "200ms").Should(Succeed())

			// The pod the stop would have taken away comes back with an agent that
			// is reporting again, and then the user starts the environment.
			replacePod(env, time.Now().UTC().Truncate(time.Second))
			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Running = true
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Annotations).NotTo(HaveKey(autoStoppedAnnotationKey))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
			}, "15s", "200ms").Should(Succeed())
		})

		It("leaves an environment that never asked for a timeout alone", func() {
			// The stale mark is the signal that would stop it, so this is the case
			// that proves the timeout is opt-in: no Lifecycle, no judgement, however
			// old the agent's last report is.
			env := validDevEnvironment("de-idle-optout")
			Expect(env.Spec.Lifecycle).To(BeNil())
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			createStatefulPod(env, true, nil)
			defer deletePod(env)
			markActivity(env, staleMark())

			// The window has to open on an environment the controller has already
			// looked at: Consistently samples from the moment it is called, and the
			// first sample would otherwise catch the status of an environment whose
			// first reconcile has not finished writing it.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
			}, "15s", "200ms").Should(Succeed())

			Consistently(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Annotations).NotTo(HaveKey(autoStoppedAnnotationKey))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).NotTo(BeNil())
				g.Expect(*sts.Spec.Replicas).To(Equal(int32(1)))
			}, "3s", "200ms").Should(Succeed())
		})
	})

	Context("ssh", func() {
		// Case 1: the environment names no keys of its own, so the controller mints
		// both Secrets — the platform's host identity, and a login keypair its owner
		// can retrieve and actually authenticate with.
		It("mints a host key and a retrievable login keypair when no keys are given", func() {
			env := validDevEnvironment("de-ssh")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				// status names the generated client key Secret: the one carrying
				// the key its owner logs in with, not the platform's host identity.
				g.Expect(got.Status.SSHClientKeySecret).To(Equal(&corev1.SecretReference{
					Name:      sshClientKeySecretName(env),
					Namespace: testNamespace,
				}))

				host := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
				g.Expect(host.Data).To(HaveKey(sshHostPubKeyKey))
				g.Expect(string(host.Data[sshHostPubKeyKey])).To(HavePrefix("ssh-ed25519 "))
				// sshd reads the private key as-is, so it has to be in the format
				// sshd accepts — and describe the advertised public key. The host
				// Secret carries the identity and nothing else.
				g.Expect(sshKeyPairMatches(host.Data[sshHostKeyKey], host.Data[sshHostPubKeyKey])).To(BeTrue())
				g.Expect(host.Data).NotTo(HaveKey(sshAuthorizedKeysKey))

				login := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshClientKeySecretName(env)), login)).To(Succeed())
				g.Expect(sshKeyPairMatches(login.Data[sshClientKeyKey], login.Data[sshClientPubKeyKey])).To(BeTrue())
				// The public half is what the mount takes, so a login works without
				// the controller keeping a second copy of it under another name — and
				// the Secret carries the keypair and nothing else.
				g.Expect(login.Data).To(HaveLen(2))
				g.Expect(login.Data).NotTo(HaveKey(sshAuthorizedKeysKey))
				// Two independent keypairs: the login key is not the host key.
				g.Expect(login.Data[sshClientPubKeyKey]).NotTo(Equal(host.Data[sshHostPubKeyKey]))
			}, "15s", "200ms").Should(Succeed())
		})

		// Case 2: the environment brings its own public keys, so the controller
		// mints the host identity only and the user's Secret is mounted as it is.
		It("mounts the referenced keys Secret without copying out of it", func() {
			keys := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      testUserKeysSecret,
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{testUserKeysKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, keys)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, keys) }()

			env := validDevEnvironment("de-ssh-keys")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: keys.Name},
					Key:                  testUserKeysKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				// Status records nothing: the user's own Secret is already named in
				// the spec, and it holds public keys rather than a generated client
				// key, so there is none for status to point at.
				g.Expect(got.Status.SSHClientKeySecret).To(BeNil())

				host := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
				g.Expect(sshKeyPairMatches(host.Data[sshHostKeyKey], host.Data[sshHostPubKeyKey])).To(BeTrue())

				// The user supplied the keys, so there is nothing else to mint.
				generated := &corev1.Secret{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(sshClientKeySecretName(env)), generated))).To(BeTrue())

				// And their Secret is left exactly as it was: the controller mounts
				// it, it does not copy out of it.
				fresh := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(keys.Name), fresh)).To(Succeed())
				g.Expect(fresh.Data).To(Equal(map[string][]byte{testUserKeysKey: []byte(testUserSSHKey)}))
			}, "15s", "200ms").Should(Succeed())
		})

		// Rotating the user's keys must not restart their environment: the volume is
		// a directory mount, which kubelet updates in place, and the revision covers
		// the host key alone so that nothing rolls. Reverting the digest to include
		// the authorized keys fails this with two different spec hashes.
		It("does not roll the workload when the referenced keys Secret changes", func() {
			rotated := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI rotated-key alice@example.com"
			keys := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "dev-alice-rotate-keys",
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{testUserKeysKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, keys)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, keys) }()

			env := validDevEnvironment("de-rotate-keys")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: keys.Name},
					Key:                  testUserKeysKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var hostKeyBefore []byte
			var hashBefore string
			Eventually(func(g Gomega) {
				host := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
				hostKeyBefore = host.Data[sshHostKeyKey]
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				// The revision digests the host key alone: the authorized keys come
				// from the user's own Secret and are deliberately outside it.
				g.Expect(sts.Spec.Template.Annotations[sshKeysRevisionAnnotationKey]).
					To(Equal(sshHostKeyDigest(host.Data[sshHostKeyKey])))
				g.Expect(sts.Spec.Template.Spec.Volumes[1].Secret.Items).
					To(Equal([]corev1.KeyToPath{{Key: testUserKeysKey, Path: sshAuthorizedKeysFile}}))
				hashBefore = sts.Annotations[stsSpecHashAnnotationKey]
			}, "15s", "200ms").Should(Succeed())

			// Rotate the user's keys. The watch on the referenced Secret re-reconciles
			// the environment, which re-checks the reference — but the new bytes reach
			// the pod through the volume, so the rotation must not enter the pod
			// template at all.
			freshKeys := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, envKey(keys.Name), freshKeys)).To(Succeed())
			freshKeys.Data[testUserKeysKey] = []byte(rotated)
			Expect(k8sClient.Update(ctx, freshKeys)).To(Succeed())

			// Deleting the StatefulSet is what makes that checkable: the reconcile
			// that recreates it recomputes the hash from scratch, so a recreated
			// StatefulSet carrying the same hash proves the rotated bytes are not in
			// it. Asserting only that nothing changed would also pass if no reconcile
			// ever ran.
			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
			Expect(k8sClient.Delete(ctx, sts)).To(Succeed())

			Eventually(func(g Gomega) {
				recreated := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), recreated)).To(Succeed())
				g.Expect(recreated.Annotations[stsSpecHashAnnotationKey]).To(Equal(hashBefore))
				g.Expect(recreated.Spec.Template.Annotations[sshKeysRevisionAnnotationKey]).
					To(Equal(sshHostKeyDigest(hostKeyBefore)))
			}, "15s", "200ms").Should(Succeed())

			// The host identity belongs to the platform and does not move with the
			// user's keys.
			host := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
			Expect(host.Data[sshHostKeyKey]).To(Equal(hostKeyBefore))
		})

		It("rolls the workload when keysSecret is re-pointed at an equivalent Secret", func() {
			// Two Secrets holding the same content are indistinguishable to the
			// revision, which covers the host key alone. The pod template still
			// names the Secret it mounts, and an environment reconciled by the
			// pre-split controller is exactly this case: its bundled Secret held a
			// copy of the user's keys. The spec hash has to carry the mount — the
			// source and the shape — or the workload keeps the old one.
			newKeysSecret := func(name string) *corev1.Secret {
				return &corev1.Secret{
					ObjectMeta: metav1.ObjectMeta{
						Name:      name,
						Namespace: testNamespace,
						Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
					},
					Data: map[string][]byte{testUserKeysKey: []byte(testUserSSHKey)},
				}
			}
			first := newKeysSecret("dev-repoint-first-keys")
			second := newKeysSecret("dev-repoint-second-keys")
			Expect(k8sClient.Create(ctx, first)).To(Succeed())
			Expect(k8sClient.Create(ctx, second)).To(Succeed())
			defer func() {
				_ = k8sClient.Delete(ctx, first)
				_ = k8sClient.Delete(ctx, second)
			}()

			env := validDevEnvironment("de-repoint-keys")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: first.Name},
					Key:                  testUserKeysKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			mountedSource := func(g Gomega, sts *appsv1.StatefulSet) string {
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				for _, v := range sts.Spec.Template.Spec.Volumes {
					if v.Name == sshAuthorizedKeysVolumeName {
						g.Expect(v.Secret).NotTo(BeNil())
						return v.Secret.SecretName
					}
				}
				g.Expect(false).To(BeTrue(), "the pod template mounts no %s volume", sshAuthorizedKeysVolumeName)
				return ""
			}

			var hashBefore string
			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(mountedSource(g, sts)).To(Equal(first.Name))
				hashBefore = sts.Annotations[stsSpecHashAnnotationKey]
			}, "15s", "200ms").Should(Succeed())

			fresh := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), fresh)).To(Succeed())
			fresh.Spec.SSH.AuthorizedKeysSecret.Name = second.Name
			Expect(k8sClient.Update(ctx, fresh)).To(Succeed())

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(mountedSource(g, sts)).To(Equal(second.Name))
				g.Expect(sts.Annotations[stsSpecHashAnnotationKey]).NotTo(Equal(hashBefore))
				// The bytes are identical either way: only the source moved, which
				// is why the revision alone could not have caught this.
				host := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
				g.Expect(sts.Spec.Template.Annotations[sshKeysRevisionAnnotationKey]).
					To(Equal(sshHostKeyDigest(host.Data[sshHostKeyKey])))
			}, "15s", "200ms").Should(Succeed())
		})

		It("replaces a host key sshd cannot read", func() {
			env := validDevEnvironment("de-hostkey-format")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var hashBefore string
			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), s)).To(Succeed())
				g.Expect(sshKeyPairMatches(s.Data[sshHostKeyKey], s.Data[sshHostPubKeyKey])).To(BeTrue())
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				hashBefore = sts.Annotations[stsSpecHashAnnotationKey]
			}, "15s", "200ms").Should(Succeed())

			// A Secret written by an older controller carries a key sshd rejects,
			// which would leave the environment with no ssh at all.
			stale := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), stale)).To(Succeed())
			stale.Data[sshHostKeyKey] = []byte(testPKCS8HostKey)
			Expect(k8sClient.Update(ctx, stale)).To(Succeed())

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), s)).To(Succeed())
				g.Expect(sshKeyPairMatches(s.Data[sshHostKeyKey], s.Data[sshHostPubKeyKey])).To(BeTrue())

				// Regenerating changes the mounted material, so the revision rolls
				// the workload onto the new key without a manual restart.
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Annotations[stsSpecHashAnnotationKey]).NotTo(Equal(hashBefore))
			}, "15s", "200ms").Should(Succeed())
		})

		It("repairs a managed Secret that has no data", func() {
			env := validDevEnvironment("de-ssh-secret-empty")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// A managed Secret can exist without carrying any data — created by hand
			// before the environment, or emptied by hand — and recovering the host
			// key then writes into an empty map rather than a missing one.
			emptied := &corev1.Secret{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), emptied)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())
			emptied.Data = nil
			Expect(k8sClient.Update(ctx, emptied)).To(Succeed())

			// The Secret is owned by the environment, so emptying it re-reconciles:
			// the repair has to come back with a readable host keypair. The host
			// Secret carries the identity and nothing else.
			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), s)).To(Succeed())
				g.Expect(s.Data).To(HaveKey(sshHostKeyKey))
				g.Expect(s.Data).To(HaveKey(sshHostPubKeyKey))
				g.Expect(sshKeyPairMatches(s.Data[sshHostKeyKey], s.Data[sshHostPubKeyKey])).To(BeTrue())
				g.Expect(s.Data).NotTo(HaveKey(sshAuthorizedKeysKey))
			}, "15s", "200ms").Should(Succeed())
		})

		It("repairs a generated authorized-keys Secret that has no data", func() {
			env := validDevEnvironment("de-ssh-authkeys-empty")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// The same guard, one Secret over. The recovery has to come back with a
			// readable login keypair — otherwise the private key its owner already
			// downloaded would stop logging in — and with that keypair alone.
			emptied := &corev1.Secret{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(sshClientKeySecretName(env)), emptied)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())
			emptied.Data = nil
			Expect(k8sClient.Update(ctx, emptied)).To(Succeed())

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshClientKeySecretName(env)), s)).To(Succeed())
				g.Expect(sshKeyPairMatches(s.Data[sshClientKeyKey], s.Data[sshClientPubKeyKey])).To(BeTrue())
				g.Expect(s.Data).NotTo(HaveKey(sshAuthorizedKeysKey))
			}, "15s", "200ms").Should(Succeed())
		})

		// An environment that predates the mount change carries a copy of the login
		// public key under authorized_keys. Nothing reads it any more, and leaving
		// it would show a second entry that looks like the one to edit.
		It("drops the stale authorized_keys copy from a generated keys Secret", func() {
			env := validDevEnvironment("de-ssh-authkeys-stale")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			keys := &corev1.Secret{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(sshClientKeySecretName(env)), keys)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			keys.Data[sshAuthorizedKeysKey] = append([]byte(nil), keys.Data[sshClientPubKeyKey]...)
			Expect(k8sClient.Update(ctx, keys)).To(Succeed())

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshClientKeySecretName(env)), s)).To(Succeed())
				g.Expect(s.Data).NotTo(HaveKey(sshAuthorizedKeysKey))
				g.Expect(sshKeyPairMatches(s.Data[sshClientKeyKey], s.Data[sshClientPubKeyKey])).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("rejects an undelegated keysSecret without reading it", func() {
			// A Secret without the delegation label must never back
			// authorized_keys: the workload mounts the referenced Secret straight
			// into the container, so an undelegated reference would let an
			// environment creator read any same-namespace Secret from inside it.
			leaked := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "dev-secret-undelegated", Namespace: testNamespace},
				Data:       map[string][]byte{testUserKeysKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, leaked)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, leaked) }()

			env := validDevEnvironment("de-undelegated")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: leaked.Name},
					Key:                  testUserKeysKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// The reconcile aborts on the undelegated Secret before recording the
			// SSH reference or creating either managed Secret, so the referenced
			// keys can never surface as authorized_keys.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.SSHClientKeySecret).To(BeNil())
				for _, name := range []string{sshHostKeySecretName(env), sshClientKeySecretName(env)} {
					s := &corev1.Secret{}
					g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(name), s))).To(BeTrue())
				}
			}, "15s", "200ms").Should(Succeed())
		})

		It("rejects a keysSecret that carries no such data key", func() {
			// The volume maps the selected entry onto the file sshd reads, and a data
			// key absent from a Secret leaves that file out of the mount rather than
			// failing it: the environment would come up serving nobody, with nothing
			// to report. Refusing it at reconcile time says which entry was missing.
			wrong := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "dev-alice-wrong-key",
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{"not-the-keys": []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, wrong)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, wrong) }()

			env := validDevEnvironment("de-missing-key")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: wrong.Name},
					Key:                  testUserKeysKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.SSHClientKeySecret).To(BeNil())
			}, "15s", "200ms").Should(Succeed())
		})

		It("refuses to reference another environment's generated keys", func() {
			// The generated Secrets are ordinary Secrets in the namespace, and what
			// stops one environment from mounting a peer's login key as its own
			// authorized_keys is only that the controller never labels them
			// delegated.
			peer := validDevEnvironment("de-ssh-peer")
			peer.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, peer)).To(Succeed())
			defer deleteEnv(peer.Name)

			generated := &corev1.Secret{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(sshClientKeySecretName(peer)), generated)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())
			Expect(generated.Labels).NotTo(HaveKey(devEnvSSHKeysDelegatedLabel))

			thief := validDevEnvironment("de-ssh-thief")
			thief.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			thief.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: sshClientKeySecretName(peer)},
					Key:                  sshClientKeyKey,
				},
			}
			Expect(k8sClient.Create(ctx, thief)).To(Succeed())
			defer deleteEnv(thief.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(thief.Name), got)).To(Succeed())
				g.Expect(got.Status.SSHClientKeySecret).To(BeNil())
			}, "15s", "200ms").Should(Succeed())
		})

		It("follows spec.ssh.authorizedKeysSecret as it is added and removed", func() {
			keys := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "dev-alice-switch-keys",
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{testUserKeysKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, keys)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, keys) }()

			env := validDevEnvironment("de-ssh-switch")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// refName is the Secret status records, or "" when it records none.
			refName := func(g Gomega) string {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				if got.Status.SSHClientKeySecret == nil {
					return ""
				}
				return got.Status.SSHClientKeySecret.Name
			}

			// Case 1 to start: no delegated keys, so the controller generates both.
			Eventually(func(g Gomega) {
				g.Expect(refName(g)).To(Equal(sshClientKeySecretName(env)))
			}, "15s", "200ms").Should(Succeed())

			// Add the reference: there is no longer a generated key, so status
			// records none. The mount still follows the spec; the name of the Secret
			// it takes is the one the user wrote.
			spec := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), spec)).To(Succeed())
			spec.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: keys.Name},
					Key:                  testUserKeysKey,
				},
			}
			Expect(k8sClient.Update(ctx, spec)).To(Succeed())
			Eventually(func(g Gomega) {
				g.Expect(refName(g)).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// Remove it again: the environment falls back to generated keys, and
			// because the generated Secret from before was left in place it is
			// reused — so a login key already downloaded keeps working.
			Expect(k8sClient.Get(ctx, envKey(env.Name), spec)).To(Succeed())
			spec.Spec.SSH.AuthorizedKeysSecret = nil
			Expect(k8sClient.Update(ctx, spec)).To(Succeed())
			Eventually(func(g Gomega) {
				g.Expect(refName(g)).To(Equal(sshClientKeySecretName(env)))
			}, "15s", "200ms").Should(Succeed())
		})

		// preSplitSecret is the bundled <env>-ssh-keys Secret the controller minted
		// before the split: the host keypair and authorized_keys in one Secret,
		// owned by env exactly as the controller's own Secrets are.
		preSplitSecret := func(env *aiv1alpha1.DevEnvironment, priv, pub []byte) *corev1.Secret {
			return &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      sshLegacySecretName(env),
					Namespace: testNamespace,
					OwnerReferences: []metav1.OwnerReference{{
						APIVersion: aiv1alpha1.GroupVersion.String(),
						Kind:       "DevEnvironment",
						Name:       env.Name,
						UID:        env.UID,
						Controller: ptrTo(true),
					}},
				},
				Data: map[string][]byte{
					sshHostKeyKey:        priv,
					sshHostPubKeyKey:     pub,
					sshAuthorizedKeysKey: []byte(testUserSSHKey),
				},
			}
		}

		// The split moves the host key into a Secret of its own, so an environment
		// created before it has to keep the identity its users have pinned rather
		// than being handed a new one.
		It("carries the host key forward from a pre-split bundled Secret", func() {
			env := validDevEnvironment("de-ssh-migrate")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			host := &corev1.Secret{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			legacyPriv, legacyPub, err := generateSSHKeyPair()
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Create(ctx, preSplitSecret(env, legacyPriv, legacyPub))).To(Succeed())

			// Losing the host-key Secret is the trigger: the next reconcile takes
			// the pair from the bundled Secret instead of minting a fresh one.
			Expect(k8sClient.Delete(ctx, host)).To(Succeed())

			Eventually(func(g Gomega) {
				restored := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), restored)).To(Succeed())
				g.Expect(restored.Data[sshHostKeyKey]).To(Equal(legacyPriv))
			}, "15s", "200ms").Should(Succeed())
		})

		It("refuses to adopt a legacy Secret it does not own", func() {
			env := validDevEnvironment("de-ssh-migrate-foreign")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			host := &corev1.Secret{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			// Same name, no owner: a foreign Secret must never donate a host
			// identity to an environment that merely shares its name.
			foreignPriv, foreignPub, err := generateSSHKeyPair()
			Expect(err).NotTo(HaveOccurred())
			foreign := preSplitSecret(env, foreignPriv, foreignPub)
			foreign.OwnerReferences = nil
			Expect(k8sClient.Create(ctx, foreign)).To(Succeed())

			Expect(k8sClient.Delete(ctx, host)).To(Succeed())

			Eventually(func(g Gomega) {
				restored := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), restored)).To(Succeed())
				g.Expect(sshKeyPairMatches(restored.Data[sshHostKeyKey], restored.Data[sshHostPubKeyKey])).To(BeTrue())
				g.Expect(restored.Data[sshHostKeyKey]).NotTo(Equal(foreignPriv))
			}, "15s", "200ms").Should(Succeed())
		})

		It("refuses to carry forward a legacy key sshd cannot read", func() {
			env := validDevEnvironment("de-ssh-migrate-pkcs8")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			host := &corev1.Secret{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), host)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			// An older controller minted PKCS#8; adopting it would only move the
			// problem into the new Secret, so the pair is minted fresh instead.
			Expect(k8sClient.Create(ctx, preSplitSecret(env, []byte(testPKCS8HostKey), []byte("ssh-ed25519 AAAA unused")))).To(Succeed())
			Expect(k8sClient.Delete(ctx, host)).To(Succeed())

			Eventually(func(g Gomega) {
				restored := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshHostKeySecretName(env)), restored)).To(Succeed())
				g.Expect(sshKeyPairMatches(restored.Data[sshHostKeyKey], restored.Data[sshHostPubKeyKey])).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("jupyter token", func() {
		It("creates the <env>-jupyter-token Secret and injects JUPYTER_TOKEN into the workload", func() {
			env := validDevEnvironment("de-token")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), s)).To(Succeed())
				g.Expect(string(s.Data[jupyterTokenKey])).To(HaveLen(32))
				g.Expect(metav1.GetControllerOf(s).UID).To(Equal(env.UID))
				g.Expect(s.Labels).To(HaveKeyWithValue(devEnvironmentLabelKey, env.Name))

				// status names that same Secret, so the token is retrievable from
				// the API instead of from a naming convention.
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.JupyterTokenSecret).To(Equal(&corev1.SecretReference{
					Name:      jupyterTokenSecretName(env),
					Namespace: testNamespace,
				}))

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				var injected *corev1.EnvVar
				for i := range sts.Spec.Template.Spec.Containers[0].Env {
					if sts.Spec.Template.Spec.Containers[0].Env[i].Name == jupyterTokenEnv {
						injected = &sts.Spec.Template.Spec.Containers[0].Env[i]
					}
				}
				g.Expect(injected).NotTo(BeNil())
				g.Expect(injected.ValueFrom).NotTo(BeNil())
				g.Expect(injected.ValueFrom.SecretKeyRef.Name).To(Equal(jupyterTokenSecretName(env)))
				g.Expect(injected.ValueFrom.SecretKeyRef.Key).To(Equal(jupyterTokenKey))
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps the token across reconciles and refills an emptied token key", func() {
			env := validDevEnvironment("de-token-stable")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var original string
			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), s)).To(Succeed())
				original = string(s.Data[jupyterTokenKey])
				g.Expect(original).To(HaveLen(32))
			}, "15s", "200ms").Should(Succeed())

			// Further reconciles (e.g. a stop/start) must not rotate the token:
			// the token is generated once and kept while non-empty.
			fresh := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), fresh)).To(Succeed())
			fresh.Spec.Running = false
			Expect(k8sClient.Update(ctx, fresh)).To(Succeed())
			Consistently(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), s)).To(Succeed())
				g.Expect(string(s.Data[jupyterTokenKey])).To(Equal(original))
			}, "2s", "200ms").Should(Succeed())

			// Capture the pod-template token revision and STS spec hash while the
			// original token is in effect, so a later refill can be proven to roll
			// the workload onto the new token.
			var hashBefore string
			Eventually(func(g Gomega) {
				gotSTS := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), gotSTS)).To(Succeed())
				// JUPYTER_TOKEN is read at container start, so the pod template
				// records a non-sensitive digest of the token in effect.
				g.Expect(gotSTS.Spec.Template.Annotations[jupyterTokenRevisionAnnotationKey]).To(Equal(jupyterTokenDigest(original)))
				hashBefore = gotSTS.Annotations[stsSpecHashAnnotationKey]
				g.Expect(hashBefore).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// An emptied key is refilled with a fresh token rather than left
			// empty, so the workload's JUPYTER_TOKEN env always resolves.
			s := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), s)).To(Succeed())
			s.Data[jupyterTokenKey] = []byte("")
			Expect(k8sClient.Update(ctx, s)).To(Succeed())

			Eventually(func(g Gomega) {
				freshSecret := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), freshSecret)).To(Succeed())
				val := string(freshSecret.Data[jupyterTokenKey])
				g.Expect(val).To(HaveLen(32))
				g.Expect(val).NotTo(Equal(original))
			}, "15s", "200ms").Should(Succeed())

			// The refill must roll the workload: the pod template's token revision
			// becomes the digest of the new token and the STS spec hash changes, so
			// applyStatefulSet updates the template and a StatefulSet controller
			// restarts the pod onto the refilled JUPYTER_TOKEN.
			Eventually(func(g Gomega) {
				gotSTS := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), gotSTS)).To(Succeed())
				freshSecret := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), freshSecret)).To(Succeed())
				g.Expect(gotSTS.Spec.Template.Annotations[jupyterTokenRevisionAnnotationKey]).To(Equal(jupyterTokenDigest(string(freshSecret.Data[jupyterTokenKey]))))
				g.Expect(gotSTS.Annotations[stsSpecHashAnnotationKey]).NotTo(Equal(hashBefore))
			}, "15s", "200ms").Should(Succeed())
		})

		It("does not create the token Secret or env for non-jupyter environments", func() {
			env := validDevEnvironment("de-token-ssh")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				for _, c := range sts.Spec.Template.Spec.Containers {
					for _, v := range c.Env {
						g.Expect(v.Name).NotTo(Equal(jupyterTokenEnv))
					}
				}
				err := k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), &corev1.Secret{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())

				// The status field is jupyter-only and stays unset here, rather
				// than naming a Secret that was never created. The StatefulSet
				// above proves the reconcile got past the branch that would set it.
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.JupyterTokenSecret).To(BeNil())
			}, "15s", "200ms").Should(Succeed())
		})

		It("removes the token Secret when the environment is deleted", func() {
			env := validDevEnvironment("de-token-del")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), s)).To(Succeed())
				g.Expect(s.Data[jupyterTokenKey]).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				err = k8sClient.Get(ctx, envKey(jupyterTokenSecretName(env)), &corev1.Secret{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("retention", func() {
		// The workspace PVC's lifecycle belongs to the StatefulSet, so what the
		// controller owes the user is the retention policy it renders — the claim
		// dies with the StatefulSet when whenDeleted=Delete — plus, on the retain
		// side, a claim the StatefulSet deletion cannot garbage-collect. envtest
		// runs no StatefulSet controller: no claim is ever provisioned and none is
		// ever collected, so these tests fabricate the claim, and the owner
		// reference a delete policy would have put on it, to observe what the
		// controller does to that reference.
		It("delegates pvcRetention=delete to the StatefulSet", func() {
			env := validDevEnvironment("de-retention-delete")
			env.Spec.Storage.PVCRetention = aiv1alpha1.PVCRetentionDelete
			Expect(k8sClient.Create(ctx, env)).To(Succeed())

			sts := &appsv1.StatefulSet{}
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Finalizers).To(ContainElement(devEnvFinalizer))
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted).To(Equal(appsv1.DeletePersistentVolumeClaimRetentionPolicyType))
				// Stopping scales the workload to zero and must never discard the
				// workspace, so whenScaled is Retain whatever pvcRetention says.
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled).To(Equal(appsv1.RetainPersistentVolumeClaimRetentionPolicyType))
			}, "15s", "200ms").Should(Succeed())

			claim := createWorkspaceClaim(env, sts)
			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			// Deleting the StatefulSet is the whole cleanup mechanism for the claim,
			// so the StatefulSet must actually be gone.
			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				err = k8sClient.Get(ctx, envKey(env.Name), &appsv1.StatefulSet{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// ...and the claim must still be its dependent: the reference is what
			// reclaims it with the environment, and dropping it here would leak the
			// workspace of every environment deleted under the default policy.
			got := &corev1.PersistentVolumeClaim{}
			Expect(k8sClient.Get(ctx, envKey(claim.Name), got)).To(Succeed())
			owner := metav1.GetControllerOf(got)
			Expect(owner).NotTo(BeNil())
			Expect(owner.UID).To(Equal(sts.UID))
		})

		// A deletion can land before a pvcRetention change has been reconciled onto
		// the StatefulSet: cleanup runs off the deletion timestamp and never reaches
		// applyStatefulSet, so the set can still carry the delete policy that makes
		// its claims garbage-collectable. The retain the user asked for arrives with
		// the very delete that triggers this, so it has to survive that ordering —
		// waiting for the StatefulSet controller to detach the claim instead would
		// deadlock, because a set stopped before the policy changed (no pod) is
		// never revisited by it.
		It("detaches the workspace claim when deleting a retained environment", func() {
			env := validDevEnvironment("de-retain-detach")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			sts := &appsv1.StatefulSet{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			claim := createWorkspaceClaim(env, sts)
			// The unconverged policy: what the environment carried before pvcRetention
			// was set to retain, and what leaves the claim garbage-collectable.
			sts.Spec.PersistentVolumeClaimRetentionPolicy = &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				WhenDeleted: appsv1.DeletePersistentVolumeClaimRetentionPolicyType,
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			}
			Expect(k8sClient.Update(ctx, sts)).To(Succeed())

			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				err = k8sClient.Get(ctx, envKey(env.Name), &appsv1.StatefulSet{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// The claim outlives the environment, and nothing points at the deleted
			// set any more: the workspace survives the retain the user asked for.
			got := &corev1.PersistentVolumeClaim{}
			Expect(k8sClient.Get(ctx, envKey(claim.Name), got)).To(Succeed())
			Expect(got.OwnerReferences).To(BeEmpty())
		})

		// The delegated field is only a delegation if it is kept converged. A
		// StatefulSet stored by an earlier controller carries a hardcoded Retain
		// while hashing identically (the hash covers spec.storage, which already
		// implies the policy), so without an explicit comparison it would never be
		// corrected and the claim would outlive a pvcRetention=delete environment.
		It("corrects a StatefulSet whose retention policy drifted", func() {
			env := validDevEnvironment("de-retention-drift")
			env.Spec.Storage.PVCRetention = aiv1alpha1.PVCRetentionDelete
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			sts := &appsv1.StatefulSet{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted).To(Equal(appsv1.DeletePersistentVolumeClaimRetentionPolicyType))
			}, "15s", "200ms").Should(Succeed())

			// Simulate the pre-delegation form: the policy the old controller wrote.
			sts.Spec.PersistentVolumeClaimRetentionPolicy = &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				WhenDeleted: appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			}
			Expect(k8sClient.Update(ctx, sts)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted).To(Equal(appsv1.DeletePersistentVolumeClaimRetentionPolicyType))
			}, "15s", "200ms").Should(Succeed())
		})

		// The portal sends no pvcRetention at all, so the schema default is the
		// policy every console-created environment actually gets — this is the
		// path that decides whether a user's workspace survives the delete button.
		It("defaults an omitted pvcRetention to delete", func() {
			env := validDevEnvironment("de-retention-default")
			env.Spec.Storage.PVCRetention = ""
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted).To(Equal(appsv1.DeletePersistentVolumeClaimRetentionPolicyType))
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled).To(Equal(appsv1.RetainPersistentVolumeClaimRetentionPolicyType))
			}, "15s", "200ms").Should(Succeed())
		})

		It("does not delete foreign resources that share the environment's name or labels", func() {
			// Foreign resources occupy the environment's name and labels before
			// the controller provisions anything; none carry an ownerRef to the
			// environment.
			envName := "de-foreign"
			foreignSvc := &corev1.Service{
				ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace},
				Spec:       corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 8080}}},
			}
			Expect(k8sClient.Create(ctx, foreignSvc)).To(Succeed())
			foreignHTTP := &gatewayv1.HTTPRoute{
				ObjectMeta: metav1.ObjectMeta{Name: "de-foreign-web", Namespace: testNamespace, Labels: map[string]string{devEnvironmentLabelKey: envName}},
				Spec: gatewayv1.HTTPRouteSpec{
					CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{
						{Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)), Kind: ptrTo(gatewayv1.Kind(gatewayKind)), Namespace: ptrTo(gatewayv1.Namespace(testNamespace)), Name: gatewayv1.ObjectName(testDevEnvGatewayName)},
					}},
					Rules: []gatewayv1.HTTPRouteRule{{BackendRefs: []gatewayv1.HTTPBackendRef{{BackendRef: gatewayv1.BackendRef{
						BackendObjectReference: gatewayv1.BackendObjectReference{Name: gatewayv1.ObjectName("some-svc"), Port: ptrTo(gatewayv1.PortNumber(8080))},
					}}}}},
				},
			}
			Expect(k8sClient.Create(ctx, foreignHTTP)).To(Succeed())
			foreignTCP := &gatewayv1.TCPRoute{
				ObjectMeta: metav1.ObjectMeta{Name: "de-foreign-tcp-9999", Namespace: testNamespace, Labels: map[string]string{devEnvironmentLabelKey: envName}},
				Spec: gatewayv1.TCPRouteSpec{
					CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{
						{Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)), Kind: ptrTo(gatewayv1.Kind(gatewayKind)), Namespace: ptrTo(gatewayv1.Namespace(testNamespace)), Name: gatewayv1.ObjectName(testDevEnvGatewayName)},
					}},
					Rules: []gatewayv1.TCPRouteRule{{BackendRefs: []gatewayv1.BackendRef{{
						BackendObjectReference: gatewayv1.BackendObjectReference{Name: gatewayv1.ObjectName("some-svc"), Port: ptrTo(gatewayv1.PortNumber(8080))},
					}}}},
				},
			}
			Expect(k8sClient.Create(ctx, foreignTCP)).To(Succeed())
			defer func() {
				_ = k8sClient.Delete(ctx, foreignSvc)
				_ = k8sClient.Delete(ctx, foreignHTTP)
				_ = k8sClient.Delete(ctx, foreignTCP)
			}()

			// The controller must not adopt the foreign Service: applying its
			// own Service conflicts, so the environment never provisions.
			env := validDevEnvironment(envName)
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Finalizers).To(ContainElement(devEnvFinalizer))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// Cleanup deleted nothing it did not own: all three foreign
			// resources survive.
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(foreignSvc), foreignSvc)).To(Succeed())
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(foreignHTTP), foreignHTTP)).To(Succeed())
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(foreignTCP), foreignTCP)).To(Succeed())
		})
	})

	Context("legacy StatefulSet with an RWO workspace claim", func() {
		// A DevEnvironment whose StatefulSet was created before the platform
		// pinned the workspace claim (ReadWriteOnce, no StorageClassName) must
		// stay updatable after an operator upgrade: spec.volumeClaimTemplates is
		// immutable, so the controller preserves the stored claim and applies
		// pod-template/replica changes around it instead of wedging the
		// environment on an immutability error (design §7.2).
		It("keeps the existing claim template and updates the pod template", func() {
			const mismatchedImage = "harbor.local/ai-images/base-maca:1.0"

			env := validDevEnvironment("de-legacy-claim")
			// Seed the environment brand-mismatched so the live reconciler does
			// not race this spec into creating its own StatefulSet: while the
			// brand gate fails, nothing is provisioned, so the legacy StatefulSet
			// seeded below is left in place.
			env.Spec.Image = mismatchedImage
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			legacySTS := &appsv1.StatefulSet{
				ObjectMeta: metav1.ObjectMeta{
					Name:      env.Name,
					Namespace: env.Namespace,
					Labels:    map[string]string{devEnvironmentLabelKey: env.Name},
					Annotations: map[string]string{
						stsSpecHashAnnotationKey: (&DevEnvironmentReconciler{}).stsSpecHash(env),
					},
				},
				Spec: appsv1.StatefulSetSpec{
					Replicas:    ptrTo(int32(0)),
					ServiceName: env.Name,
					Selector:    &metav1.LabelSelector{MatchLabels: map[string]string{devEnvironmentLabelKey: env.Name}},
					Template: corev1.PodTemplateSpec{
						ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{devEnvironmentLabelKey: env.Name}},
						Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: testJupyterName, Image: mismatchedImage}}},
					},
					VolumeClaimTemplates: []corev1.PersistentVolumeClaim{{
						ObjectMeta: metav1.ObjectMeta{Name: workspaceClaimName},
						Spec: corev1.PersistentVolumeClaimSpec{
							AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
							Resources: corev1.VolumeResourceRequirements{
								Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(env.Spec.Storage.Size)},
							},
						},
					}},
				},
			}
			Expect(controllerutil.SetControllerReference(env, legacySTS, k8sClient.Scheme())).To(Succeed())
			Expect(k8sClient.Create(ctx, legacySTS)).To(Succeed())

			// The first post-upgrade drift (a real spec edit) must reconcile:
			// repair the image and scale back up without touching the immutable
			// claim template. The controller writes status for this mismatched
			// environment concurrently, so retry the edit on the 409 conflict it
			// can otherwise cause (re-fetching each attempt, as in convergence
			// specs).
			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Image = testDevImage
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "10s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(1))))
				g.Expect(sts.Spec.Template.Spec.Containers[0].Image).To(Equal(testDevImage))
				// The immutable claim template is preserved as originally created.
				g.Expect(sts.Spec.VolumeClaimTemplates).To(HaveLen(1))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.AccessModes).To(ContainElement(corev1.ReadWriteOnce))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName).To(BeNil())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("gateway routes", func() {
		It("publishes HTTPRoute and TCPRoutes and builds endpoints", func() {
			createGateway(true)
			defer deleteGateway()

			keys := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "de-routes-keys",
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{testUserKeysKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, keys)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, keys) }()

			env := validDevEnvironment("de-routes")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: keys.Name},
					Key:                  testUserKeysKey,
				},
			}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testMetricsPortName, Type: aiv1alpha1.PortTypeHTTP, ContainerPort: 9090},
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var pSSH, pGRPC int32
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				pSSH = sshEndpointPort(got.Status.Endpoints)
				pGRPC = 0
				for _, ep := range got.Status.Endpoints {
					if ep.Name == testGRPCPortName {
						pGRPC = ep.ListenerPort
					}
				}
				g.Expect(pSSH).To(BeNumerically(">", 0))
				g.Expect(pGRPC).To(BeNumerically(">", 0))
				g.Expect(pSSH).NotTo(Equal(pGRPC))
			}, "15s", "200ms").Should(Succeed())

			route := &gatewayv1.HTTPRoute{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: env.Name + "-web", Namespace: env.Namespace}, route)).To(Succeed())
				g.Expect(route.Spec.ParentRefs).To(HaveLen(1))
				g.Expect(string(route.Spec.ParentRefs[0].Name)).To(Equal(testDevEnvGatewayName))
				g.Expect(route.Spec.Rules).To(HaveLen(2))
				g.Expect(route.Spec.Rules[0].Matches).To(HaveLen(1))
				g.Expect(route.Spec.Rules[0].Matches[0].Path.Value).To(Equal(ptrTo(webRootPath + env.Name + "/")))
				g.Expect(route.Spec.Rules[0].BackendRefs).To(HaveLen(1))
				g.Expect(route.Spec.Rules[0].BackendRefs[0].Port).To(Equal(ptrTo(gatewayv1.PortNumber(8888))))
				g.Expect(route.Spec.Rules[1].Matches[0].Path.Value).To(Equal(ptrTo(webRootPath + env.Name + "/port/metrics/")))
				g.Expect(route.Spec.Rules[1].BackendRefs[0].Port).To(Equal(ptrTo(gatewayv1.PortNumber(9090))))
			}, "15s", "200ms").Should(Succeed())

			// One TCPRoute per allocated port: one behind <endpoint>-tcp-<port>
			// with backend port 22 for ssh, one for the grpc extra port with its
			// container port. Each attaches to the matching listener of the
			// environment's own ListenerSet, not to the shared Gateway.
			for _, tc := range []struct {
				endpointName string
				port         int32
				backendPort  int32
			}{
				{endpointName: sshPortName, port: pSSH, backendPort: 22},
				{endpointName: testGRPCPortName, port: pGRPC, backendPort: 50051},
			} {
				tr := &gatewayv1.TCPRoute{}
				Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env.Name, tc.port), Namespace: env.Namespace}, tr)).To(Succeed())
				Expect(tr.Spec.ParentRefs).To(HaveLen(1))
				Expect(tr.Spec.ParentRefs[0].Name).To(Equal(gatewayv1.ObjectName(listenerSetName(env))))
				Expect(tr.Spec.ParentRefs[0].Kind).To(Equal(ptrTo(gatewayv1.Kind(listenerSetKind))))
				Expect(tr.Spec.ParentRefs[0].SectionName).To(Equal(ptrTo(gatewayv1.SectionName(fmt.Sprintf("%s-tcp-%d", tc.endpointName, tc.port)))))
				Expect(tr.Spec.Rules[0].BackendRefs).To(HaveLen(1))
				Expect(tr.Spec.Rules[0].BackendRefs[0].Port).To(Equal(ptrTo(tc.backendPort)))
			}

			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			Expect(got.Status.Endpoints).To(ContainElements(
				aiv1alpha1.Endpoint{Name: testJupyterName, Address: "http://" + testGatewayIP + ":80" + webRootPath + env.Name + "/", ListenerPort: 80},
				aiv1alpha1.Endpoint{Name: "ssh", Address: fmt.Sprintf("ssh://%s@%s:%d", defaultRuntimeUser, testGatewayIP, pSSH), ListenerPort: pSSH},
				aiv1alpha1.Endpoint{Name: testMetricsPortName, Address: "http://" + testGatewayIP + ":80" + webRootPath + env.Name + "/port/metrics/", ListenerPort: 80},
				aiv1alpha1.Endpoint{Name: testGRPCPortName, Address: fmt.Sprintf("%s:%d", testGatewayIP, pGRPC), ListenerPort: pGRPC},
			))
		})

		It("declares its L4 listeners in a ListenerSet it owns", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-l4-set")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				// The listeners are declared first and the routes attach to them,
				// so both ports are known from the routes' names before anything
				// is accepted.
				ports := devEnvTCPRoutePorts(g, env.Name)
				g.Expect(ports).To(HaveLen(2))

				ls := &gatewayv1.ListenerSet{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, ls)).To(Succeed())
				g.Expect(ls.Spec.ParentRef.Name).To(Equal(gatewayv1.ObjectName(testDevEnvGatewayName)))
				g.Expect(ls.Spec.ParentRef.Kind).To(Equal(ptrTo(gatewayv1.Kind(gatewayKind))))
				g.Expect(ls.Labels).To(HaveKeyWithValue(devEnvironmentLabelKey, env.Name))

				// Owned by the environment: the ListenerSet holds its ports, so it
				// must not outlive it.
				owner := metav1.GetControllerOf(ls)
				g.Expect(owner).NotTo(BeNil())
				g.Expect(owner.UID).To(Equal(env.UID))

				declared := make([]int32, 0, len(ls.Spec.Listeners))
				for _, l := range ls.Spec.Listeners {
					g.Expect(l.Protocol).To(Equal(gatewayv1.TCPProtocolType))
					g.Expect(l.AllowedRoutes.Kinds).To(HaveLen(1))
					g.Expect(l.AllowedRoutes.Kinds[0].Kind).To(Equal(gatewayv1.Kind(tcpRouteKind)))
					declared = append(declared, l.Port)
				}
				slices.Sort(declared)
				slices.Sort(ports)
				g.Expect(declared).To(Equal(ports))
			}, "15s", "200ms").Should(Succeed())
		})

		It("publishes a udp port as a UDP listener and a UDPRoute", func() {
			// UDP is published exactly as TCP is, through its own kind: a
			// UDPRoute on a listener of the environment's ListenerSet. Nothing
			// about the exposure may quietly stay TCP — the listener protocol,
			// the route kind, the Service port the route forwards to and the
			// address — or the port would be accepted and forward nothing.
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-udp")
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testSyslogPortName, Type: aiv1alpha1.PortTypeUDP, ContainerPort: 514},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var pUDP int32
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				pUDP = devEnvEndpointPort(got.Status.Endpoints, testSyslogPortName)
				g.Expect(pUDP).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())

			// The Service port has to speak UDP: a TCP entry would be accepted
			// and forward no datagram.
			svc := &corev1.Service{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: env.Name, Namespace: env.Namespace}, svc)).To(Succeed())
			var syslogPort *corev1.ServicePort
			for i := range svc.Spec.Ports {
				if svc.Spec.Ports[i].Name == testSyslogPortName {
					syslogPort = &svc.Spec.Ports[i]
				}
			}
			Expect(syslogPort).NotTo(BeNil())
			Expect(syslogPort.Protocol).To(Equal(corev1.ProtocolUDP))
			Expect(syslogPort.Port).To(Equal(int32(514)))

			ls := &gatewayv1.ListenerSet{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, ls)).To(Succeed())
			Expect(ls.Spec.Listeners).To(HaveLen(1))
			Expect(ls.Spec.Listeners[0].Name).To(Equal(gatewayv1.SectionName(fmt.Sprintf("%s-udp-%d", testSyslogPortName, pUDP))))
			Expect(ls.Spec.Listeners[0].Protocol).To(Equal(gatewayv1.UDPProtocolType))
			Expect(ls.Spec.Listeners[0].Port).To(Equal(pUDP))
			Expect(ls.Spec.Listeners[0].AllowedRoutes.Kinds).To(Equal([]gatewayv1.RouteGroupKind{{
				Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)),
				Kind:  gatewayv1.Kind(udpRouteKind),
			}}))

			ur := &gatewayv1.UDPRoute{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-udp-%d", env.Name, pUDP), Namespace: env.Namespace}, ur)).To(Succeed())
			Expect(ur.Spec.ParentRefs).To(HaveLen(1))
			Expect(ur.Spec.ParentRefs[0].Name).To(Equal(gatewayv1.ObjectName(listenerSetName(env))))
			Expect(ur.Spec.ParentRefs[0].Kind).To(Equal(ptrTo(gatewayv1.Kind(listenerSetKind))))
			Expect(ur.Spec.ParentRefs[0].SectionName).To(Equal(ptrTo(gatewayv1.SectionName(fmt.Sprintf("%s-udp-%d", testSyslogPortName, pUDP)))))
			Expect(ur.Spec.Rules[0].BackendRefs[0].Port).To(Equal(ptrTo(gatewayv1.PortNumber(514))))
			owner := metav1.GetControllerOf(ur)
			Expect(owner).NotTo(BeNil())
			Expect(owner.UID).To(Equal(env.UID))

			// The address is a bare host:port like a tcp one, and it names the
			// listener port — no dataplane Service is published in this suite, so
			// the listener port is the reachable one.
			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			Expect(devEnvEndpointPort(got.Status.Endpoints, testSyslogPortName)).To(Equal(pUDP))
			for _, ep := range got.Status.Endpoints {
				if ep.Name == testSyslogPortName {
					Expect(ep.Address).To(Equal(fmt.Sprintf("%s:%d", testGatewayIP, pUDP)))
				}
			}
			// The web endpoint beside it is untouched: an L4 udp port does not
			// take the environment off the HTTP listener.
			Expect(got.Status.Endpoints).To(ContainElement(
				aiv1alpha1.Endpoint{Name: testJupyterName, Address: "http://" + testGatewayIP + ":80" + webRootPath + env.Name + "/", ListenerPort: 80}))
		})

		// An exposure repeating a port the Service already publishes is a spec the
		// controller resolves rather than refuses (::desiredService). It used to be
		// the API server that refused it: the duplicate ServicePort failed the
		// Service write, and because applyService errors before the status write the
		// environment was left with no Service, no pod and no status at all. So this
		// asserts both halves — the write is accepted, and the environment has a
		// status at all — plus that the exposure's own route survives the folding,
		// which is what makes resolving it rather than refusing it the honest call.
		It("settles an exposure that repeats the Service's own port", func() {
			createGateway(true)
			defer deleteGateway()

			const repeatName = "notebook-again"
			notebookPort := mainContainerPort(aiv1alpha1.DevEnvironmentTypeJupyter)

			env := validDevEnvironment("de-svc-repeat")
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: repeatName, Type: aiv1alpha1.PortTypeHTTP, ContainerPort: notebookPort},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// The Service carries the notebook's port once: the repeat is folded
			// into the platform's own entry rather than written beside it.
			Eventually(func(g Gomega) {
				svc := &corev1.Service{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: env.Name, Namespace: env.Namespace}, svc)).To(Succeed())
				g.Expect(svc.Spec.Ports).To(HaveLen(1))
				g.Expect(svc.Spec.Ports[0].Name).To(Equal(mainPortName))
				g.Expect(svc.Spec.Ports[0].Port).To(Equal(notebookPort))
			}, "15s", "200ms").Should(Succeed())

			// The reconcile got past the Service, which is what the duplicate
			// ServicePort used to take away: a status at all, written for the
			// generation that is current.
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).NotTo(BeEmpty())
				g.Expect(got.Status.ObservedGeneration).To(Equal(got.Generation))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				// And the fold is stated rather than passed over: this one is
				// lossless, so the environment runs and Accepted reports it.
				accepted := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(accepted).NotTo(BeNil())
				g.Expect(accepted.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(accepted.Reason).To(Equal(reasonOverridden))
				g.Expect(accepted.Message).To(ContainSubstring("spec.ports[0]: ignored"))
			}, "15s", "200ms").Should(Succeed())

			// Nothing was taken from the user: the repeat's exposure is still
			// published on its own path, reaching the Service by number — which is
			// why the name it was declared under can go unused.
			route := &gatewayv1.HTTPRoute{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: webRouteName(env), Namespace: env.Namespace}, route)).To(Succeed())
			repeatPath := fmt.Sprintf("/dev/%s/%s/port/%s/", env.Namespace, env.Name, repeatName)
			var matched bool
			for _, rule := range route.Spec.Rules {
				if len(rule.Matches) == 0 || rule.Matches[0].Path == nil || rule.Matches[0].Path.Value == nil {
					continue
				}
				if *rule.Matches[0].Path.Value != repeatPath {
					continue
				}
				matched = true
				Expect(rule.BackendRefs).To(HaveLen(1))
				Expect(rule.BackendRefs[0].Name).To(Equal(gatewayv1.ObjectName(env.Name)))
				Expect(rule.BackendRefs[0].Port).To(Equal(ptrTo(notebookPort)))
			}
			Expect(matched).To(BeTrue(), "the repeat's exposure lost its route")
		})

		// The fold that is not lossless, driven through the API server: the ssh
		// bridge publishes 22 and forwards to the sshd on 2222, so an exposure
		// declaring container port 22 would reach sshd rather than the workload it
		// named. Resolving that is not the controller's to do — no port carries what
		// the user asked for — so the environment fails with the entry named, which
		// is the only place the finding is reported.
		It("fails an exposure the Service's own entry would answer for", func() {
			env := validDevEnvironment("de-svc-collide")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testCollidingPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: sshServicePort},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got.Status.Phase.Reason).To(Equal(reasonPortCollision))
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionAccepted)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
				accepted := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(accepted).NotTo(BeNil())
				g.Expect(accepted.Reason).To(Equal(reasonPortCollision))
				g.Expect(accepted.Message).To(ContainSubstring("spec.ports[0]: must be updated"))
				g.Expect(accepted.Message).To(ContainSubstring(fmt.Sprintf("container port %d", sshContainerPort)))
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(env.Name), sts))).To(BeTrue())
		})

		It("holds a udp port and a tcp port on different numbers", func() {
			// tcp and udp share one pool (design §8.3): a udp port takes its
			// number out of the same range and never shares it with a tcp one,
			// so the two exposures of one environment are on different numbers.
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-udp-tcp")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
				{Name: testSyslogPortName, Type: aiv1alpha1.PortTypeUDP, ContainerPort: 514},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				pSSH := sshEndpointPort(got.Status.Endpoints)
				pTCP := devEnvEndpointPort(got.Status.Endpoints, testGRPCPortName)
				pUDP := devEnvEndpointPort(got.Status.Endpoints, testSyslogPortName)
				g.Expect(pSSH).To(BeNumerically(">", 0))
				g.Expect(pTCP).To(BeNumerically(">", 0))
				g.Expect(pUDP).To(BeNumerically(">", 0))
				g.Expect([]int32{pSSH, pTCP}).NotTo(ContainElement(pUDP))
			}, "15s", "200ms").Should(Succeed())

			// The two routes are separate objects under separate names, so each
			// exposes the port it holds.
			urs := &gatewayv1.UDPRouteList{}
			Expect(k8sClient.List(ctx, urs, client.InNamespace(env.Namespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name})).To(Succeed())
			Expect(urs.Items).To(HaveLen(1))
			Expect(udpRoutePort(urs.Items[0].Name)).To(BeNumerically(">", 0))

			trs := &gatewayv1.TCPRouteList{}
			Expect(k8sClient.List(ctx, trs, client.InNamespace(env.Namespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name})).To(Succeed())
			Expect(trs.Items).To(HaveLen(2))
		})

		It("prunes the UDPRoute and frees its listener port", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-udp-prune")
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testSyslogPortName, Type: aiv1alpha1.PortTypeUDP, ContainerPort: 514},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var pUDP int32
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				pUDP = devEnvEndpointPort(got.Status.Endpoints, testSyslogPortName)
				g.Expect(pUDP).To(BeNumerically(">", 0))

				// There is a udp route and listener to remove in the first place:
				// without this the spec would pass on an environment that never
				// published one, and prove nothing about pruning it.
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-udp-%d", env.Name, pUDP), Namespace: env.Namespace}, &gatewayv1.UDPRoute{})).To(Succeed())
				ls := &gatewayv1.ListenerSet{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, ls)).To(Succeed())
				g.Expect(ls.Spec.Listeners[0].Protocol).To(Equal(gatewayv1.UDPProtocolType))
			}, "15s", "200ms").Should(Succeed())

			// The exposure goes: its route and its listener go with it, or the
			// port stays claimed by a declaration the environment no longer makes.
			updateEnvSpec(env.Name, func(env *aiv1alpha1.DevEnvironment) { env.Spec.Ports = nil })

			Eventually(func(g Gomega) {
				ur := &gatewayv1.UDPRoute{}
				err := k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-udp-%d", env.Name, pUDP), Namespace: env.Namespace}, ur)
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())

				err = k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, &gatewayv1.ListenerSet{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("withholds the endpoints when the Gateway refuses the ListenerSet", func() {
			// The design's documented prerequisite: a Gateway that has not opted
			// the namespace into allowedListeners refuses the ListenerSet, and the
			// routes attached to its listeners are never reported on at all. The
			// refusal has to surface as its own reason, or the missing
			// allowedListeners reads as routes that never converge.
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-l4-refused")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				// The routes themselves are accepted: only the ListenerSet is
				// refused, so nothing else explains the withheld endpoints.
				stampDevEnvRouteParents(g, env.Name, true, "", "")
				stampDevEnvListenerSet(g, env.Name, false, string(gatewayv1.ListenerSetReasonNotAllowed),
					"namespace default is not allowed to attach to gateway "+testDevEnvGatewayName)

				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonListenerNotAccepted))
				g.Expect(cond.Message).To(ContainSubstring("NotAllowed"))
				g.Expect(cond.Message).To(ContainSubstring("not allowed to attach"))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// Admitting it lets the routes' own verdict take over again.
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				g.Expect(sshEndpointPort(got.Status.Endpoints)).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())
		})

		It("deletes the ListenerSet when the environment loses its last L4 port", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-l4-empty")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			ls := &gatewayv1.ListenerSet{}
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, ls)).To(Succeed())
				g.Expect(ls.Spec.Listeners).To(HaveLen(1))
			}, "15s", "200ms").Should(Succeed())

			// Leaving a listener behind would keep claiming its port, and Gateway
			// API would keep preferring it as the older declaration.
			updateEnvSpec(env.Name, func(env *aiv1alpha1.DevEnvironment) { env.Spec.SSH = nil })

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, &gatewayv1.ListenerSet{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps the SSH port stable and allocates distinct ports", func() {
			createGateway(true)
			defer deleteGateway()

			env1 := validDevEnvironment("de-port-a")
			env1.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env1)).To(Succeed())
			defer deleteEnv(env1.Name)

			var p1 int32
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env1.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env1.Name), got)).To(Succeed())
				p1 = sshEndpointPort(got.Status.Endpoints)
				g.Expect(p1).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())

			env2 := validDevEnvironment("de-port-b")
			env2.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env2)).To(Succeed())
			defer deleteEnv(env2.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env2.Name, true, "", "")
				stampDevEnvRoutes(g, env1.Name, true, "", "")
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env2.Name), got2)).To(Succeed())
				p2 := sshEndpointPort(got2.Status.Endpoints)
				g.Expect(p2).To(BeNumerically(">", 0))
				g.Expect(p2).NotTo(Equal(p1))

				// The enqueue-all watch re-reconciles env1; its recorded port stays
				// stable because it is still free.
				got1 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env1.Name), got1)).To(Succeed())
				g.Expect(sshEndpointPort(got1.Status.Endpoints)).To(Equal(p1))
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps unaccepted environments off each other's listener port", func() {
			createGateway(true)
			defer deleteGateway()

			// Neither environment's route is accepted, so both withhold their
			// status.endpoints. The pool has to come from the objects that declare
			// the listeners — the ListenerSet, and for a peer whose route is still
			// attached straight to the Gateway, the route: read from the endpoints
			// instead and the second environment sees nothing reserved and takes
			// the first one's listener port.
			env1 := validDevEnvironment("de-port-unaccepted-a")
			env1.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env1)).To(Succeed())
			defer deleteEnv(env1.Name)

			var first int32
			Eventually(func(g Gomega) {
				ports := devEnvTCPRoutePorts(g, env1.Name)
				g.Expect(ports).To(HaveLen(1))
				first = ports[0]
			}, "15s", "200ms").Should(Succeed())

			env2 := validDevEnvironment("de-port-unaccepted-b")
			env2.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env2)).To(Succeed())
			defer deleteEnv(env2.Name)

			Eventually(func(g Gomega) {
				ports := devEnvTCPRoutePorts(g, env2.Name)
				g.Expect(ports).To(HaveLen(1))
				g.Expect(ports[0]).NotTo(Equal(first))
			}, "15s", "200ms").Should(Succeed())
		})

		It("ignores listener ports held by objects on another gateway", func() {
			createGateway(true)
			defer deleteGateway()

			// Start from an empty pool: earlier specs release their environments
			// and routes asynchronously via the finalizer.
			Eventually(func(g Gomega) {
				envs := &aiv1alpha1.DevEnvironmentList{}
				g.Expect(k8sClient.List(ctx, envs)).To(Succeed())
				g.Expect(envs.Items).To(BeEmpty())
				routes := &gatewayv1.TCPRouteList{}
				g.Expect(k8sClient.List(ctx, routes, client.InNamespace(testNamespace))).To(Succeed())
				g.Expect(routes.Items).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// A route parented to someone else's Gateway holds the lowest port in
			// the range. It has no listener on this Gateway, so it must not
			// reserve that port — the pool is this Gateway's listeners.
			foreign := &gatewayv1.TCPRoute{
				ObjectMeta: metav1.ObjectMeta{
					Name:      fmt.Sprintf("foreign-tcp-%d", testL4PortRangeStart),
					Namespace: testNamespace,
				},
				Spec: gatewayv1.TCPRouteSpec{
					CommonRouteSpec: gatewayv1.CommonRouteSpec{
						ParentRefs: []gatewayv1.ParentReference{{
							Name:      gatewayv1.ObjectName("other-gw"),
							Namespace: ptrTo(gatewayv1.Namespace(testNamespace)),
						}},
					},
					Rules: []gatewayv1.TCPRouteRule{{
						BackendRefs: []gatewayv1.BackendRef{{
							BackendObjectReference: gatewayv1.BackendObjectReference{
								Name: "foreign-backend",
								Port: ptrTo(int32(80)),
							},
						}},
					}},
				},
			}
			Expect(k8sClient.Create(ctx, foreign)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, foreign) }()

			// Same for a ListenerSet: its listeners belong to the Gateway it names,
			// and one naming another Gateway holds no listener here.
			foreignSet := &gatewayv1.ListenerSet{
				ObjectMeta: metav1.ObjectMeta{
					Name:      fmt.Sprintf("foreign-l4-%d", testL4PortRangeStart+1),
					Namespace: testNamespace,
				},
				Spec: gatewayv1.ListenerSetSpec{
					ParentRef: gatewayv1.ParentGatewayReference{
						Name:      gatewayv1.ObjectName("other-gw"),
						Namespace: ptrTo(gatewayv1.Namespace(testNamespace)),
					},
					Listeners: []gatewayv1.ListenerEntry{{
						Name:     gatewayv1.SectionName(fmt.Sprintf("tcp-%d", testL4PortRangeStart+1)),
						Protocol: gatewayv1.TCPProtocolType,
						Port:     gatewayv1.PortNumber(testL4PortRangeStart + 1),
					}},
				},
			}
			Expect(k8sClient.Create(ctx, foreignSet)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, foreignSet) }()

			env := validDevEnvironment("de-foreign-pool")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				ports := devEnvTCPRoutePorts(g, env.Name)
				g.Expect(ports).To(HaveLen(1))
				g.Expect(ports[0]).To(Equal(int32(testL4PortRangeStart)))
			}, "15s", "200ms").Should(Succeed())
		})

		// A listener declared on the Gateway itself heads the merged listener list,
		// so an environment given the same port loses that collision: its ListenerSet
		// listener comes back Conflicted and is never programmed, while the port
		// stays claimed and blocks every later environment too.
		It("skips a pool port the Gateway itself declares", func() {
			createGateway(true)
			defer deleteGateway()

			// Start from an empty pool: earlier specs release their environments
			// and routes asynchronously via the finalizer.
			Eventually(func(g Gomega) {
				envs := &aiv1alpha1.DevEnvironmentList{}
				g.Expect(k8sClient.List(ctx, envs)).To(Succeed())
				g.Expect(envs.Items).To(BeEmpty())
				routes := &gatewayv1.TCPRouteList{}
				g.Expect(k8sClient.List(ctx, routes, client.InNamespace(testNamespace))).To(Succeed())
				g.Expect(routes.Items).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			gw := &gatewayv1.Gateway{}
			Expect(k8sClient.Get(ctx, envKey(testDevEnvGatewayName), gw)).To(Succeed())
			gw.Spec.Listeners = append(gw.Spec.Listeners, gatewayv1.Listener{
				Name:     "platform-tcp",
				Port:     gatewayv1.PortNumber(testL4PortRangeStart),
				Protocol: gatewayv1.TCPProtocolType,
			})
			Expect(k8sClient.Update(ctx, gw)).To(Succeed())

			env := validDevEnvironment("de-gateway-pool-port")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// The lowest port of the range is the one the Gateway holds, so the
			// environment has to land on the next one.
			Eventually(func(g Gomega) {
				ports := devEnvTCPRoutePorts(g, env.Name)
				g.Expect(ports).To(HaveLen(1))
				g.Expect(ports[0]).To(Equal(int32(testL4PortRangeStart + 1)))
			}, "15s", "200ms").Should(Succeed())
		})

		It("prunes TCPRoutes for removed exposures and frees the listener port", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-prune")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var pSSH, pGRPC int32
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				pSSH = sshEndpointPort(got.Status.Endpoints)
				for _, ep := range got.Status.Endpoints {
					if ep.Name == testGRPCPortName {
						pGRPC = ep.ListenerPort
					}
				}
				g.Expect(pSSH).To(BeNumerically(">", 0))
				g.Expect(pGRPC).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())

			// Drop the extra TCP exposure: the grpc TCPRoute and its listener must
			// go while the SSH route, its listener and its port stay stable.
			updateEnvSpec(env.Name, func(env *aiv1alpha1.DevEnvironment) { env.Spec.Ports = nil })

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				tr := &gatewayv1.TCPRoute{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env.Name, pGRPC), Namespace: env.Namespace}, tr))).To(BeTrue())
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env.Name, pSSH), Namespace: env.Namespace}, tr)).To(Succeed())
				ls := &gatewayv1.ListenerSet{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, ls)).To(Succeed())
				g.Expect(ls.Spec.Listeners).To(HaveLen(1))
				g.Expect(ls.Spec.Listeners[0].Port).To(Equal(pSSH))
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got2)).To(Succeed())
				g.Expect(sshEndpointPort(got2.Status.Endpoints)).To(Equal(pSSH))
				for _, ep := range got2.Status.Endpoints {
					g.Expect(ep.Name).NotTo(Equal(testGRPCPortName))
				}
			}, "15s", "200ms").Should(Succeed())

			// The freed listener port is reusable: a new environment with the
			// same TCP exposure (and no SSH of its own) takes the released port.
			env2 := validDevEnvironment("de-prune-b")
			env2.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env2)).To(Succeed())
			defer deleteEnv(env2.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env2.Name, true, "", "")
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env2.Name), got2)).To(Succeed())
				p2 := int32(0)
				for _, ep := range got2.Status.Endpoints {
					if ep.Name == testGRPCPortName {
						p2 = ep.ListenerPort
					}
				}
				g.Expect(p2).To(Equal(pGRPC))
			}, "15s", "200ms").Should(Succeed())
		})

		It("frees the listener port and TCPRoute when the environment is deleted", func() {
			createGateway(true)
			defer deleteGateway()

			// Earlier specs release their environments asynchronously (via the
			// finalizer), so drain them first: the port pool below must start
			// empty for the reuse assertion to be deterministic.
			Eventually(func(g Gomega) {
				list := &aiv1alpha1.DevEnvironmentList{}
				g.Expect(k8sClient.List(ctx, list)).To(Succeed())
				g.Expect(list.Items).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			env1 := validDevEnvironment("de-free-a")
			env1.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env1)).To(Succeed())

			var p int32
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env1.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env1.Name), got)).To(Succeed())
				p = sshEndpointPort(got.Status.Endpoints)
				g.Expect(p).To(BeNumerically(">", 0))
				tr := &gatewayv1.TCPRoute{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env1.Name, p), Namespace: env1.Namespace}, tr)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			// Deleting the environment must release the TCPRoute, the ListenerSet
			// and the listener port. Wait until the object is fully gone: its
			// status endpoints would otherwise still mark the port as in use.
			Expect(k8sClient.Delete(ctx, env1)).To(Succeed())
			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env1.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				tr := &gatewayv1.TCPRoute{}
				err = k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env1.Name, p), Namespace: env1.Namespace}, tr)
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				ls := &gatewayv1.ListenerSet{}
				err = k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env1), Namespace: env1.Namespace}, ls)
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// With the pool empty again, a new ssh environment reuses the freed
			// port (lowest free) and publishes its own TCPRoute for it.
			env2 := validDevEnvironment("de-free-b")
			env2.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env2)).To(Succeed())
			defer deleteEnv(env2.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env2.Name, true, "", "")
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env2.Name), got2)).To(Succeed())
				g.Expect(sshEndpointPort(got2.Status.Endpoints)).To(Equal(p))
				tr := &gatewayv1.TCPRoute{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env2.Name, p), Namespace: env2.Namespace}, tr)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())
		})

		It("degrades RouteReady when the Gateway is missing", func() {
			gw := &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace}}
			if err := k8sClient.Get(ctx, client.ObjectKeyFromObject(gw), gw); err == nil {
				Expect(k8sClient.Delete(ctx, gw)).To(Succeed())
			}

			env := validDevEnvironment("de-no-gateway")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotFound))
			}, "15s", "200ms").Should(Succeed())

			// Core provisioning is unaffected by the gateway being missing.
			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
		})

		It("degrades RouteReady when the Gateway has no address", func() {
			createGateway(false)
			defer deleteGateway()

			env := validDevEnvironment("de-gw-not-ready")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotReady))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("withdraws the endpoints when the Gateway loses its address", func() {
			// The condition has to fall as well as rise. An address assigned when
			// the routes were published can be withdrawn afterwards — the dataplane
			// is rescheduled or rebuilt — and RouteReady=True would keep publishing
			// endpoints that no longer answer.
			//
			// What carries the fall is the Gateway watch: nothing else touches the
			// environment when the address goes, so without it the condition stays
			// True (verified by dropping the watch and watching this time out). A
			// green run is not by itself proof of that, since a status write can
			// still be in flight when the address is withdrawn and re-enqueue the
			// environment through the DevEnvironment watch.
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-gw-address-lost")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				g.Expect(got.Status.Endpoints).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// Only the address goes: the routes stay accepted, so what moves the
			// condition is the missing address and nothing else.
			gw := &gatewayv1.Gateway{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: testDevEnvGatewayName, Namespace: testNamespace}, gw)).To(Succeed())
			gw.Status.Addresses = nil
			Expect(k8sClient.Status().Update(ctx, gw)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotReady))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("withdraws the endpoints when the Gateway is deleted", func() {
			// The platform owns the Gateway, so it can be taken away from under a
			// published environment — an upgrade that replaces it, a rename, a
			// re-apply. The dataplane is derived from that object, so the address
			// in status.endpoints stops connecting the moment it goes; the
			// condition falling on its own would leave a user holding an address
			// that does not answer.
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-gw-deleted")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				g.Expect(got.Status.Endpoints).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			gw := &gatewayv1.Gateway{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: testDevEnvGatewayName, Namespace: testNamespace}, gw)).To(Succeed())
			Expect(k8sClient.Delete(ctx, gw)).To(Succeed())

			// What carries the fall is the Gateway watch: nothing else touches the
			// environment, since the routes themselves are untouched.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotFound))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps an environment's listener port when the Gateway is replaced", func() {
			// Withdrawing the endpoint list (::the spec above) must not withdraw
			// the allocation with it. The pool would read an environment that
			// records nothing as holding nothing, hand out the lowest free port,
			// and the SSH address a user was given would stop being the one that
			// answers. What survives the list is the environment's own ListenerSet,
			// which still declares the port while its routes are unaccepted.
			createGateway(true)
			defer deleteGateway()

			// The lowest port of the range is held by a ListenerSet of its own
			// until after the environment below is published, so that "the lowest
			// free port" is not the answer this spec is about: it is released
			// before the Gateway goes, which is what leaves the two answers
			// different. Nothing labels it for an environment, so it is a peer's
			// listeners to the pool and nothing at all to heldPorts.
			holder := &gatewayv1.ListenerSet{
				ObjectMeta: metav1.ObjectMeta{Name: "port-holder-l4", Namespace: testNamespace},
				Spec: gatewayv1.ListenerSetSpec{
					ParentRef: gatewayv1.ParentGatewayReference{
						Group:     ptrTo(gatewayv1.Group(gatewayAPIGroup)),
						Kind:      ptrTo(gatewayv1.Kind(gatewayKind)),
						Namespace: ptrTo(gatewayv1.Namespace(testNamespace)),
						Name:      gatewayv1.ObjectName(testDevEnvGatewayName),
					},
					Listeners: []gatewayv1.ListenerEntry{{
						Name:     gatewayv1.SectionName(fmt.Sprintf("holder-tcp-%d", testL4PortRangeStart)),
						Protocol: gatewayv1.TCPProtocolType,
						Port:     testL4PortRangeStart,
					}},
				},
			}
			Expect(k8sClient.Create(ctx, holder)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, holder) }()

			env := validDevEnvironment("de-gw-replaced")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var before int32
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				before = devEnvEndpointPort(got.Status.Endpoints, sshPortName)
				g.Expect(before).To(Equal(int32(testL4PortRangeStart + 1)))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, holder)).To(Succeed())
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(holder), &gatewayv1.ListenerSet{})).ToNot(Succeed())
			}, "15s", "200ms").Should(Succeed())

			gw := &gatewayv1.Gateway{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: testDevEnvGatewayName, Namespace: testNamespace}, gw)).To(Succeed())
			Expect(k8sClient.Delete(ctx, gw)).To(Succeed())
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// The Gateway comes back, and the environment's port comes back with
			// it rather than being the lowest free one.
			createGateway(true)
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				g.Expect(devEnvEndpointPort(got.Status.Endpoints, sshPortName)).To(Equal(before))
			}, "15s", "200ms").Should(Succeed())
		})

		It("withdraws the address of a stopped environment, and not its route", func() {
			// A stop and a gateway failure both end with no address, and what tells
			// them apart is RouteReady: the route is still published and still
			// accepted, so the condition goes on saying so while the address goes.
			// Only a web environment can tell the two apart — an ssh exposure loses
			// its address either way, the gateway rejecting its L4 route once nothing
			// is behind the Service — so this is the case the rule exists for.
			createGateway(true)
			defer deleteGateway()

			// No ssh, so the web address is the only endpoint this environment
			// publishes and nothing else can be what withdrew it. The timeout is what
			// makes an auto-stop mark survive: with the feature off the mark is stale
			// by definition, and the controller clears it before the phase is derived
			// (::clearSupersededAutoStop).
			env := validDevEnvironment("de-gw-stopped")
			env.Spec.Lifecycle = &aiv1alpha1.LifecycleSpec{IdleTimeout: 600}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			webAddressPublished := func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				g.Expect(got.Status.Endpoints).To(HaveLen(1))
				g.Expect(got.Status.Endpoints[0].Name).To(Equal(string(aiv1alpha1.DevEnvironmentTypeJupyter)))
			}
			Eventually(webAddressPublished, "15s", "200ms").Should(Succeed())

			// A user's stop.
			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) { e.Spec.Running = false })
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// And it is the address that went, not the routes: starting again is
			// handed the same one rather than provisioned afresh.
			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) { e.Spec.Running = true })
			Eventually(webAddressPublished, "15s", "200ms").Should(Succeed())

			// The other reason a phase becomes Stopped, and the one no user asked
			// for. The mark is written by hand because driving the idle clock is the
			// idle suite's subject; the state is the one that suite produces.
			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				if e.Annotations == nil {
					e.Annotations = map[string]string{}
				}
				e.Annotations[autoStoppedAnnotationKey] = autoStoppedValue
			})
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(got.Status.Phase.Reason).To(Equal(reasonIdleTimeout))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("withholds the endpoints of routes the Gateway has not accepted", func() {
			// The shape found on the cs2 cluster: the Gateway has an address and
			// is Programmed, but carries no listener for the port an SSH route
			// attaches to, so the route is refused with NoMatchingParent. An
			// assigned address is not acceptance, and publishing the endpoint
			// anyway advertises an address that does not connect.
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-not-accepted")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, false, string(gatewayv1.RouteReasonNoMatchingParent), "No listeners match this parent ref")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotAccepted))
				// The message names the route and repeats the Gateway's own
				// verdict, which is what identifies the missing listener.
				g.Expect(cond.Message).To(ContainSubstring("-tcp-"))
				g.Expect(cond.Message).To(ContainSubstring("NoMatchingParent: No listeners match this parent ref"))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// Once the Gateway accepts the route, the condition and the endpoints
			// move together.
			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				g.Expect(sshEndpointPort(got.Status.Endpoints)).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports the web route when the Gateway refuses that one instead", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-web-not-accepted")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, false, string(gatewayv1.RouteReasonNoMatchingParent), "No listeners match this parent ref")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotAccepted))
				g.Expect(cond.Message).To(ContainSubstring(env.Name + "-web"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("brackets an IPv6 gateway address in published endpoints", func() {
			gw := &gatewayv1.Gateway{
				ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace},
				Spec: gatewayv1.GatewaySpec{
					GatewayClassName: gatewayv1.ObjectName("eg"),
					Listeners: []gatewayv1.Listener{{
						Name:     gatewayv1.SectionName(testPortName),
						Port:     gatewayv1.PortNumber(80),
						Protocol: gatewayv1.HTTPProtocolType,
					}},
				},
			}
			Expect(k8sClient.Create(ctx, gw)).To(Succeed())
			defer deleteGateway()
			gw.Status.Addresses = []gatewayv1.GatewayStatusAddress{{Type: ptrTo(gatewayv1.IPAddressType), Value: "2001:db8::1"}}
			Expect(k8sClient.Status().Update(ctx, gw)).To(Succeed())

			env := validDevEnvironment("de-ipv6")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				stampDevEnvRoutes(g, env.Name, true, "", "")
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				var web, ssh, tcp string
				for _, ep := range got.Status.Endpoints {
					switch ep.Name {
					case string(env.Spec.Type):
						web = ep.Address
					case sshPortName:
						ssh = ep.Address
					case testGRPCPortName:
						tcp = ep.Address
					}
				}
				g.Expect(web).To(Equal("http://[2001:db8::1]:80" + webRootPath + env.Name + "/"))
				g.Expect(ssh).To(HavePrefix("ssh://" + defaultRuntimeUser + "@[2001:db8::1]:"))
				g.Expect(tcp).To(HavePrefix("[2001:db8::1]:"))
				g.Expect(addressPort(tcp)).To(BeNumerically(">", 0))
				g.Expect(addressPort(ssh)).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())
		})
	})
})

// The dataplane Service is how a published endpoint learns where it is actually
// reachable: Envoy Gateway creates it, and its type decides whether a listener
// is served on its own port (LoadBalancer, ClusterIP) or renumbered onto a
// nodePort (NodePort). These specs create it by hand, since envtest runs no
// Envoy Gateway. It lives in the dataplane namespace, which is deliberately not
// the Gateway's own.
var _ = Describe("published endpoint ports", func() {
	dataplaneName := "envoy-" + testNamespace + "-" + testDevEnvGatewayName

	// createDataplaneService publishes the Service Envoy Gateway would own for
	// the test Gateway, labelled the way the controller looks it up.
	createDataplaneService := func(svcType corev1.ServiceType, ports []corev1.ServicePort) {
		Expect(client.IgnoreAlreadyExists(k8sClient.Create(ctx, &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: testGatewayDataplaneNamespace},
		}))).To(Succeed())
		Expect(k8sClient.Create(ctx, &corev1.Service{
			ObjectMeta: metav1.ObjectMeta{
				Name:      dataplaneName,
				Namespace: testGatewayDataplaneNamespace,
				Labels: map[string]string{
					gatewayDataplaneNameLabel:      testDevEnvGatewayName,
					gatewayDataplaneNamespaceLabel: testNamespace,
				},
			},
			Spec: corev1.ServiceSpec{Type: svcType, Ports: ports},
		})).To(Succeed())
	}
	deleteDataplaneService := func() {
		_ = k8sClient.Delete(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{
			Name: dataplaneName, Namespace: testGatewayDataplaneNamespace}})
	}
	// nodePortFor is the nodePort this dataplane hands its nth listener, lowest
	// listener port first, so the specs state the relationship rather than a
	// pairing that only holds while the pool is empty.
	nodePortFor := func(i int) int32 { return int32(31000 + i) }

	// listenerPortsOf waits for the environment's listeners to exist and returns
	// the pool ports they hold, sorted.
	listenerPortsOf := func(envName string, want int) []int32 {
		var ports []int32
		Eventually(func(g Gomega) {
			stampDevEnvRoutes(g, envName, true, "", "")
			ports = devEnvTCPRoutePorts(g, envName)
			g.Expect(ports).To(HaveLen(want))
		}, "15s", "200ms").Should(Succeed())
		slices.Sort(ports)
		return ports
	}

	// programListenerSet writes the verdict the gateway reaches once a listener is
	// in its dataplane. Writing it re-enqueues the environment — the ListenerSet
	// is one of its own objects — which is what publishes it against the
	// dataplane that has since appeared.
	programListenerSet := func(envName string) {
		ls := &gatewayv1.ListenerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: envName + l4ListenerSetSuffix, Namespace: testNamespace}, ls)).To(Succeed())
		ls.Status.Conditions = append(ls.Status.Conditions, metav1.Condition{
			Type:               string(gatewayv1.ListenerSetConditionProgrammed),
			Status:             metav1.ConditionTrue,
			Reason:             string(gatewayv1.ListenerSetReasonProgrammed),
			ObservedGeneration: ls.Generation,
			LastTransitionTime: testRouteConditionTime,
		})
		Expect(k8sClient.Status().Update(ctx, ls)).To(Succeed())
	}

	newSSHEnvironment := func(name string, extra ...aiv1alpha1.PortSpec) *aiv1alpha1.DevEnvironment {
		env := validDevEnvironment(name)
		env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
		env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
		env.Spec.Ports = extra
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		return env
	}

	It("publishes the nodePort the dataplane renumbers the listener onto, keeping the listener port", func() {
		createGateway(true)
		defer deleteGateway()

		env := newSSHEnvironment("de-nodeport", aiv1alpha1.PortSpec{
			Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051,
		})
		defer deleteEnv(env.Name)

		// Before any dataplane exists the listener port is all there is, and that
		// is what an address is built from.
		listenerPorts := listenerPortsOf(env.Name, 2)
		Eventually(func(g Gomega) {
			stampDevEnvRoutes(g, env.Name, true, "", "")
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			g.Expect(got.Status.Endpoints).To(HaveLen(2))
			for _, ep := range got.Status.Endpoints {
				g.Expect(ep.ListenerPort).To(Equal(addressPort(ep.Address)))
			}
		}, "15s", "200ms").Should(Succeed())

		// The dataplane arrives as a NodePort Service: every listener moves to its
		// nodePort, and the allocation underneath it does not move at all.
		ports := make([]corev1.ServicePort, 0, 1+len(listenerPorts))
		ports = append(ports, corev1.ServicePort{Name: testPortName, Port: 80, NodePort: 31080})
		for i, p := range listenerPorts {
			ports = append(ports, corev1.ServicePort{Name: fmt.Sprintf("tcp-%d", p), Port: p, NodePort: nodePortFor(i)})
		}
		createDataplaneService(corev1.ServiceTypeNodePort, ports)
		defer deleteDataplaneService()
		programListenerSet(env.Name)

		// The routes carry their verdict from above, so this waits on the
		// renumbering alone rather than re-stamping them each round.
		Eventually(func(g Gomega) {
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
			g.Expect(got.Status.Endpoints).To(HaveLen(2))

			// The listeners still hold the pool ports, which is what makes the next
			// reconcile hand the environment the same ones — and so the same
			// addresses — rather than reallocating around it.
			ls := &gatewayv1.ListenerSet{}
			g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: testNamespace}, ls)).To(Succeed())
			g.Expect(ls.Spec.Listeners).To(HaveLen(len(listenerPorts)))
			for i, l := range ls.Spec.Listeners {
				g.Expect(l.Port).To(Equal(listenerPorts[i]))
			}

			published := map[int32]bool{}
			for _, ep := range got.Status.Endpoints {
				g.Expect(ep.ListenerPort).To(BeElementOf(listenerPorts))
				g.Expect(addressPort(ep.Address)).To(Equal(nodePortFor(slices.Index(listenerPorts, ep.ListenerPort))))
				published[ep.ListenerPort] = true
			}
			g.Expect(published).To(HaveLen(len(listenerPorts)))
		}, "15s", "200ms").Should(Succeed())
	})

	It("republishes the address when the dataplane renumbers the listener", func() {
		createGateway(true)
		defer deleteGateway()

		env := newSSHEnvironment("de-nodeport-renumber")
		defer deleteEnv(env.Name)

		listenerPorts := listenerPortsOf(env.Name, 1)
		createDataplaneService(corev1.ServiceTypeNodePort, []corev1.ServicePort{
			{Name: testPortName, Port: 80, NodePort: 31080},
			{Name: fmt.Sprintf("tcp-%d", listenerPorts[0]), Port: listenerPorts[0], NodePort: nodePortFor(0)},
		})
		defer deleteDataplaneService()
		programListenerSet(env.Name)

		// publishedSSHPort reads the port the ssh address is reachable on, and
		// checks the allocation under it has not moved: the two are what the
		// renumbering is expected to separate.
		publishedSSHPort := func(g Gomega) int32 {
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
			g.Expect(got.Status.Endpoints).NotTo(BeEmpty())
			for _, ep := range got.Status.Endpoints {
				if ep.Name == sshPortName {
					g.Expect(ep.ListenerPort).To(Equal(listenerPorts[0]))
					return addressPort(ep.Address)
				}
			}
			g.Expect(got.Status.Endpoints).To(ContainElement(HaveField("Name", sshPortName)))
			return 0
		}
		Eventually(publishedSSHPort, "15s", "200ms").Should(Equal(nodePortFor(0)))

		// The dataplane comes back with a different nodePort — Envoy Gateway's
		// assignment, not this environment's allocation — and nothing else about
		// the environment changes. The new port reaches status only because the
		// dataplane Service is watched: an address that outlives the port it names
		// is the failure this watches for.
		svc := &corev1.Service{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: dataplaneName, Namespace: testGatewayDataplaneNamespace}, svc)).To(Succeed())
		renumbered := false
		for i := range svc.Spec.Ports {
			if svc.Spec.Ports[i].Port == listenerPorts[0] {
				svc.Spec.Ports[i].NodePort = nodePortFor(9)
				renumbered = true
			}
		}
		Expect(renumbered).To(BeTrue())
		Expect(k8sClient.Update(ctx, svc)).To(Succeed())

		Eventually(publishedSSHPort, "15s", "200ms").Should(Equal(nodePortFor(9)))
	})

	It("keeps the address on the listener port when the dataplane is not a NodePort", func() {
		createGateway(true)
		defer deleteGateway()

		env := newSSHEnvironment("de-lb-dataplane")
		defer deleteEnv(env.Name)

		listenerPorts := listenerPortsOf(env.Name, 1)
		createDataplaneService(corev1.ServiceTypeLoadBalancer, []corev1.ServicePort{
			{Name: testPortName, Port: 80},
			{Name: fmt.Sprintf("tcp-%d", listenerPorts[0]), Port: listenerPorts[0]},
		})
		defer deleteDataplaneService()

		Eventually(func(g Gomega) {
			stampDevEnvRoutes(g, env.Name, true, "", "")
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
			g.Expect(sshEndpointPort(got.Status.Endpoints)).To(Equal(listenerPorts[0]))
			for _, ep := range got.Status.Endpoints {
				g.Expect(ep.ListenerPort).To(Equal(listenerPorts[0]))
				g.Expect(addressPort(ep.Address)).To(Equal(listenerPorts[0]))
			}
		}, "15s", "200ms").Should(Succeed())
	})

	It("withholds endpoints when the dataplane exposes no nodePort for the listener", func() {
		createGateway(true)
		defer deleteGateway()

		env := newSSHEnvironment("de-nodeport-gap")
		defer deleteEnv(env.Name)

		// A NodePort dataplane carrying only the Gateway's HTTP listener: the ssh
		// listener the environment allocated has no nodePort to be published at,
		// and a listener port would name a port that is closed on the node.
		createDataplaneService(corev1.ServiceTypeNodePort, []corev1.ServicePort{
			{Name: testPortName, Port: 80, NodePort: 31080},
		})
		defer deleteDataplaneService()

		Eventually(func(g Gomega) {
			stampDevEnvRoutes(g, env.Name, true, "", "")
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
			g.Expect(cond).NotTo(BeNil())
			g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			g.Expect(cond.Reason).To(Equal(reasonGatewayNotReady))
			g.Expect(cond.Message).To(ContainSubstring("exposes no nodePort"))
			g.Expect(got.Status.Endpoints).To(BeEmpty())
		}, "15s", "200ms").Should(Succeed())
	})

	It("publishes an ssh environment on a dataplane that carries no HTTP port", func() {
		createGateway(true)
		defer deleteGateway()

		env := newSSHEnvironment("de-nodeport-no-http")
		defer deleteEnv(env.Name)

		// The mirror of the spec above, on the other side of the same rule. An ssh
		// environment has no endpoint on the Gateway's HTTP listener, so a dataplane
		// without that port — a Gateway serving no HTTP at all — says nothing about
		// its ssh address, which resolved perfectly well. Requiring the HTTP port
		// here would withhold every endpoint the environment has.
		listenerPorts := listenerPortsOf(env.Name, 1)
		createDataplaneService(corev1.ServiceTypeNodePort, []corev1.ServicePort{
			{Name: fmt.Sprintf("tcp-%d", listenerPorts[0]), Port: listenerPorts[0], NodePort: nodePortFor(0)},
		})
		defer deleteDataplaneService()

		Eventually(func(g Gomega) {
			stampDevEnvRoutes(g, env.Name, true, "", "")
			got := &aiv1alpha1.DevEnvironment{}
			g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
			g.Expect(sshEndpointPort(got.Status.Endpoints)).To(Equal(listenerPorts[0]))
			g.Expect(got.Status.Endpoints).To(HaveLen(1))
			g.Expect(addressPort(got.Status.Endpoints[0].Address)).To(Equal(nodePortFor(0)))
		}, "15s", "200ms").Should(Succeed())
	})
})

var _ = Describe("enqueueForDataplaneService", func() {
	// Only the Gateway's own dataplane Service says anything about an
	// environment's addresses. Every other Service in the cluster reaches this
	// mapFunc, and enqueuing all environments for each of them would turn an
	// unrelated Service write into a reconcile of every environment.
	dataplaneReconciler := func() *DevEnvironmentReconciler {
		return &DevEnvironmentReconciler{
			Client: k8sClient,
			Scheme: testMgr.GetScheme(),
			Config: DevEnvironmentControllerConfig{
				GatewayName:               testDevEnvGatewayName,
				GatewayNamespace:          testNamespace,
				GatewayDataplaneNamespace: testGatewayDataplaneNamespace,
			},
		}
	}
	service := func(namespace string, labels map[string]string) *corev1.Service {
		// The name is the mapFunc's business only through its labels; Envoy
		// Gateway's own naming is not part of what it matches on.
		return &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "dataplane", Namespace: namespace, Labels: labels}}
	}
	owningLabels := map[string]string{
		gatewayDataplaneNameLabel:      testDevEnvGatewayName,
		gatewayDataplaneNamespaceLabel: testNamespace,
	}

	It("maps the Gateway's dataplane Service to every environment", func() {
		// The mapping lists every environment in the cluster, and earlier specs
		// release theirs asynchronously (via the finalizer), so drain first: the
		// assertion below is over the complete set and would otherwise be
		// counting somebody else's leftovers.
		Eventually(func(g Gomega) {
			list := &aiv1alpha1.DevEnvironmentList{}
			g.Expect(k8sClient.List(ctx, list)).To(Succeed())
			g.Expect(list.Items).To(BeEmpty())
		}, "15s", "200ms").Should(Succeed())

		first := validDevEnvironment("de-dataplane-watch-a")
		second := validDevEnvironment("de-dataplane-watch-b")
		Expect(k8sClient.Create(ctx, first)).To(Succeed())
		Expect(k8sClient.Create(ctx, second)).To(Succeed())
		defer deleteEnv(first.Name)
		defer deleteEnv(second.Name)

		r := dataplaneReconciler()
		// ConsistOf rather than ContainElement: each environment is enqueued
		// exactly once. A mapping that drops an environment, repeats one or
		// invents one leaves that environment publishing an address the dataplane
		// no longer serves, and a subset assertion cannot see it.
		Eventually(func(g Gomega) {
			g.Expect(r.enqueueForDataplaneService(ctx, service(testGatewayDataplaneNamespace, owningLabels))).
				To(ConsistOf(
					reconcile.Request{NamespacedName: types.NamespacedName{Namespace: testNamespace, Name: first.Name}},
					reconcile.Request{NamespacedName: types.NamespacedName{Namespace: testNamespace, Name: second.Name}},
				))
		}, "15s", "200ms").Should(Succeed())
	})

	It("ignores Services that are not it, and a namespace that is not configured", func() {
		r := dataplaneReconciler()
		Expect(r.enqueueForDataplaneService(ctx, service(testNamespace, owningLabels))).To(BeEmpty())
		Expect(r.enqueueForDataplaneService(ctx, service(testGatewayDataplaneNamespace,
			map[string]string{
				gatewayDataplaneNameLabel:      "another-gateway",
				gatewayDataplaneNamespaceLabel: testNamespace,
			}))).To(BeEmpty())
		Expect(r.enqueueForDataplaneService(ctx, service(testGatewayDataplaneNamespace, nil))).To(BeEmpty())

		// The flag is what turns the lookup on: with no namespace configured the
		// controller never reads the dataplane Service either.
		r.Config.GatewayDataplaneNamespace = ""
		Expect(r.enqueueForDataplaneService(ctx, service(testGatewayDataplaneNamespace, owningLabels))).To(BeEmpty())
	})
})

var _ = Describe("enqueueAllDevEnvironments", func() {
	// The Gateway watch maps a Gateway event — the address appearing, changing, or
	// going away — to every environment. The Gateway is shared, so nothing on an
	// environment says the address it published under is still the one the Gateway
	// hands out; every environment has to be re-reconciled on each event, and
	// exactly once, because that reconcile is what withdraws an address that has
	// stopped answering.
	//
	// This covers the mapping, which is what a Gateway event goes through. That the
	// watch is registered at all is what "withdraws the endpoints when the Gateway
	// loses its address" above exercises, and it cannot prove that on its own: the
	// DevEnvironment watch can carry the same fall if a status write is still in
	// flight.
	It("maps one Gateway event to every environment, once each", func() {
		// Everything in the cluster is mapped, so drain first: this asserts the
		// complete set, and earlier specs release their environments
		// asynchronously.
		Eventually(func(g Gomega) {
			list := &aiv1alpha1.DevEnvironmentList{}
			g.Expect(k8sClient.List(ctx, list)).To(Succeed())
			g.Expect(list.Items).To(BeEmpty())
		}, "15s", "200ms").Should(Succeed())

		first := validDevEnvironment("de-gw-event-a")
		second := validDevEnvironment("de-gw-event-b")
		Expect(k8sClient.Create(ctx, first)).To(Succeed())
		Expect(k8sClient.Create(ctx, second)).To(Succeed())
		defer deleteEnv(first.Name)
		defer deleteEnv(second.Name)

		r := &DevEnvironmentReconciler{Client: k8sClient}
		Eventually(func(g Gomega) {
			g.Expect(r.enqueueAllDevEnvironments(ctx, &gatewayv1.Gateway{
				ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace},
			})).To(ConsistOf(
				reconcile.Request{NamespacedName: types.NamespacedName{Namespace: testNamespace, Name: first.Name}},
				reconcile.Request{NamespacedName: types.NamespacedName{Namespace: testNamespace, Name: second.Name}},
			))
		}, "15s", "200ms").Should(Succeed())
	})
})

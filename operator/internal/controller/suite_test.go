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
	"context"
	"path/filepath"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"
)

var (
	ctx           context.Context
	cancelMgr     context.CancelFunc
	mgrDone       chan struct{}
	testEnv       *envtest.Environment
	cfg           *rest.Config
	k8sClient     client.Client
	testMgr       ctrl.Manager
	testScheme    *runtime.Scheme
	testNamespace = "default"
)

func TestControllers(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
	ctx, cancelMgr = context.WithCancel(context.Background())

	testEnv = &envtest.Environment{
		CRDDirectoryPaths: []string{
			filepath.Join("..", "..", "config", "crd", "bases"),
			filepath.Join("..", "..", "testdata", "lws-crd"),
			filepath.Join("..", "..", "testdata", "gateway-crds"),
		},
	}
	// kube-apiserver 1.36 takes ~60s to exit on SIGTERM while informer
	// watches are active; raise envtest's default 20s stop timeout so
	// AfterSuite teardown succeeds.
	testEnv.ControlPlaneStopTimeout = 120 * time.Second

	var err error
	cfg, err = testEnv.Start()
	Expect(err).NotTo(HaveOccurred())

	testScheme = runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(testScheme))
	utilruntime.Must(aiv1alpha1.AddToScheme(testScheme))
	utilruntime.Must(leaderworkersetv1.AddToScheme(testScheme))
	utilruntime.Must(gatewayv1.Install(testScheme))

	k8sClient, err = client.New(cfg, client.Options{Scheme: testScheme})
	Expect(err).NotTo(HaveOccurred())

	testMgr, err = ctrl.NewManager(cfg, ctrl.Options{
		Scheme: testScheme,
		// Disable the metrics server: its default bind address (:8080) is
		// often occupied on dev machines, and a bind failure aborts manager
		// startup before any controller runs.
		Metrics: metricsserver.Options{BindAddress: "0"},
	})
	Expect(err).NotTo(HaveOccurred())

	err = (&ModelVersionReconciler{Client: testMgr.GetClient(), Scheme: testMgr.GetScheme()}).SetupWithManager(testMgr)
	Expect(err).NotTo(HaveOccurred())

	err = (&InferenceRuntimeProfileReconciler{Client: testMgr.GetClient(), Scheme: testMgr.GetScheme()}).SetupWithManager(testMgr)
	Expect(err).NotTo(HaveOccurred())

	err = (&InferenceServiceReconciler{Client: testMgr.GetClient(), Scheme: testMgr.GetScheme()}).SetupWithManager(testMgr)
	Expect(err).NotTo(HaveOccurred())

	err = (&DevEnvironmentReconciler{
		Client: testMgr.GetClient(),
		Scheme: testMgr.GetScheme(),
		Config: DevEnvironmentControllerConfig{
			GatewayName:       "test-gw",
			GatewayNamespace:  testNamespace,
			HTTPPort:          80,
			SSHPortRangeStart: 20000,
			SSHPortRangeEnd:   20100,
		},
	}).SetupWithManager(testMgr)
	Expect(err).NotTo(HaveOccurred())

	mgrDone = make(chan struct{})
	go func() {
		defer close(mgrDone)
		defer GinkgoRecover()
		Expect(testMgr.Start(ctx)).To(Succeed())
	}()
})

var _ = AfterSuite(func() {
	// Stop the manager first so its informer watches are closed before the
	// control plane is torn down; kube-apiserver exits promptly once no
	// watches remain.
	cancelMgr()
	<-mgrDone
	Expect(testEnv.Stop()).To(Succeed())
})

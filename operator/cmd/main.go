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

package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"os"
	"strings"

	// Import all Kubernetes client auth plugins (e.g. Azure, GCP, OIDC, etc.)
	// to ensure that exec-entrypoint and run can make use of them.
	_ "k8s.io/client-go/plugin/pkg/client/auth"

	"k8s.io/apimachinery/pkg/api/validate/content"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aigwv1beta1 "github.com/envoyproxy/ai-gateway/api/v1beta1"
	egv1alpha1 "github.com/envoyproxy/gateway/api/v1alpha1"
	monitoringv1 "github.com/prometheus-operator/prometheus-operator/pkg/apis/monitoring/v1"
	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/controller"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"
	// +kubebuilder:scaffold:imports
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))

	utilruntime.Must(aiv1alpha1.AddToScheme(scheme))
	utilruntime.Must(leaderworkersetv1.AddToScheme(scheme))
	utilruntime.Must(gatewayv1.Install(scheme))
	utilruntime.Must(monitoringv1.AddToScheme(scheme))
	utilruntime.Must(aigwv1beta1.AddToScheme(scheme))
	utilruntime.Must(egv1alpha1.AddToScheme(scheme))
	// +kubebuilder:scaffold:scheme
}

// nolint:gocyclo
func main() {
	var metricsAddr string
	var metricsCertPath, metricsCertName, metricsCertKey string
	var webhookCertPath, webhookCertName, webhookCertKey string
	var enableLeaderElection bool
	var probeAddr string
	var secureMetrics bool
	var enableHTTP2 bool
	var tlsOpts []func(*tls.Config)
	var gatewayName, gatewayNamespace, gatewayDataplaneNamespace, gatewayCatalogHostname string
	var l4PortRangeStart, l4PortRangeEnd int
	var rdmaIBResource, rdmaRoCEResource string
	flag.StringVar(&metricsAddr, "metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	flag.StringVar(&gatewayName, "gateway-name", "",
		"Name of the platform Gateway that published model-catalog AIGatewayRoutes "+
			"and DevEnvironment ListenerSets attach to.")
	flag.StringVar(&gatewayNamespace, "gateway-namespace", "envoy-gateway-system",
		"Namespace of the platform Gateway. The default is where Envoy Gateway installs, which is "+
			"where the platform creates the Gateway unless it is told to put it elsewhere.")
	flag.StringVar(&gatewayDataplaneNamespace, "gateway-dataplane-namespace", "",
		"Namespace the platform Gateway's dataplane Service and pods run in; when set, DevEnvironment "+
			"pods admit ingress from that Gateway, and published endpoints are addressed at the port "+
			"its dataplane Service exposes them on. Leaving it empty keeps environments default-deny "+
			"inbound, and addresses on their listener ports.")
	flag.StringVar(&gatewayCatalogHostname, "gateway-catalog-hostname", "",
		"Shared model-catalog hostname surfaced in status.endpoint.public so the Agent Router can "+
			"advertise the catalog's host. Display only — it no longer gates publishing.")
	flag.IntVar(&l4PortRangeStart, "l4-port-range-start", 20000,
		"First port of the DevEnvironment L4 port pool. Each allocated port becomes a listener the "+
			"environment's own ListenerSet declares on the platform Gateway.")
	flag.IntVar(&l4PortRangeEnd, "l4-port-range-end", 20999,
		"Last port of the DevEnvironment L4 port pool. The pool is cluster-wide: each ssh exposure and "+
			"each spec.ports[].type: tcp exposure takes one port from it.")
	flag.StringVar(&rdmaIBResource, "rdma-ib-resource", "rdma/ib_shared_devices",
		"Extended resource an InfiniBand DevEnvironment requests. It is advertised by the cluster's "+
			"shared RDMA device plugin, whose ConfigMap owns the name. The rdma/ prefix is the plugin's "+
			"own resourcePrefix default, so leaving it alone needs no change to that ConfigMap.")
	flag.StringVar(&rdmaRoCEResource, "rdma-roce-resource", "rdma/roce_shared_devices",
		"Extended resource a RoCE DevEnvironment requests, from the same device plugin. The two names "+
			"are this platform's own: no convention exists for naming an RDMA resource after its fabric, "+
			"so the pair is deliberately symmetric rather than copied from the plugin's own examples, "+
			"which distinguish pools by instance (hca_shared_devices_a and _b).")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	flag.BoolVar(&secureMetrics, "metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	flag.StringVar(&webhookCertPath, "webhook-cert-path", "", "The directory that contains the webhook certificate.")
	flag.StringVar(&webhookCertName, "webhook-cert-name", "tls.crt", "The name of the webhook certificate file.")
	flag.StringVar(&webhookCertKey, "webhook-cert-key", "tls.key", "The name of the webhook key file.")
	flag.StringVar(&metricsCertPath, "metrics-cert-path", "",
		"The directory that contains the metrics server certificate.")
	flag.StringVar(&metricsCertName, "metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	flag.StringVar(&metricsCertKey, "metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	flag.BoolVar(&enableHTTP2, "enable-http2", false,
		"If set, HTTP/2 will be enabled for the metrics and webhook servers")
	opts := zap.Options{
		Development: true,
	}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	// Both port flags are narrowed to int32 for the controller below, so a value
	// that is not a port has to be rejected while it is still an int: out of
	// range the conversion wraps, and 0 is the controller's "unset" sentinel —
	// an oversized start would silently come back as the default pool. Zero is
	// that sentinel and stays valid, meaning "use the configured default".
	for _, f := range [...]struct {
		name  string
		value int
	}{
		{"l4-port-range-start", l4PortRangeStart},
		{"l4-port-range-end", l4PortRangeEnd},
	} {
		if f.value != 0 && (f.value < 1 || f.value > 65535) {
			setupLog.Error(fmt.Errorf("--%s must be a port between 1 and 65535, got %d", f.name, f.value), "Invalid flag")
			os.Exit(1)
		}
	}

	// A resource name reaches the pod verbatim. The API server would reject an
	// unqualified one at admission — after the environment's StatefulSet exists
	// and the failure is per-environment rather than once at startup — and a
	// name the gpu field already owns would be overwritten in the resource map
	// without any error at all, so both are caught here instead.
	for _, f := range [...]struct {
		name  string
		value string
	}{
		{"rdma-ib-resource", rdmaIBResource},
		{"rdma-roce-resource", rdmaRoCEResource},
	} {
		if err := validateRDMAResource(f.name, f.value); err != nil {
			setupLog.Error(err, "Invalid flag")
			os.Exit(1)
		}
	}

	// if the enable-http2 flag is false (the default), http/2 should be disabled
	// due to its vulnerabilities. More specifically, disabling http/2 will
	// prevent from being vulnerable to the HTTP/2 Stream Cancellation and
	// Rapid Reset CVEs. For more information see:
	// - https://github.com/advisories/GHSA-qppj-fm5r-hxr3
	// - https://github.com/advisories/GHSA-4374-p667-p6c8
	disableHTTP2 := func(c *tls.Config) {
		setupLog.Info("Disabling HTTP/2")
		c.NextProtos = []string{"http/1.1"}
	}

	if !enableHTTP2 {
		tlsOpts = append(tlsOpts, disableHTTP2)
	}

	// Initial webhook TLS options
	webhookTLSOpts := tlsOpts
	webhookServerOptions := webhook.Options{
		TLSOpts: webhookTLSOpts,
	}

	if len(webhookCertPath) > 0 {
		setupLog.Info("Initializing webhook certificate watcher using provided certificates",
			"webhook-cert-path", webhookCertPath, "webhook-cert-name", webhookCertName, "webhook-cert-key", webhookCertKey)

		webhookServerOptions.CertDir = webhookCertPath
		webhookServerOptions.CertName = webhookCertName
		webhookServerOptions.KeyName = webhookCertKey
	}

	webhookServer := webhook.NewServer(webhookServerOptions)

	// Metrics endpoint is enabled in 'config/default/kustomization.yaml'. The Metrics options configure the server.
	// More info:
	// - https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.24.1/pkg/metrics/server
	// - https://book.kubebuilder.io/reference/metrics.html
	metricsServerOptions := metricsserver.Options{
		BindAddress:   metricsAddr,
		SecureServing: secureMetrics,
		TLSOpts:       tlsOpts,
	}

	if secureMetrics {
		// FilterProvider is used to protect the metrics endpoint with authn/authz.
		// These configurations ensure that only authorized users and service accounts
		// can access the metrics endpoint. The RBAC are configured in 'config/rbac/kustomization.yaml'. More info:
		// https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.24.1/pkg/metrics/filters#WithAuthenticationAndAuthorization
		metricsServerOptions.FilterProvider = filters.WithAuthenticationAndAuthorization
	}

	// If the certificate is not specified, controller-runtime will automatically
	// generate self-signed certificates for the metrics server. While convenient for development and testing,
	// this setup is not recommended for production.
	//
	// TODO(user): If you enable certManager, uncomment the following lines:
	// - [METRICS-WITH-CERTS] at config/default/kustomization.yaml to generate and use certificates
	// managed by cert-manager for the metrics server.
	// - [PROMETHEUS-WITH-CERTS] at config/prometheus/kustomization.yaml for TLS certification.
	if len(metricsCertPath) > 0 {
		setupLog.Info("Initializing metrics certificate watcher using provided certificates",
			"metrics-cert-path", metricsCertPath, "metrics-cert-name", metricsCertName, "metrics-cert-key", metricsCertKey)

		metricsServerOptions.CertDir = metricsCertPath
		metricsServerOptions.CertName = metricsCertName
		metricsServerOptions.KeyName = metricsCertKey
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsServerOptions,
		WebhookServer:          webhookServer,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "fdeb27eb.suanova.com",
		// LeaderElectionReleaseOnCancel defines if the leader should step down voluntarily
		// when the Manager ends. This requires the binary to immediately end when the
		// Manager is stopped, otherwise, this setting is unsafe. Setting this significantly
		// speeds up voluntary leader transitions as the new leader don't have to wait
		// LeaseDuration time first.
		//
		// In the default scaffold provided, the program ends immediately after
		// the manager stops, so would be fine to enable this option. However,
		// if you are doing or is intended to do any operation such as perform cleanups
		// after the manager stops then its usage might be unsafe.
		// LeaderElectionReleaseOnCancel: true,
	})
	if err != nil {
		setupLog.Error(err, "Failed to start manager")
		os.Exit(1)
	}

	// +kubebuilder:scaffold:builder

	if err = (&controller.ModelVersionReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "ModelVersion")
		os.Exit(1)
	}
	if err = (&controller.InferenceRuntimeProfileReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "InferenceRuntimeProfile")
		os.Exit(1)
	}
	if err = (&controller.InferenceServiceReconciler{
		Client:           mgr.GetClient(),
		Scheme:           mgr.GetScheme(),
		GatewayName:      gatewayName,
		GatewayNamespace: gatewayNamespace,
		// The shared model-catalog hostname surfaced in status.endpoint.public;
		// a display value only, no longer a publish gate.
		CatalogHostname: gatewayCatalogHostname,
		// Probe the Agent Router kinds once: where they are not served,
		// publishing degrades to RouteReady=False with reason
		// AgentRouterUnavailable instead of failing on an unknown kind. A
		// cluster that installs the CRDs later needs an operator restart to
		// pick them up.
		AgentRouterAvailable: controller.AgentRouterAvailable(mgr.GetRESTMapper()),
		// Probe the optional ServiceMonitor CRD once: where it is not served,
		// the controller skips the scrape monitors instead of failing every
		// InferenceService on an unknown kind. A cluster that installs the
		// CRDs later needs an operator restart to pick them up.
		ServiceMonitorAvailable: controller.ServiceMonitorAvailable(mgr.GetRESTMapper()),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "InferenceService")
		os.Exit(1)
	}
	if err = (&controller.DevEnvironmentReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
		Config: controller.DevEnvironmentControllerConfig{
			GatewayName:               gatewayName,
			GatewayNamespace:          gatewayNamespace,
			GatewayDataplaneNamespace: gatewayDataplaneNamespace,
			HTTPPort:                  80,
			L4PortRangeStart:          int32(l4PortRangeStart),
			L4PortRangeEnd:            int32(l4PortRangeEnd),
			RDMAIBResource:            rdmaIBResource,
			RDMARoCEResource:          rdmaRoCEResource,
		},
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "DevEnvironment")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("Starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "Failed to run manager")
		os.Exit(1)
	}
}

// validateRDMAResource rejects a --rdma-ib-resource / --rdma-roce-resource value
// the cluster could not honour. The name is copied verbatim into the pod's
// resource map, next to the accelerator resource the environment's gpu field
// selects (gpuResource in internal/controller), so the two names that field can
// produce are rejected here to keep one from silently replacing the other.
func validateRDMAResource(flagName, value string) error {
	// The domain prefix is what makes the name an extended resource. IsLabelKey
	// alone lets through both halves of what that excludes: a bare "example",
	// which pod admission refuses as a non-native resource without a qualifier,
	// and a native "ephemeral-storage" or "hugepages-2Mi", which is accepted and
	// asks the node for storage or huge pages where a device was meant. Neither
	// failure names its cause — the first strands the environment, the second
	// hands it a resource it cannot use — so the slash is required outright.
	if !strings.Contains(value, "/") {
		return fmt.Errorf("--%s must be a domain-qualified extended resource name, e.g. rdma/ib_shared_devices", flagName)
	}
	if errs := content.IsLabelKey(value); len(errs) > 0 {
		return fmt.Errorf("--%s must be a qualified resource name, e.g. rdma/ib_shared_devices: %s",
			flagName, strings.Join(errs, "; "))
	}
	switch value {
	case "cpu", "memory":
		return fmt.Errorf("--%s must name an extended resource, not the native resource %q", flagName, value)
	case "nvidia.com/gpu", "metax-tech.com/gpu":
		return fmt.Errorf("--%s must not name the accelerator resource %q that spec.resources.gpu already requests",
			flagName, value)
	}
	if strings.HasPrefix(value, "requests.") {
		return fmt.Errorf("--%s must not start with %q", flagName, "requests.")
	}
	return nil
}

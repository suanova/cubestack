package devenv

import (
	"fmt"
	"os"
	"time"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// NewScheme is the scheme the conformance client needs: the built-in types (Pods,
// Secrets, Deployments, ServiceAccounts, PersistentVolumeClaims), the platform's
// own API, Gateway API, and CustomResourceDefinitions.
//
// Gateway API is here for ListenerSets. An L4 port is published by adding a
// listener to the environment's ListenerSet, so "the port was released" is a
// statement about that object or it is nothing.
//
// CustomResourceDefinitions are here for the Agent Router check, which is about
// whether a group of CRDs is installed at all — there is no typed client for a
// CRD that is deliberately absent.
func NewScheme() (*runtime.Scheme, error) {
	s := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{
		scheme.AddToScheme,
		aiv1alpha1.AddToScheme,
		gatewayv1.Install,
		apiextensionsv1.AddToScheme,
	} {
		if err := add(s); err != nil {
			return nil, fmt.Errorf("registering scheme: %w", err)
		}
	}
	return s, nil
}

// apiTimeout bounds one request to the API server.
//
// Without it a wedged API server is not a failure but a wait: the preflight runs
// in BeforeSuite, where there is no spec deadline to run out, so a request that
// never comes back stalls the run until the go test timeout and says nothing
// about why. Thirty seconds is two orders of magnitude more than any request
// here takes.
const apiTimeout = 30 * time.Second

// NewClient builds a typed client against the cluster the ambient kubeconfig
// names.
//
// The kubeconfig is deliberately not a parameter. `KUBECONFIG` is how a caller
// names a cluster — the make target passes it, kubectl honours it, and a
// fall-through to ~/.kube/config is what someone running this by hand expects.
// An explicit path argument would be a second way to say the same thing, and the
// two would disagree the first time someone set the variable and not the flag.
func NewClient() (client.Client, error) {
	// An empty path means "use the default loading rules", which is KUBECONFIG
	// and then ~/.kube/config — exactly what kubectl would do.
	cfg, err := clientcmd.BuildConfigFromFlags("", os.Getenv("KUBECONFIG"))
	if err != nil {
		return nil, fmt.Errorf("loading kubeconfig: %w", err)
	}
	cfg.Timeout = apiTimeout
	s, err := NewScheme()
	if err != nil {
		return nil, err
	}
	c, err := client.New(cfg, client.Options{Scheme: s})
	if err != nil {
		return nil, fmt.Errorf("building client: %w", err)
	}
	return c, nil
}

// CurrentContext is the kubeconfig context in effect, for the guard that keeps
// this suite off a cluster it did not mean to touch.
func CurrentContext() (string, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	cfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, nil).RawConfig()
	if err != nil {
		return "", fmt.Errorf("reading kubeconfig: %w", err)
	}
	return cfg.CurrentContext, nil
}

// Command bmc-oem-exporter serves Prometheus metrics for vendor OEM Redfish
// extension fields (currently: PCIeDevices GPU/NIC/RAID info) that community
// exporters like idrac_exporter don't parse. Multi-target ?target=<bmc_ip>
// pattern, same as idrac_exporter/blackbox_exporter. Targets are restricted
// to the BMC_HOSTS allowlist so the shared BMC credentials can only be sent
// to configured BMCs.
package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/suanova/cubestack/observability/bmc-oem-exporter/internal/collector"
	"github.com/suanova/cubestack/observability/bmc-oem-exporter/internal/redfish"
)

const (
	defaultListenAddr = ":9622"
	bmcQueryTimeout   = 10 * time.Second
)

func main() {
	listenAddr := getEnv("LISTEN_ADDR", defaultListenAddr)
	username := os.Getenv("BMC_USERNAME")
	password := os.Getenv("BMC_PASSWORD")
	if username == "" || password == "" {
		log.Fatal("BMC_USERNAME and BMC_PASSWORD must be set")
	}

	// /probe only accepts BMC targets from this allowlist; otherwise the
	// shared credentials could be exfiltrated to any HTTPS endpoint that is
	// reachable from the pod.
	allowed := allowlist(os.Getenv("BMC_HOSTS"))
	if len(allowed) == 0 {
		log.Fatal("BMC_HOSTS must be set to a comma-separated list of allowed BMC targets")
	}

	// BMCs use self-signed certificates by default; TLS verification is
	// skipped only when explicitly opted in via BMC_TLS_SKIP_VERIFY=true.
	skipVerify := os.Getenv("BMC_TLS_SKIP_VERIFY") == "true"

	client := redfish.NewClient(username, password, bmcQueryTimeout, skipVerify)

	http.HandleFunc("/probe", func(w http.ResponseWriter, r *http.Request) {
		target := r.URL.Query().Get("target")
		if target == "" {
			http.Error(w, "target parameter is required", http.StatusBadRequest)
			return
		}
		if !allowed[target] {
			http.Error(w, "target is not in the configured BMC allowlist", http.StatusForbidden)
			return
		}

		registry := prometheus.NewRegistry()
		registry.MustRegister(collector.NewPCIeCollector(client, target))
		promhttp.HandlerFor(registry, promhttp.HandlerOpts{}).ServeHTTP(w, r)
	})

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	log.Printf("bmc-oem-exporter listening on %s (allowlist: %d BMC targets)", listenAddr, len(allowed))
	if err := http.ListenAndServe(listenAddr, nil); err != nil {
		log.Fatal(err)
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// allowlist parses a comma-separated BMC host list into a set for exact
// lookups. Empty entries are ignored.
func allowlist(s string) map[string]bool {
	m := map[string]bool{}
	for _, part := range strings.Split(s, ",") {
		if host := strings.TrimSpace(part); host != "" {
			m[host] = true
		}
	}
	return m
}

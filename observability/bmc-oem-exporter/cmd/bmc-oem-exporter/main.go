// Command bmc-oem-exporter serves Prometheus metrics for vendor OEM Redfish
// extension fields (currently: PCIeDevices GPU/NIC/RAID info) that community
// exporters like idrac_exporter don't parse. Multi-target ?target=<bmc_ip>
// pattern, same as idrac_exporter/blackbox_exporter.
package main

import (
	"log"
	"net/http"
	"os"
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

	client := redfish.NewClient(username, password, bmcQueryTimeout)

	http.HandleFunc("/probe", func(w http.ResponseWriter, r *http.Request) {
		target := r.URL.Query().Get("target")
		if target == "" {
			http.Error(w, "target parameter is required", http.StatusBadRequest)
			return
		}

		registry := prometheus.NewRegistry()
		registry.MustRegister(collector.NewPCIeCollector(client, target))
		promhttp.HandlerFor(registry, promhttp.HandlerOpts{}).ServeHTTP(w, r)
	})

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	log.Printf("bmc-oem-exporter listening on %s", listenAddr)
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

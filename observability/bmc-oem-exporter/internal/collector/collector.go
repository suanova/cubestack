// Package collector turns Redfish PCIeDevices data into Prometheus metrics
// for a single BMC target, in the style of a per-scrape Collector (same
// pattern as blackbox_exporter/idrac_exporter's ?target= probe handlers).
package collector

import (
	"context"
	"fmt"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/suanova/cubestack/observability/bmc-oem-exporter/internal/redfish"
)

// Chassis IDs to probe on a BMC. C500 exposes PCIeDevices under chassis "1".
// Kept as a slice so future hardware types with multiple chassis (e.g. a
// super node) can add more without changing the collection logic.
var chassisIDs = []string{"1"}

type PCIeCollector struct {
	client *redfish.Client
	bmcIP  string

	info             *prometheus.Desc
	health           *prometheus.Desc
	present          *prometheus.Desc
	gpuPowerWatts    *prometheus.Desc
	gpuPowerCapacity *prometheus.Desc
	gpuMemorySizeMiB *prometheus.Desc
	scrapeSuccess    *prometheus.Desc
}

func NewPCIeCollector(client *redfish.Client, bmcIP string) *PCIeCollector {
	labels := []string{"bmc_ip", "chassis", "position", "card_type"}
	infoLabels := append(labels, "manufacturer", "model", "chip_manufacturer", "chip_model", "firmware_version", "serial_number")
	gpuLabels := []string{"bmc_ip", "chassis", "position"}

	return &PCIeCollector{
		client: client,
		bmcIP:  bmcIP,

		info: prometheus.NewDesc(
			"bmc_pcie_device_info",
			"PCIe device identity information (GPU/NIC/RAID/etc), value is always 1.",
			infoLabels, nil,
		),
		health: prometheus.NewDesc(
			"bmc_pcie_device_health",
			"PCIe device health, 1=OK, 0=Warning/Critical.",
			labels, nil,
		),
		present: prometheus.NewDesc(
			"bmc_pcie_device_present",
			"PCIe device presence, 1=Enabled, 0=otherwise.",
			labels, nil,
		),
		gpuPowerWatts: prometheus.NewDesc(
			"bmc_gpu_power_watts",
			"GPU card power draw as reported by BMC out-of-band, card_type=GPU only.",
			gpuLabels, nil,
		),
		gpuPowerCapacity: prometheus.NewDesc(
			"bmc_gpu_power_capacity_watts",
			"GPU card rated power capacity as reported by BMC out-of-band, card_type=GPU only.",
			gpuLabels, nil,
		),
		gpuMemorySizeMiB: prometheus.NewDesc(
			"bmc_gpu_memory_size_mib",
			"GPU card memory size in MiB as reported by BMC out-of-band, card_type=GPU only.",
			gpuLabels, nil,
		),
		scrapeSuccess: prometheus.NewDesc(
			"bmc_pcie_scrape_success",
			"1 if the PCIeDevices Redfish query for this BMC succeeded, 0 otherwise.",
			[]string{"bmc_ip", "chassis"}, nil,
		),
	}
}

func (c *PCIeCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.info
	ch <- c.health
	ch <- c.present
	ch <- c.gpuPowerWatts
	ch <- c.gpuPowerCapacity
	ch <- c.gpuMemorySizeMiB
	ch <- c.scrapeSuccess
}

func (c *PCIeCollector) Collect(ch chan<- prometheus.Metric) {
	ctx := context.Background()

	for _, chassis := range chassisIDs {
		devices, err := c.client.FetchPCIeDevices(ctx, c.bmcIP, chassis)
		if err != nil {
			ch <- prometheus.MustNewConstMetric(c.scrapeSuccess, prometheus.GaugeValue, 0, c.bmcIP, chassis)
			continue
		}
		ch <- prometheus.MustNewConstMetric(c.scrapeSuccess, prometheus.GaugeValue, 1, c.bmcIP, chassis)

		for _, dev := range devices {
			c.collectDevice(ch, chassis, dev)
		}
	}
}

func (c *PCIeCollector) collectDevice(ch chan<- prometheus.Metric, chassis string, dev redfish.PCIeDevice) {
	cardType := dev.Oem.Public.PCIeCardType
	if cardType == "" {
		cardType = "unknown"
	}
	position := fmt.Sprintf("%d", dev.Oem.Public.Position)

	ch <- prometheus.MustNewConstMetric(
		c.info, prometheus.GaugeValue, 1,
		c.bmcIP, chassis, position, cardType,
		dev.Manufacturer, dev.Model, dev.Oem.Public.ChipManufacturer, dev.Oem.Public.ChipModel,
		dev.FirmwareVersion, dev.SerialNumber,
	)

	healthValue := 0.0
	if dev.Status.Health == "OK" {
		healthValue = 1.0
	}
	ch <- prometheus.MustNewConstMetric(c.health, prometheus.GaugeValue, healthValue, c.bmcIP, chassis, position, cardType)

	presentValue := 0.0
	if dev.Status.State == "Enabled" {
		presentValue = 1.0
	}
	ch <- prometheus.MustNewConstMetric(c.present, prometheus.GaugeValue, presentValue, c.bmcIP, chassis, position, cardType)

	if cardType != "GPU" {
		return
	}

	if dev.Oem.Public.PowerWatts != nil {
		ch <- prometheus.MustNewConstMetric(c.gpuPowerWatts, prometheus.GaugeValue, *dev.Oem.Public.PowerWatts, c.bmcIP, chassis, position)
	}
	if dev.Oem.Public.PowerCapacityWatts != nil {
		ch <- prometheus.MustNewConstMetric(c.gpuPowerCapacity, prometheus.GaugeValue, *dev.Oem.Public.PowerCapacityWatts, c.bmcIP, chassis, position)
	}
	if dev.Oem.Public.MemorySizeMiB != nil {
		ch <- prometheus.MustNewConstMetric(c.gpuMemorySizeMiB, prometheus.GaugeValue, float64(*dev.Oem.Public.MemorySizeMiB), c.bmcIP, chassis, position)
	}
}

// Package redfish fetches vendor OEM extension fields from a BMC's Redfish
// PCIeDevices collection. Standard Redfish fields (Thermal/Power/Sensors) are
// already covered by idrac_exporter; this package only covers the
// Oem.Public.* fields that community exporters don't parse.
package redfish

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// PCIeDevice is the generic shape shared by every card type (GPU/NIC/RAID)
// observed on the H3C AST2600 BMC. GPU-specific fields live in Oem.Public
// and are only populated when PCIeCardType == "GPU".
type PCIeDevice struct {
	CardManufacturer string `json:"CardManufacturer"`
	CardModel        string `json:"CardModel"`
	Manufacturer     string `json:"Manufacturer"`
	Model            string `json:"Model"`
	PartNumber       string `json:"PartNumber"`
	SerialNumber     string `json:"SerialNumber"`
	FirmwareVersion  string `json:"FirmwareVersion"`
	Status           struct {
		Health string `json:"Health"`
		State  string `json:"State"`
	} `json:"Status"`
	Oem struct {
		Public struct {
			PCIeCardType     string `json:"PCIeCardType"`
			ChipManufacturer string `json:"ChipManufacturer"`
			ChipModel        string `json:"ChipModel"`
			DeviceLocator    string `json:"DeviceLocator"`
			Position         int    `json:"Position"`
			SlotNumber       int    `json:"SlotNumber"`
			MezzSlot         int    `json:"MezzSlot"`

			// GPU-only fields, present when PCIeCardType == "GPU".
			PowerWatts         *float64 `json:"PowerWatts"`
			PowerCapacityWatts *float64 `json:"PowerCapacityWatts"`
			MemorySizeMiB      *int64   `json:"MemorySizeMiB"`
		} `json:"Public"`
	} `json:"Oem"`
}

type pcieDeviceCollection struct {
	Members []PCIeDevice `json:"Members"`
}

// Client queries a single BMC's Redfish PCIeDevices collection over HTTPS
// with basic auth. BMCs use self-signed certificates by default, so TLS
// verification is skipped only when the operator explicitly opts in via
// skipVerify (chart value bmcOemExporter.tlsInsecure / BMC_TLS_SKIP_VERIFY).
type Client struct {
	httpClient *http.Client
	username   string
	password   string
}

func NewClient(username, password string, timeout time.Duration, skipVerify bool) *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: skipVerify}, //nolint:gosec // opt-in for BMC self-signed certs
			},
		},
		username: username,
		password: password,
	}
}

// FetchPCIeDevices retrieves all PCIe devices for the given chassis in a
// single request via $expand=. (verified: avoids N+1 per-device calls).
func (c *Client) FetchPCIeDevices(ctx context.Context, bmcIP, chassis string) ([]PCIeDevice, error) {
	url := fmt.Sprintf("https://%s/redfish/v1/Chassis/%s/PCIeDevices?$expand=.", bmcIP, chassis)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.SetBasicAuth(c.username, c.password)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("query %s: unexpected status %d", url, resp.StatusCode)
	}

	var collection pcieDeviceCollection
	if err := json.NewDecoder(resp.Body).Decode(&collection); err != nil {
		return nil, fmt.Errorf("decode response from %s: %w", url, err)
	}

	return collection.Members, nil
}

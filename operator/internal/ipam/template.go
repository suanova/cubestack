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
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

// DefaultCNIType is used when a NADTemplate does not name a plugin type. It is
// the linux bridge binding KubeVirt's virt-launcher uses on this cluster's
// underlay, and mirrors the CRD's own default for the field.
const DefaultCNIType = "cnv-bridge"

// staticIPAM is the CNI plugin a minted NAD names as its ipam.
//
// It copies the addresses it is given and arbitrates nothing, which is exactly
// what this layer needs: two pods must be able to hold one address at once for
// live migration to work (design §10.1), so an allocator inside the CNI is
// disqualified. Exclusivity is the allocator's job — the single writer over the
// pool's range — and the audit's DuplicateAddress is what catches a violation.
const staticIPAM = "static"

// nadConfig mirrors the NetworkAttachmentDefinition spec.config this project
// generates. It is a separate type from v1alpha1.NADTemplate because the two have
// genuinely different shapes: the template omits everything the controller
// injects, and the output includes fields the template has no say over.
//
// Field order matters only in that encoding/json emits it in declaration order,
// which is what makes the rendered output stable enough to golden-test.
type nadConfig struct {
	Name        string        `json:"name"`
	Type        string        `json:"type"`
	Bridge      string        `json:"bridge"`
	VLAN        *int32        `json:"vlan,omitempty"`
	MacSpoofChk *bool         `json:"macspoofchk,omitempty"`
	IPAM        nadIPAMStatic `json:"ipam"`
	DNS         *nadDNS       `json:"dns,omitempty"`
}

// nadIPAMStatic is the ipam block for a static assignment: the address is written
// in, and nothing arbitrates it.
type nadIPAMStatic struct {
	Type      string       `json:"type"`
	Addresses []nadAddress `json:"addresses"`
	Routes    []nadRoute   `json:"routes,omitempty"`
}

// nadAddress is one entry of the static plugin's address list. The address
// carries its own prefix length, which is why the assigned address alone is not
// enough to render one: the mask comes from the template's subnet.
type nadAddress struct {
	Address string `json:"address"`
	Gateway string `json:"gateway,omitempty"`
}

type nadDNS struct {
	Nameservers []string `json:"nameservers,omitempty"`
	Domain      string   `json:"domain,omitempty"`
	Search      []string `json:"search,omitempty"`
}

type nadRoute struct {
	Dst string `json:"dst"`
	GW  string `json:"gw,omitempty"`
}

// RenderNAD builds the spec.config of the per-claim NetworkAttachmentDefinition.
//
// This NAD serves addr and no other, and that invariant is upheld by the
// allocator, which is the sole writer over the pool's range. The address is baked
// into the config as a literal assignment rather than leased from a CNI-side
// ledger, so two pods may hold it at once — which is precisely what live
// migration needs, and why there is no mode to choose between (design §10.1).
//
// tmpl may not be nil: a pool without a template cannot mint, and the caller is
// expected to have reported that as a TemplateMissing reason already. The subnet
// and gateway come from the template itself, so there is no way to render a
// config whose addressing disagrees with the pool's declaration.
func RenderNAD(tmpl *ipamv1alpha1.NADTemplate, name string, addr netip.Addr) (string, error) {
	if tmpl == nil {
		return "", errors.New("pool has no nadTemplate, so no NAD can be rendered")
	}
	if name == "" {
		return "", errors.New("NAD name is empty")
	}
	if tmpl.Bridge == "" {
		return "", errors.New("nadTemplate.bridge is empty")
	}
	if tmpl.Subnet == "" {
		return "", errors.New("nadTemplate.subnet is empty")
	}
	if tmpl.Gateway == "" {
		return "", errors.New("nadTemplate.gateway is empty")
	}

	// The CRD requires an IPv4 pattern on the address, so these are defence
	// against objects that predate the schema rather than against user error.
	if !addr.Is4() {
		return "", fmt.Errorf("assigned address %q is not IPv4; this claim layer is IPv4-only", addr)
	}
	prefix, err := netip.ParsePrefix(tmpl.Subnet)
	if err != nil {
		return "", fmt.Errorf("nadTemplate.subnet %q is not a valid CIDR: %w", tmpl.Subnet, err)
	}
	if !prefix.Contains(addr) {
		return "", fmt.Errorf("assigned address %s is outside subnet %s", addr, prefix)
	}
	if _, err := netip.ParseAddr(tmpl.Gateway); err != nil {
		return "", fmt.Errorf("nadTemplate.gateway %q is not a valid address: %w", tmpl.Gateway, err)
	}

	cfg := nadConfig{
		Name:        name,
		Type:        cniType(tmpl),
		Bridge:      tmpl.Bridge,
		VLAN:        tmpl.VLAN,
		MacSpoofChk: tmpl.MacSpoofChk,
		IPAM: nadIPAMStatic{
			Type: staticIPAM,
			Addresses: []nadAddress{{
				// The mask comes from the template's subnet: it is the only place the
				// prefix length is declared, and the static plugin wants a CIDR rather
				// than a bare address.
				Address: netip.PrefixFrom(addr, prefix.Bits()).String(),
				Gateway: tmpl.Gateway,
			}},
			Routes: routes(tmpl.Routes),
		},
	}
	if tmpl.DNS != nil {
		cfg.DNS = &nadDNS{
			Nameservers: tmpl.DNS.Nameservers,
			Domain:      tmpl.DNS.Domain,
			Search:      tmpl.DNS.Search,
		}
	}

	out, err := json.Marshal(cfg)
	if err != nil {
		return "", fmt.Errorf("rendering NAD config: %w", err)
	}
	return string(out), nil
}

func cniType(tmpl *ipamv1alpha1.NADTemplate) string {
	if tmpl.Type == "" {
		return DefaultCNIType
	}
	return tmpl.Type
}

func routes(in []ipamv1alpha1.NADRoute) []nadRoute {
	if len(in) == 0 {
		return nil
	}
	out := make([]nadRoute, 0, len(in))
	for _, r := range in {
		out = append(out, nadRoute{Dst: r.Dst, GW: r.GW})
	}
	return out
}

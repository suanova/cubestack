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
	"errors"
	"strings"
	"testing"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

// validSpec is a minting pool: a band on the 10.66.3.0/24 underlay, the shape the
// design proposes in §10.3. Whether that band is disjoint from other NADs on the
// same subnet is not checkable from this object, so the band here is merely
// coherent with its own template.
func validSpec() ipamv1alpha1.IPPoolSpec {
	return ipamv1alpha1.IPPoolSpec{
		Range: ipamv1alpha1.IPRange{Start: testBandStart, End: testBandEnd},
		NADTemplate: &ipamv1alpha1.NADTemplate{
			Subnet:  testSubnet,
			Gateway: testGateway,
			Bridge:  testBridge,
		},
	}
}

func TestValidatePoolRange(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*ipamv1alpha1.IPPoolSpec)
		wantErr string // substring; empty means no error expected
	}{
		{
			name:   "valid band",
			mutate: func(*ipamv1alpha1.IPPoolSpec) {},
		},
		{
			// A single-address band is the shape the controller will mint per-VM
			// NADs from, so it must validate.
			name: "single address band",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Range.Start = testBelowBand
				s.Range.End = testBelowBand
			},
		},
		{
			// The check CEL cannot express: IP ordering.
			name: "reversed range",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Range.Start = testBandEnd
				s.Range.End = testBandStart
			},
			wantErr: "must not be greater than",
		},
		{
			name: "gateway inside the range",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Gateway = testInsideMid
			},
			wantErr: "must not fall inside",
		},
		{
			// Boundary: a gateway equal to a bound is still inside.
			name: "gateway equal to range start",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Gateway = testBandStart
			},
			wantErr: "must not fall inside",
		},
		{
			name: "gateway above the range is fine",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Gateway = "10.66.3.190"
			},
		},
		{
			// The check that only appeared once the gateway was known to have to be
			// on-link: outside the band (so the range check passes) but in another
			// subnet entirely, which a bridge binding cannot reach.
			name: "gateway outside the subnet",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Gateway = "10.66.9.254"
			},
			wantErr: "must lie within subnet",
		},
		{
			// Lower than end, so containment is the only rule this can trip —
			// keeping the two checks independently observable.
			name: "start outside subnet",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Range.Start = "10.66.2.10"
			},
			wantErr: "must lie entirely within",
		},
		{
			name: "end outside subnet",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Range.End = "10.66.4.10"
			},
			wantErr: "must lie entirely within",
		},
		{
			// Inside the subnet, but the subnet's own name: no host can answer for it.
			name: "range starts at the network address",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Subnet = "10.66.9.0/24"
				s.NADTemplate.Gateway = "10.66.9.254"
				s.Range.Start = "10.66.9.0"
				s.Range.End = "10.66.9.20"
			},
			wantErr: "network address",
		},
		{
			name: "range ends at the broadcast address",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Range.End = "10.66.3.255"
			},
			wantErr: "broadcast address",
		},
		{
			// RFC 3021: a /31 has no network or broadcast address — both of its
			// addresses are usable hosts — so the rule above must not fire here.
			name: "both /31 addresses are assignable",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Subnet = "10.66.11.0/31"
				s.NADTemplate.Gateway = "10.66.11.1"
				s.Range.Start = "10.66.11.0"
				s.Range.End = "10.66.11.0"
			},
		},
		{
			name: "subnet is not a CIDR",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Subnet = "10.66.3.0"
			},
			wantErr: testInvalidCIDR,
		},
		{
			name: "malformed start",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Range.Start = testInvalidIP
			},
			wantErr: testInvalidIPMessage,
		},
		{
			name: "IPv6 is rejected",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Subnet = "fd00::/64"
				s.NADTemplate.Gateway = "fd00::ffff"
				s.Range.Start = "fd00::1"
				s.Range.End = "fd00::10"
			},
			wantErr: "IPv4-only",
		},

		// A template that is present but incomplete. The CRD requires these fields,
		// but the function must still cope: a CRD update admits objects the previous
		// schema would have rejected, and those reach the reconciler unchanged.
		{
			name: "template with no subnet",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Subnet = ""
			},
			wantErr: "nadTemplate.subnet is required",
		},
		{
			name: "template with no gateway",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Gateway = ""
			},
			wantErr: "nadTemplate.gateway is required",
		},

		// spec.exclude. None of its ordering properties are expressible as schema
		// rules either, and a list that went backwards would leave "first match wins"
		// as a rule nobody wrote down — so the list must ascend and not touch.
		{
			name: "a coherent exclude band",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{{Start: testInsideMid, End: testInsideHigh}}
			},
		},
		{
			name: "several ascending exclude bands",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{
					{Start: testBandStart, End: testBandStart},
					{Start: testInsideMid, End: testInsideHigh},
				}
			},
		},
		{
			name: "reversed exclude band",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{{Start: testInsideHigh, End: testInsideMid}}
			},
			wantErr: "must not be greater than",
		},
		{
			name: "exclude band starting before the range",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{{Start: "10.66.3.140", End: testInsideLow}}
			},
			wantErr: "must lie within range",
		},
		{
			name: "exclude band ending after the range",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{{Start: "10.66.3.185", End: "10.66.3.195"}}
			},
			wantErr: "must lie within range",
		},
		{
			name: "exclude bands out of order",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{
					{Start: testInsideMid, End: testInsideHigh},
					{Start: testBandStart, End: testInsideLow},
				}
			},
			wantErr: "must ascend",
		},
		{
			// Adjacent bands are as harmless as one band written in two pieces, but
			// rejecting them keeps the list canonical: one shape per set.
			name: "overlapping exclude bands",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{
					{Start: testBandStart, End: testInsideLow},
					{Start: testInsideLow, End: "10.66.3.159"},
				}
			},
			wantErr: "must ascend",
		},
		{
			name: "malformed exclude bound",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{{Start: testInvalidIP, End: testInsideHigh}}
			},
			wantErr: testInvalidIPMessage,
		},
		{
			// Well formed and empty rather than malformed: reported under its own
			// reason so the fix reads as "widen the range or narrow the exclusions".
			name: "exclusions cover the whole range",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.Exclude = []ipamv1alpha1.IPRange{{Start: testBandStart, End: testBandEnd}}
			},
			wantErr: "exclusions cover its entire range",
		},

		// Routes reach the CNI verbatim and the static plugin rejects a destination it
		// cannot parse — at network setup, which is after the claim said Ready. The
		// template has to be refused before then.
		{
			name: "a valid route",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Routes = []ipamv1alpha1.NADRoute{{Dst: testRouteCIDR, GW: testGateway}}
			},
		},
		{
			name: "a route with no gateway",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Routes = []ipamv1alpha1.NADRoute{{Dst: testRouteCIDR}}
			},
		},
		{
			name: "a route destination that is not a CIDR",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Routes = []ipamv1alpha1.NADRoute{{Dst: "not-a-cidr"}}
			},
			wantErr: testInvalidCIDR,
		},
		{
			name: "a route gateway that is not an address",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Routes = []ipamv1alpha1.NADRoute{{Dst: testRouteCIDR, GW: "nowhere"}}
			},
			wantErr: "not a valid address",
		},
		{
			// ParseAddr accepts fe80::1%eth0; the static plugin, which parses route
			// gateways as bare addresses, does not.
			name: "a route gateway with a zone",
			mutate: func(s *ipamv1alpha1.IPPoolSpec) {
				s.NADTemplate.Routes = []ipamv1alpha1.NADRoute{{Dst: testRouteCIDR, GW: "fe80::1%eth0"}}
			},
			wantErr: "must not carry a zone",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spec := validSpec()
			tt.mutate(&spec)

			err := ValidatePoolRange(spec)
			switch {
			case tt.wantErr == "" && err != nil:
				t.Fatalf("expected no error, got: %v", err)
			case tt.wantErr != "" && err == nil:
				t.Fatalf("expected an error containing %q, got nil", tt.wantErr)
			case tt.wantErr != "" && !strings.Contains(err.Error(), tt.wantErr):
				t.Fatalf("expected an error containing %q, got: %v", tt.wantErr, err)
			}
		})
	}
}

// A pool whose whole band is excluded is well formed and merely empty, so it has
// to be distinguishable from a malformed one: the two go under different reasons,
// and the fix differs. The sentinel is what the caller keys on.
func TestValidatePoolRange_FullyExcluded(t *testing.T) {
	spec := validSpec()
	spec.Exclude = []ipamv1alpha1.IPRange{
		{Start: testBandStart, End: testInsideMid},
		{Start: "10.66.3.161", End: testBandEnd},
	}

	err := ValidatePoolRange(spec)
	if !errors.Is(err, ErrRangeFullyExcluded) {
		t.Fatalf("expected ErrRangeFullyExcluded, got: %v", err)
	}

	// One address left over is enough to make the pool usable: the check is over the
	// candidate set, not over how much of it was excluded.
	spec.Exclude[1].End = "10.66.3.188"
	if err := ValidatePoolRange(spec); err != nil {
		t.Fatalf("a pool with one free address should be valid: %v", err)
	}
}

// A pool with no nadTemplate allocates addresses and mints nothing, so it has no
// subnet and no gateway to be incoherent. This is the minimal form of the API:
// spec.range is the only required field, and for a ledger-only pool it is the only
// field at all.
func TestValidatePoolRange_LedgerOnly(t *testing.T) {
	ledgerOnly := func() ipamv1alpha1.IPPoolSpec {
		return ipamv1alpha1.IPPoolSpec{
			Range: ipamv1alpha1.IPRange{Start: testBandStart, End: testBandEnd},
		}
	}

	t.Run("a bare band is valid", func(t *testing.T) {
		if err := ValidatePoolRange(ledgerOnly()); err != nil {
			t.Fatalf("a pool with only a range should be valid: %v", err)
		}
	})

	t.Run("a single-address band is valid", func(t *testing.T) {
		spec := ledgerOnly()
		spec.Range.End = spec.Range.Start
		if err := ValidatePoolRange(spec); err != nil {
			t.Fatalf("a single-address ledger-only pool should be valid: %v", err)
		}
	})

	// Having no template excuses the pool from gateway and subnet checks — not from
	// being a coherent band, which is the one thing it still has to be.
	t.Run("a reversed band is still rejected", func(t *testing.T) {
		spec := ledgerOnly()
		spec.Range.Start, spec.Range.End = spec.Range.End, spec.Range.Start
		if err := ValidatePoolRange(spec); err == nil {
			t.Fatal("expected a reversed range to be rejected")
		}
	})

	t.Run("a malformed bound is still rejected", func(t *testing.T) {
		spec := ledgerOnly()
		spec.Range.End = "not-an-ip"
		if err := ValidatePoolRange(spec); err == nil {
			t.Fatal("expected a malformed range.end to be rejected")
		}
	})

	t.Run("an IPv6 band is still rejected", func(t *testing.T) {
		spec := ledgerOnly()
		spec.Range.Start = "fd00::1"
		spec.Range.End = "fd00::10"
		err := ValidatePoolRange(spec)
		if err == nil || !strings.Contains(err.Error(), "IPv4-only") {
			t.Fatalf("expected an IPv4-only error, got: %v", err)
		}
	})
}

// The design's own pools must pass, or the defaults in config/samples are wrong.
func TestValidatePoolRange_DesignSamples(t *testing.T) {
	for _, spec := range []ipamv1alpha1.IPPoolSpec{
		{
			Range: ipamv1alpha1.IPRange{Start: testBandStart, End: testBandEnd},
			NADTemplate: &ipamv1alpha1.NADTemplate{
				Subnet:  testSubnet,
				Gateway: testGateway,
				Bridge:  testBridge,
			},
		},
		{
			// The user guide's alternative band (design R5 notes the docs disagree).
			Range: ipamv1alpha1.IPRange{Start: "10.66.3.181", End: "10.66.3.199"},
			NADTemplate: &ipamv1alpha1.NADTemplate{
				Subnet:  testSubnet,
				Gateway: testGateway,
				Bridge:  testBridge,
			},
		},
	} {
		if err := ValidatePoolRange(spec); err != nil {
			t.Errorf("pool %s-%s should be valid: %v", spec.Range.Start, spec.Range.End, err)
		}
	}
}

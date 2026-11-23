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

// Package ipam holds the pure address and config logic behind the IPPool/IPClaim
// claim layer.
//
// Nothing here touches a cluster. That is deliberate: the parts most likely to be
// wrong — address arithmetic, the shape of a generated NAD — are the parts that
// are hardest to observe from the outside and easiest to get subtly wrong, so they
// live where they can be tested directly. Nothing in the CNI enforces an
// allocation here, so a mistake surfaces as a VM that will not start — or, worse,
// as two VMs quietly sharing an address — rather than as an error at the point of
// the mistake.
package ipam

import (
	"errors"
	"fmt"
	"net/netip"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

// ErrRangeFullyExcluded reports a pool whose exclusions cover its whole range.
//
// Its own sentinel because the pool is not malformed — an admin took every address
// out of use on purpose — so it reports its own reason (RangeFullyExcluded) rather
// than the RangeInvalid that a misordered or out-of-band exclusion gets.
var ErrRangeFullyExcluded = errors.New("pool exclusions cover its entire range")

// ValidatePoolRange checks the IPPool invariants that cannot be expressed as
// schema rules.
//
// The Kubernetes CEL net library provides cidr(...).containsIP(ip(...)) but no
// ordering overload on IP values, so "start <= end", "gateway must not fall
// inside the range", "gateway must sit inside the subnet" and every ordering
// property of the exclude list cannot be CEL validations however they are written.
// They are checked here instead.
//
// The subnet containment of the range IS also a schema rule; it is repeated here
// so this function is safe on objects that never went through the current schema
// (created before it existed, or admitted while the CRD was mid-update).
//
// spec.range is the only required field: a pool with no nadTemplate allocates
// addresses and mints no config, so it has no subnet or gateway to check. When
// the template IS present, its addressing is validated in full — the template's
// fields are required by the schema, but this function must still cope with a
// template that is present and incomplete, because a CRD update can admit one
// that the old schema would not have.
//
// This is a pure function: no cluster access, no allocation, no side effects.
func ValidatePoolRange(spec ipamv1alpha1.IPPoolSpec) error {
	// Parsed explicitly rather than via a helper so each error names its own field.
	start, err := netip.ParseAddr(spec.Range.Start)
	if err != nil {
		return fmt.Errorf("range.start %q is not a valid address: %w", spec.Range.Start, err)
	}
	end, err := netip.ParseAddr(spec.Range.End)
	if err != nil {
		return fmt.Errorf("range.end %q is not a valid address: %w", spec.Range.End, err)
	}
	if !start.Is4() || !end.Is4() {
		return fmt.Errorf("range %s-%s is not IPv4; this claim layer is IPv4-only", start, end)
	}

	// netip.Addr.Compare orders by address value, which is what makes this check
	// possible in Go and impossible in CEL.
	if start.Compare(end) > 0 {
		return fmt.Errorf("range.start %s must not be greater than range.end %s", start, end)
	}

	if err := validateExcludes(spec.Exclude, start, end); err != nil {
		return err
	}

	if tmpl := spec.NADTemplate; tmpl != nil {
		if err := validateTemplate(tmpl, start, end); err != nil {
			return err
		}
	}

	// Last, because every check above describes a field that is wrong, and a
	// fully-excluded band is a pool that is merely empty. Reporting the empty band
	// first would send the reader looking at the exclusions when the real mistake
	// is upstream of them.
	empty, err := fullyExcluded(spec, start, end)
	if err != nil {
		return err
	}
	if empty {
		return fmt.Errorf("%w: %s-%s", ErrRangeFullyExcluded, start, end)
	}

	return nil
}

// validateExcludes checks the ordering properties of the exclusion list that the
// schema cannot: each band is coherent and inside the range, and the bands ascend
// without touching.
//
// Ascending and disjoint is required rather than merely tidied up: the allocator
// derives candidates by subtracting these bands, and a list that goes backwards
// would make "later exclusion wins" or "first match wins" a rule nobody wrote
// down. Rejecting the object says which rule applies — there is none.
func validateExcludes(excludes []ipamv1alpha1.IPRange, start, end netip.Addr) error {
	var prevEnd netip.Addr
	for i, band := range excludes {
		s, err := netip.ParseAddr(band.Start)
		if err != nil {
			return fmt.Errorf("exclude[%d].start %q is not a valid address: %w", i, band.Start, err)
		}
		e, err := netip.ParseAddr(band.End)
		if err != nil {
			return fmt.Errorf("exclude[%d].end %q is not a valid address: %w", i, band.End, err)
		}
		if !s.Is4() || !e.Is4() {
			return fmt.Errorf("exclude[%d] %s-%s is not IPv4; this claim layer is IPv4-only", i, s, e)
		}
		if s.Compare(e) > 0 {
			return fmt.Errorf("exclude[%d].start %s must not be greater than exclude[%d].end %s", i, s, i, e)
		}
		if s.Compare(start) < 0 || e.Compare(end) > 0 {
			return fmt.Errorf("exclude[%d] %s-%s must lie within range %s-%s", i, s, e, start, end)
		}
		if i > 0 && s.Compare(prevEnd) <= 0 {
			return fmt.Errorf("exclude[%d] %s-%s must start after exclude[%d] ends at %s: "+
				"the list must ascend and its bands must not overlap", i, s, e, i-1, prevEnd)
		}
		prevEnd = e
	}
	return nil
}

// validateTemplate checks the addressing of a pool's NAD template against its
// range: containment in both directions, and a gateway that is inside the subnet
// but outside the allocatable band.
func validateTemplate(tmpl *ipamv1alpha1.NADTemplate, start, end netip.Addr) error {
	if tmpl.Subnet == "" {
		return errors.New("nadTemplate.subnet is required when nadTemplate is set")
	}
	if tmpl.Gateway == "" {
		return errors.New("nadTemplate.gateway is required when nadTemplate is set")
	}

	subnet, err := netip.ParsePrefix(tmpl.Subnet)
	if err != nil {
		return fmt.Errorf("nadTemplate.subnet %q is not a valid CIDR: %w", tmpl.Subnet, err)
	}
	if !subnet.Addr().Is4() {
		return fmt.Errorf("nadTemplate.subnet %q is not IPv4; this claim layer is IPv4-only", tmpl.Subnet)
	}
	gateway, err := netip.ParseAddr(tmpl.Gateway)
	if err != nil {
		return fmt.Errorf("nadTemplate.gateway %q is not a valid address: %w", tmpl.Gateway, err)
	}
	if !gateway.Is4() {
		return fmt.Errorf("nadTemplate.gateway %s is not IPv4; this claim layer is IPv4-only", gateway)
	}

	// Containment is checked before the gateway's own position: an address outside
	// the subnet is the more fundamental mistake, and reporting a gateway problem
	// for 10.66.4.10-10.66.3.189 would send the reader looking in the wrong place.
	if !subnet.Contains(start) || !subnet.Contains(end) {
		return fmt.Errorf("range %s-%s must lie entirely within subnet %s", start, end, subnet)
	}

	// The gateway must sit OUTSIDE the allocatable band: overlapping it means the
	// pool can hand a VM the gateway's own address, which fails in a way that looks
	// like a broken network rather than a bad pool.
	if gateway.Compare(start) >= 0 && gateway.Compare(end) <= 0 {
		return fmt.Errorf("gateway %s must not fall inside the allocatable range %s-%s", gateway, start, end)
	}

	// ...and INSIDE the subnet. A bridge binding needs the gateway on the same L2
	// as the VM, so an off-subnet gateway produces a default route that nothing can
	// resolve: the guest keeps its address, CNI ADD succeeds, and every off-link
	// flow black-holes. Checking only the "not in the band" half would admit exactly
	// that, since an address in another subnet is trivially outside the band.
	if !subnet.Contains(gateway) {
		return fmt.Errorf("gateway %s must lie within subnet %s", gateway, subnet)
	}

	return nil
}

// fullyExcluded reports whether nothing in the band survives the exclusions.
//
// Computed from the candidate set rather than from lengths: the bands are known to
// lie inside the range and not to overlap by the time this runs, so the two agree —
// but expressing it as "the set of addresses the allocator would consider is empty"
// is the statement that has to be true, and it stays true if either of those
// properties is ever relaxed.
func fullyExcluded(spec ipamv1alpha1.IPPoolSpec, start, end netip.Addr) (bool, error) {
	all, err := ParseRange(start.String(), end.String())
	if err != nil {
		return false, err
	}
	excluded := make(map[netip.Addr]struct{})
	for _, band := range spec.Exclude {
		addrs, err := ParseRange(band.Start, band.End)
		if err != nil {
			return false, err
		}
		for _, a := range addrs {
			excluded[a] = struct{}{}
		}
	}
	for _, a := range all {
		if _, isExcluded := excluded[a]; !isExcluded {
			return false, nil
		}
	}
	return true, nil
}

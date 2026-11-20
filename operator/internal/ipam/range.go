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
	"fmt"
	"net/netip"
)

// maxRangeSize bounds how large a pool band may be.
//
// ParseRange materializes the band, so an unbounded one is a memory hazard: a
// typed-in 0.0.0.0-255.255.255.255 would be four billion netip.Addr. The real
// bands are sub-/24s, tens of addresses, so a /16 ceiling is far above any
// legitimate use and still small enough to hold comfortably.
const maxRangeSize = 1 << 16

// ParseRange expands an inclusive address band into its addresses, lowest first.
//
// Both bounds are inclusive, and start == end is legal — that is the
// single-address shape this project generates NADs from.
//
// Callers should have run ValidatePoolRange first. ParseRange still rejects an
// inverted band rather than returning an empty slice, because an empty result and
// an exhausted band are indistinguishable at the call site and mean opposite
// things: one is a malformed pool, the other a full one.
func ParseRange(start, end string) ([]netip.Addr, error) {
	s, err := netip.ParseAddr(start)
	if err != nil {
		return nil, fmt.Errorf("range start %q is not a valid address: %w", start, err)
	}
	e, err := netip.ParseAddr(end)
	if err != nil {
		return nil, fmt.Errorf("range end %q is not a valid address: %w", end, err)
	}
	if s.Compare(e) > 0 {
		return nil, fmt.Errorf("range start %s is greater than range end %s", s, e)
	}

	addrs := make([]netip.Addr, 0, 1)
	// The IsValid check is load-bearing: Addr.Next() returns the zero Addr past
	// 255.255.255.255, and an invalid Addr compares less than a valid one, so
	// without it the loop would never terminate on a band ending at the top of the
	// address space.
	for a := s; a.IsValid() && a.Compare(e) <= 0; a = a.Next() {
		if len(addrs) >= maxRangeSize {
			return nil, fmt.Errorf("range %s-%s holds more than %d addresses; this claim layer only serves sub-/16 bands", s, e, maxRangeSize)
		}
		addrs = append(addrs, a)
	}
	return addrs, nil
}

// FirstFree returns the lowest address in addrs that is not in taken. The second
// result is false when every address is taken.
//
// Lowest-first rather than an arbitrary free address is deliberate: it makes
// allocation deterministic, so a pool with a given set of claims always hands out
// the same addresses, and a test can assert on a specific one without controlling
// iteration order.
func FirstFree(addrs []netip.Addr, taken map[netip.Addr]struct{}) (netip.Addr, bool) {
	for _, a := range addrs {
		if _, isTaken := taken[a]; !isTaken {
			return a, true
		}
	}
	return netip.Addr{}, false
}

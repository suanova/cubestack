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
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// NADNameSuffix is appended to a VM's name to form its default NAD name.
const NADNameSuffix = "-static"

// maxNADNameLength is the DNS-1123 subdomain limit, which is what a
// NetworkAttachmentDefinition's name must satisfy.
const maxNADNameLength = 253

// digestLength is how many hex characters of the SHA-256 of the VM name are kept
// when a name has to be shortened. Eight is enough to distinguish the handful of
// VMs that could plausibly collide on a truncated prefix, while staying short
// enough to leave most of a long name readable.
const digestLength = 8

// DefaultNADName derives the NAD name for a VM that did not set
// ipam.cubestack.io/nad-name.
//
// The name is derived from the VM alone, never from the assigned address. That is
// the point: the VM manifest has to name its NAD before the address exists, so
// the name cannot depend on anything the controller has yet to decide.
//
// Names longer than the DNS-1123 limit are truncated and given a digest of the
// untruncated name. Truncating alone would let two VMs with a shared prefix
// collapse onto one NAD name, and the second one would then fail as
// NADNameTaken — a confusing failure to hit by accident.
func DefaultNADName(vmName string) string {
	full := vmName + NADNameSuffix
	if len(full) <= maxNADNameLength {
		return full
	}

	sum := sha256.Sum256([]byte(vmName))
	digest := hex.EncodeToString(sum[:digestLength/2])

	keep := maxNADNameLength - len(NADNameSuffix) - 1 - len(digest)
	// A truncation can leave the kept prefix ending in '-' or '.', which would put
	// a label boundary in an illegal place once the digest is appended.
	prefix := strings.TrimRight(vmName[:keep], "-.")

	return prefix + "-" + digest + NADNameSuffix
}

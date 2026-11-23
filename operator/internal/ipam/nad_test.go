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
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/util/validation"
)

// The name must satisfy DNS-1123 because it becomes a NetworkAttachmentDefinition
// name, and it must be derived from the VM alone because the VM manifest is
// written before any address is known.
func TestDefaultNADName(t *testing.T) {
	tests := []struct {
		name   string
		vmName string
		want   string
	}{
		{
			name:   "plain VM name",
			vmName: "cubestack6",
			want:   "cubestack6-static",
		},
		{
			name:   "VM name at the length where the suffix still fits",
			vmName: strings.Repeat("a", maxNADNameLength-len(NADNameSuffix)),
			want:   strings.Repeat("a", maxNADNameLength-len(NADNameSuffix)) + NADNameSuffix,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DefaultNADName(tt.vmName)
			if got != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
			if errs := validation.IsDNS1123Subdomain(got); len(errs) > 0 {
				t.Errorf("result %q is not a valid DNS-1123 subdomain: %v", got, errs)
			}
		})
	}
}

func TestDefaultNADName_TooLongIsTruncatedButStaysValid(t *testing.T) {
	vmName := strings.Repeat("a", 260)

	got := DefaultNADName(vmName)
	if len(got) > maxNADNameLength {
		t.Errorf("result is %d chars, over the %d limit: %s", len(got), maxNADNameLength, got)
	}
	if errs := validation.IsDNS1123Subdomain(got); len(errs) > 0 {
		t.Errorf("result %q is not a valid DNS-1123 subdomain: %v", got, errs)
	}
	if !strings.HasSuffix(got, NADNameSuffix) {
		t.Errorf("expected the %q suffix to survive truncation, got %s", NADNameSuffix, got)
	}
	if got == DefaultNADName(strings.Repeat("a", 261)) && got == DefaultNADName(strings.Repeat("a", 262)) {
		t.Errorf("truncation collapsed three distinct VM names onto %s", got)
	}
}

// Two VMs sharing a long prefix must not collapse onto one NAD name: the second
// would fail as NADNameTaken, which is a baffling thing to run into by accident.
func TestDefaultNADName_SharedPrefixDoesNotCollide(t *testing.T) {
	prefix := strings.Repeat("a", 250)
	first := DefaultNADName(prefix + "-one")
	second := DefaultNADName(prefix + "-two")

	if first == second {
		t.Errorf("two VM names sharing a %d-char prefix both produced %s", len(prefix), first)
	}
}

// Truncating can leave the kept prefix ending in a separator, which would put a
// label boundary somewhere DNS-1123 forbids once the digest is appended.
func TestDefaultNADName_TrailingSeparatorIsTrimmed(t *testing.T) {
	// Position 236 is the last kept character, and it is made a '-'.
	vmName := strings.Repeat("a", 236) + "-" + strings.Repeat("b", 30)

	got := DefaultNADName(vmName)
	if errs := validation.IsDNS1123Subdomain(got); len(errs) > 0 {
		t.Errorf("result %q is not a valid DNS-1123 subdomain: %v", got, errs)
	}
	if strings.Contains(got, "--") {
		t.Errorf("result %q contains a doubled separator", got)
	}
}

// A claim name is a DNS-1123 subdomain of up to 253 characters, but a label value
// stops at 63. Writing a long name verbatim makes the NAD uncreatable, so the value
// has to be shortened while still telling two long names apart.
func TestClaimLabelValue(t *testing.T) {
	if got := ClaimLabelValue("claims-basic-ip"); got != "claims-basic-ip" {
		t.Errorf("a short name must be written as it is, got %q", got)
	}

	if got := ClaimLabelValue(strings.Repeat("a", maxLabelValueLength)); got != strings.Repeat("a", maxLabelValueLength) {
		t.Errorf("a name of exactly %d characters must be kept, got %q", maxLabelValueLength, got)
	}

	long := strings.Repeat("a", 250)
	got := ClaimLabelValue(long)
	if len(got) > maxLabelValueLength {
		t.Errorf("result is %d chars, over the %d limit: %s", len(got), maxLabelValueLength, got)
	}
	if errs := validation.IsValidLabelValue(got); len(errs) > 0 {
		t.Errorf("result %q is not a valid label value: %v", got, errs)
	}

	// The point of the digest: two long names that share a prefix must not collapse
	// onto one label value, or the audit cannot tell their NADs apart.
	if ClaimLabelValue(strings.Repeat("a", 240)+"-one") == ClaimLabelValue(strings.Repeat("a", 240)+"-two") {
		t.Error("two long claim names sharing a prefix produced the same label value")
	}

	// A truncation can land on a separator, which a label value may contain only in
	// the middle.
	separator := strings.Repeat("a", 53) + "-" + strings.Repeat("b", 20)
	if got := ClaimLabelValue(separator); strings.Contains(got, "--") || strings.HasSuffix(got, "-") {
		t.Errorf("result %q contains a doubled or trailing separator", got)
	}
	if errs := validation.IsValidLabelValue(ClaimLabelValue(separator)); len(errs) > 0 {
		t.Errorf("result is not a valid label value: %v", errs)
	}
}

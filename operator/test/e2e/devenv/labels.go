// Package devenv is the plumbing behind the DevEnvironment conformance specs in
// the parent e2e package: the catalogue of published images, a typed client, the
// environment lifecycle, the transports, and the cluster preconditions.
//
// It imports neither Ginkgo nor Gomega, deliberately. Everything here returns a
// value or an error and the specs decide what a failure means, which keeps the
// preconditions usable from a plain TestXxx or a one-off program and keeps the
// assertion framework out of code that is otherwise all plumbing.
//
// The suite is opt-in and must stay that way. It runs against a cluster someone
// else owns — their Gateway, their L4 port pool, their storage class, their image
// pulls — and pulls images measured in tens of gigabytes. TestE2E filters
// LabelConformance out unless the caller names a filter explicitly, so a run
// that forgets one lands on the safe side.
package devenv

// LabelConformance is on every spec this suite contributes, and on nothing else
// in the repository. It is the gate: see TestE2E.
const LabelConformance = "devenv-conformance"

// The tiers a case belongs to. Bare rather than "tier:p0" to match the labels
// the design document already uses for its rows.
const (
	TierP0 = "p0"
	TierP1 = "p1"
)

// LabelFamily names the family a case belongs to — the A–M grouping of
// design/devenv/image-endpoint-test-plan.md §4. A family is a subject (bring-up,
// publication, the negative cases, …), not a priority; the tier carries that.
func LabelFamily(family string) string { return "family:" + family }

// LabelImage names one published image by its catalogue key.
func LabelImage(key string) string { return "image:" + key }

// LabelIdentity names the account an environment runs as.
func LabelIdentity(i Identity) string { return "identity:" + string(i) }

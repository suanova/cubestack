// Package devenv is the plumbing behind the DevEnvironment conformance specs in
// the parent e2e package: the catalogue of published images, a typed client, the
// environment lifecycle, the transports, and the cluster preconditions.
//
// It imports neither Ginkgo nor Gomega, deliberately. Everything here returns a
// value or an error and the specs decide what a failure means, which keeps the
// preconditions usable from a plain TestXxx or a one-off program and keeps the
// assertion framework out of code that is otherwise all plumbing.
//
// The suite is opt-in and must stay that way. It creates real environments in a
// cluster someone else owns — their Gateway, their L4 port pool, their storage
// class, their pulls — or, with DEVENV_E2E_ALLOW_KIND and preloaded images, in
// the kind cluster a CI job built for it, where the images it would otherwise
// pull are already on the node. TestE2E filters LabelConformance out unless the
// caller names a filter explicitly, so a run that forgets one lands on the safe
// side.
package devenv

// LabelConformance is on every spec this suite contributes, and on nothing else
// in the repository. It is the gate: see TestE2E.
const LabelConformance = "devenv-conformance"

// The tiers a case belongs to. Bare rather than "tier:p0" to match the labels
// the design document already uses for its rows.
//
// A tier says what a case is worth. It is not the shard the case runs in — see
// LabelShard — and the two are deliberately separate questions.
const (
	TierP0 = "p0"
	TierP1 = "p1"
)

// The shards CI partitions the run into: one job per shard, each against the
// cluster that job built. Named after the tiers because a case runs in its
// tier's shard unless LabelShard moves it.
const (
	ShardP0 = "p0"
	ShardP1 = "p1"
	ShardP2 = "p2"
)

// LabelShard moves a case out of the shard its tier names and into another.
//
// The tier is a statement about the case; the shard is a statement about which
// leg its wall time lands on, and the two are not the same question. Two groups
// disagree today. The three cases declared last in the tree — isolation, the
// idle stop and the controller restart — are P1, but they are the suite's
// slowest and most disruptive, so a leg of their own keeps them from setting
// p1's wall time. Family K's six cases are P1 by the design document and
// self-contained — one environment per container and no state another family
// shares — so they run in that leg too: it has the slack to take them, and
// taking them off p0 is what keeps the matrix's leg from being the long one.
// That is measured rather than counted: K's six cases add well over a minute to
// whichever leg they are on, and p2's three finish several minutes before the
// long one.
//
// A case carries this beside its tier, and the shard filter in operator/Makefile
// reads it as an override: the case runs in the shard it names and in no other.
func LabelShard(shard string) string { return "shard:" + shard }

// LabelFamily names the family a case belongs to — the A–S grouping of
// design/devenv/image-endpoint-test-plan.md §4. A family is a subject (bring-up,
// publication, the negative cases, …), not a priority; the tier carries that.
// The letters here have grown past the document's in places — N and O are the
// GPU and RDMA families, P is network isolation and S is the controller's own
// restart — so this names the case's subject rather than pointing at a row.
func LabelFamily(family string) string { return "family:" + family }

// LabelImage names one published image by its catalogue key.
func LabelImage(key string) string { return "image:" + key }

// LabelIdentity names the account an environment runs as.
func LabelIdentity(i Identity) string { return "identity:" + string(i) }

// LabelDevice names the device a case needs, and so the device its cluster must
// have for the case to run at all. It spans both classes — a GPU vendor and an
// RDMA fabric are the same kind of thing to a reader choosing what to run, even
// though one is an extended resource on a node and the other a flag on the
// manager. Needed because a case that shapes its own environment is not on the
// image matrix and so carries no image label to select it by.
func LabelDevice(name string) string { return "device:" + name }

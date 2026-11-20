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
	"context"

	"k8s.io/apimachinery/pkg/api/equality"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// patchStatusIfChanged writes the status subresource only when it differs from
// what the object already carries.
//
// Patch rather than Update: an Update carries the resourceVersion of the object
// we read, and that read is served by the informer cache, which lags the API
// server. Status is this controller's own observed state and needs no
// compare-and-swap, so a merge patch drops the precondition instead of
// 409-conflicting and forcing a retry reconcile.
//
// Skipping the write when nothing changed matters more than it looks: the
// controllers return without requeueing on success, so an unconditional write
// would be the only thing generating further reconciles — a slow loop of the
// controller's own making.
//
// The status values are passed in rather than read off the objects because IPPool
// and IPClaim share no interface exposing Status. Passing them keeps the
// comparison type-safe without a type switch.
func patchStatusIfChanged[S any](ctx context.Context, c client.Client, current, desired client.Object, currentStatus, desiredStatus S) error {
	if equality.Semantic.DeepEqual(currentStatus, desiredStatus) {
		return nil
	}
	return c.Status().Patch(ctx, desired, client.MergeFrom(current))
}

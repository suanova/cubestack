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
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/events"
)

// recordEvent emits a Kubernetes event, or does nothing when no recorder is
// configured.
//
// The recorder is optional so that a test constructing a reconciler directly does
// not have to stand up an event broadcaster. In the binary it is always set, so a
// nil recorder means "not wired", never "events are off in production".
//
// The auditor is the only caller, and events are how its findings are made
// legible: a sweep's output otherwise reaches nobody but the process log.
func recordEvent(rec events.EventRecorder, obj runtime.Object, eventtype, reason, action, note string, args ...any) {
	if rec == nil {
		return
	}
	rec.Eventf(obj, nil, eventtype, reason, action, note, args...)
}

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

package controller

import (
	"crypto/sha256"
	"fmt"
	"slices"

	corev1 "k8s.io/api/core/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// Hash annotation keys written into the pod template (design §5.1): one
// combined hash plus one per input component, for diagnosis.
const (
	templateHashAnnotationKey          = "ai.cubestack.io/template-hash"
	templateHashPodAnnotationKey       = "ai.cubestack.io/template-hash-pod"
	templateHashOverridesAnnotationKey = "ai.cubestack.io/template-hash-overrides"
	templateHashAssetsAnnotationKey    = "ai.cubestack.io/template-hash-assets"
	templateHashStorageAnnotationKey   = "ai.cubestack.io/template-hash-storage"
)

// templateHashAnnotations computes the per-component and combined template
// hashes for one role (design §5.1). The combined hash covers the rendered
// pod template (spec, labels, annotations), the rendered asset content
// hashes, and — only for roles that mount the model — the model storage
// configuration (Quantity fields marshal to canonical form, so 1024Mi and
// 1Gi hash identically). The resolved overrides are NOT part of the combined
// hash: the rendered pod template already embeds every referenced override
// (template-affecting overrides change the pod hash) and asset-affecting
// overrides change the asset hash, while an override that only changes the
// replicas must not roll out (design §5.1 scale row). The overrides component
// is still computed and written as a diagnostic annotation.
// podAnnotations must not contain the hash annotations themselves; the caller
// adds them afterwards.
func templateHashAnnotations(podSpec corev1.PodSpec, podLabels, podAnnotations map[string]string, overrides map[string]string, assets map[string]map[string]string, model *aiv1alpha1.ModelVersion, mountsModel bool) map[string]string {
	podHash := sha256.New()
	podHash.Write(mustJSON(podSpec))
	podHash.Write(mustJSON(podLabels))
	podHash.Write(mustJSON(podAnnotations))
	pod := fmt.Sprintf("sha256:%x", podHash.Sum(nil))

	overridesHash := sha256.New()
	overridesHash.Write(mustJSON(overrides))
	ov := fmt.Sprintf("sha256:%x", overridesHash.Sum(nil))

	assetsHash := sha256.New()
	names := make([]string, 0, len(assets))
	for name := range assets {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		_, _ = fmt.Fprintf(assetsHash, "|%s=%s", name, assetDataHash(assets[name]))
	}
	as := fmt.Sprintf("sha256:%x", assetsHash.Sum(nil))

	var st string
	if mountsModel {
		st = fmt.Sprintf("sha256:%x", sha256.Sum256(mustJSON(model.Spec.Storage)))
	} else {
		st = fmt.Sprintf("sha256:%x", sha256.Sum256(nil))
	}

	combined := sha256.New()
	for _, part := range []string{pod, as, st} {
		combined.Write([]byte(part))
		combined.Write([]byte{'|'})
	}
	return map[string]string{
		templateHashAnnotationKey:          fmt.Sprintf("sha256:%x", combined.Sum(nil)),
		templateHashPodAnnotationKey:       pod,
		templateHashOverridesAnnotationKey: ov,
		templateHashAssetsAnnotationKey:    as,
		templateHashStorageAnnotationKey:   st,
	}
}

package controller

import (
	"context"
	"sync"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// Cache index field names shared by the controllers. They are registered once
// per manager by registerSharedIndexes; controllers must not call IndexField
// with these names themselves.
const (
	// modelRefIndexKey is the cache index field for InferenceService.spec.modelRef.
	modelRefIndexKey = "spec.modelRef"

	// profileRefIndexKey is the cache index field for InferenceService.spec.profileRef.
	profileRefIndexKey = "spec.profileRef"

	// assetConfigMapRefIndexKey is the cache index field for
	// InferenceRuntimeProfile assets[].configMapRef.name.
	assetConfigMapRefIndexKey = "assets[].configMapRef.name"
)

var (
	registerIndexesOnce sync.Once
	registerIndexesErr  error
)

// registerSharedIndexes registers the reverse-lookup cache indexes shared by
// the ModelVersion, InferenceRuntimeProfile and InferenceService controllers.
// It is guarded by sync.Once because client-go rejects a second registration
// of the same index name with "indexer conflict"; every controller calls it
// from SetupWithManager and the first call wins.
func registerSharedIndexes(mgr ctrl.Manager) error {
	registerIndexesOnce.Do(func() {
		registerIndexesErr = registerAllIndexes(mgr)
	})
	return registerIndexesErr
}

func registerAllIndexes(mgr ctrl.Manager) error {
	ctx := context.Background()
	if err := mgr.GetCache().IndexField(ctx, &aiv1alpha1.InferenceService{}, modelRefIndexKey,
		func(o client.Object) []string {
			return []string{o.(*aiv1alpha1.InferenceService).Spec.ModelRef}
		}); err != nil {
		return err
	}
	if err := mgr.GetCache().IndexField(ctx, &aiv1alpha1.InferenceService{}, profileRefIndexKey,
		func(o client.Object) []string {
			return []string{o.(*aiv1alpha1.InferenceService).Spec.ProfileRef}
		}); err != nil {
		return err
	}
	return mgr.GetCache().IndexField(ctx, &aiv1alpha1.InferenceRuntimeProfile{}, assetConfigMapRefIndexKey,
		func(o client.Object) []string {
			irp := o.(*aiv1alpha1.InferenceRuntimeProfile)
			refs := make([]string, 0, len(irp.Spec.Assets))
			for _, asset := range irp.Spec.Assets {
				refs = append(refs, asset.ConfigMapRef.Name)
			}
			return refs
		})
}

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

	// credentialsRefIndexKey is the cache index field for
	// ModelVersion storage.s3.credentialsRef.name.
	credentialsRefIndexKey = "storage.s3.credentialsRef.name"

	// publishIndexKey is the cache index field for InferenceService.spec.route.publish,
	// holding the single key publishIndexValue for services that publish a
	// catalog rule. It backs the shared catalog route watch: an edit to the
	// platform's shared route re-enqueues exactly the published services, whose
	// rules must be reconciled against the edited object.
	publishIndexKey = "spec.route.publish"

	// publishIndexValue is the boolean-true string the publish index holds for a
	// published service (the value paired with publishIndexKey). The same
	// boolean-true marker is reused on headless Services, so it is shared.
	publishIndexValue = "true"
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
	// Only published services contribute to the index key; a nil Route means the
	// service is not published and never attaches a rule to the shared route.
	if err := mgr.GetCache().IndexField(ctx, &aiv1alpha1.InferenceService{}, publishIndexKey,
		func(o client.Object) []string {
			isvc := o.(*aiv1alpha1.InferenceService)
			if isvc.Spec.Route != nil && isvc.Spec.Route.Publish {
				return []string{publishIndexValue}
			}
			return nil
		}); err != nil {
		return err
	}
	if err := mgr.GetCache().IndexField(ctx, &aiv1alpha1.InferenceRuntimeProfile{}, assetConfigMapRefIndexKey,
		func(o client.Object) []string {
			irp := o.(*aiv1alpha1.InferenceRuntimeProfile)
			refs := make([]string, 0, len(irp.Spec.Assets))
			for _, asset := range irp.Spec.Assets {
				refs = append(refs, asset.ConfigMapRef.Name)
			}
			return refs
		}); err != nil {
		return err
	}
	// Only S3 ModelVersions with a credentialsRef participate; the index entry
	// must stay empty for every other storage strategy.
	return mgr.GetCache().IndexField(ctx, &aiv1alpha1.ModelVersion{}, credentialsRefIndexKey,
		func(o client.Object) []string {
			mv := o.(*aiv1alpha1.ModelVersion)
			if mv.Spec.Storage.Strategy != aiv1alpha1.StorageStrategyS3 ||
				mv.Spec.Storage.S3 == nil || mv.Spec.Storage.S3.CredentialsRef == nil {
				return nil
			}
			return []string{mv.Spec.Storage.S3.CredentialsRef.Name}
		})
}

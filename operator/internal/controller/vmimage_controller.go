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

// +kubebuilder:rbac:groups=ai.cubestack.io,resources=vmimages,verbs=get;list;watch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=vmimages/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=vmimages/finalizers,verbs=update
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=vmenvironments,verbs=get;list;watch
// +kubebuilder:rbac:groups=cdi.kubevirt.io,resources=datavolumes,verbs=get;list;watch;create

package controller

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	// goldenImageStorageClass binds immediately: the golden disk is imported
	// once, ahead of any environment cloning from it, so there is no consumer
	// to wait for (design §7.1).
	goldenImageStorageClass = "ceph-rbd-kubevirt-immediate"

	// goldenDataVolumeSuffix distinguishes the golden DataVolume from the PVC
	// its source may name. CDI names the claim it creates after the
	// DataVolume, so a bare image name would collide with a same-named source
	// PVC in the platform namespace.
	goldenDataVolumeSuffix = "-golden"

	// goldenImageManagedByValue marks the objects this controller creates in
	// the platform namespace.
	goldenImageManagedByValue = "vmimage-controller"

	// metadataField is the unstructured object's metadata key, named by the
	// rendered DataVolume and the specs reading it back.
	metadataField = "metadata"

	// importPollInterval re-checks an import the DataVolume watch may not
	// report: the watch is only registered on a cluster that serves the CDI
	// kind at startup.
	importPollInterval = 30 * time.Second
)

// dataVolumeGVK is CDI's DataVolume. It is written as an unstructured object
// so the operator does not take a build dependency on CDI's API module, and so
// a cluster without CDI can still run every other controller.
var dataVolumeGVK = schema.GroupVersionKind{
	Group:   "cdi.kubevirt.io",
	Version: "v1beta1",
	Kind:    "DataVolume",
}

// disk phases as status reports them, shared by the golden image and an
// environment's own clone (design §7.1).
const (
	diskPhaseImporting = "Importing"
	diskPhaseReady     = "Ready"
	diskPhaseFailed    = "Failed"
)

// dataVolumeImportState is what a DataVolume's status says about the disk it
// is importing: the phase, the percentage while it runs, and the failure text.
type dataVolumeImportState struct {
	phase string
	// progress is nil when the importer has not reported a percentage yet.
	progress *int32
	message  string
}

// VMImageReconciler materialises the golden disk of a VMImage. Publishing a
// catalogue entry only records where the disk comes from; the import runs when
// an environment first references the image (design §7.5), so an image nobody
// uses costs no storage.
type VMImageReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile imports a referenced image's golden disk into the platform
// namespace and reports its progress on the image's Ready condition.
func (r *VMImageReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var image aiv1alpha1.VMImage
	if err := r.Get(ctx, req.NamespacedName, &image); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	referenced, err := r.imageReferenced(ctx, image.Name)
	if err != nil {
		return ctrl.Result{}, err
	}

	desired := image.DeepCopy()
	requeue := false

	dv := &unstructured.Unstructured{}
	dv.SetGroupVersionKind(dataVolumeGVK)
	err = r.Get(ctx, types.NamespacedName{Namespace: systemNamespace, Name: goldenDataVolumeName(image.Name)}, dv)
	switch {
	case apierrors.IsNotFound(err) && !referenced:
		// The catalogue entry is published but nothing uses it yet.
		desired.Status.DataVolume = ""
		meta.SetStatusCondition(&desired.Status.Conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionReady,
			Status:  metav1.ConditionFalse,
			Reason:  "NotReferenced",
			Message: "No environment references this image; its golden disk is imported on first reference",
		})

	case apierrors.IsNotFound(err):
		golden := newGoldenDataVolume(&image)
		if err := ctrl.SetControllerReference(&image, golden, r.Scheme); err != nil {
			return ctrl.Result{}, err
		}
		// A create that loses the race to the watch-driven pass meets its own
		// DataVolume; the next pass reads it.
		if err := r.Create(ctx, golden); err != nil && !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
		desired.Status.DataVolume = golden.GetName()
		meta.SetStatusCondition(&desired.Status.Conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionReady,
			Status:  metav1.ConditionFalse,
			Reason:  diskPhaseImporting,
			Message: "Importing the golden disk",
		})
		requeue = true

	case meta.IsNoMatchError(err):
		// The virtualization layer is not installed: the image is catalogued
		// but cannot be imported until it is.
		desired.Status.DataVolume = ""
		meta.SetStatusCondition(&desired.Status.Conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionReady,
			Status:  metav1.ConditionFalse,
			Reason:  "PlatformNotReady",
			Message: "The cluster does not serve CDI DataVolumes; the golden disk cannot be imported",
		})
		requeue = true

	case err != nil:
		return ctrl.Result{}, err

	default:
		desired.Status.DataVolume = dv.GetName()
		if owner := metav1.GetControllerOf(dv); owner == nil || owner.UID != image.UID {
			// Left behind by an earlier incarnation of the image; garbage
			// collection removes it and the next pass creates a fresh one.
			meta.SetStatusCondition(&desired.Status.Conditions, metav1.Condition{
				Type:    aiv1alpha1.ConditionReady,
				Status:  metav1.ConditionFalse,
				Reason:  "DataVolumeConflict",
				Message: fmt.Sprintf("The golden DataVolume %s is not controlled by this image", dv.GetName()),
			})
			requeue = true
			break
		}
		state := dataVolumeState(dv)
		condition := metav1.Condition{
			Type:   aiv1alpha1.ConditionReady,
			Status: metav1.ConditionTrue,
			Reason: "Imported",
		}
		switch state.phase {
		case diskPhaseFailed:
			condition.Status = metav1.ConditionFalse
			condition.Reason = "ImportFailed"
			condition.Message = state.message
		case diskPhaseReady:
			condition.Message = "The golden disk is usable"
		default:
			condition.Status = metav1.ConditionFalse
			condition.Reason = diskPhaseImporting
			condition.Message = goldenImportMessage(state)
			requeue = true
		}
		meta.SetStatusCondition(&desired.Status.Conditions, condition)
	}

	if !apiequality.Semantic.DeepEqual(image.Status, desired.Status) {
		if err := r.Status().Update(ctx, desired); err != nil {
			return ctrl.Result{}, err
		}
	}
	if requeue {
		return ctrl.Result{RequeueAfter: importPollInterval}, nil
	}
	return ctrl.Result{}, nil
}

// imageReferenced reports whether any environment names this image.
func (r *VMImageReconciler) imageReferenced(ctx context.Context, name string) (bool, error) {
	envs := &aiv1alpha1.VMEnvironmentList{}
	if err := r.List(ctx, envs, client.MatchingFields{vmImageRefIndexKey: name}); err != nil {
		return false, err
	}
	return len(envs.Items) > 0, nil
}

// goldenDataVolumeName is the name of the platform's copy of an image's disk.
func goldenDataVolumeName(imageName string) string {
	return imageName + goldenDataVolumeSuffix
}

// newGoldenDataVolume renders the platform's copy of the golden disk: a
// read-only clone source for every environment using the image, imported from
// the image's registry artifact or copied from its source claim (design §7.1,
// §7.5).
func newGoldenDataVolume(image *aiv1alpha1.VMImage) *unstructured.Unstructured {
	var source map[string]any
	if image.Spec.Source.PVC != nil {
		source = map[string]any{
			"pvc": map[string]any{
				"name":      image.Spec.Source.PVC.Name,
				"namespace": systemNamespace,
			},
		}
	} else {
		// CDI's registry importer reads container images through docker://.
		source = map[string]any{
			"registry": map[string]any{
				"url": "docker://" + image.Spec.Source.Registry,
			},
		}
	}

	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": dataVolumeGVK.GroupVersion().String(),
		"kind":       dataVolumeGVK.Kind,
		metadataField: map[string]any{
			"name":      goldenDataVolumeName(image.Name),
			"namespace": systemNamespace,
			"labels": map[string]any{
				managedByLabelKey: goldenImageManagedByValue,
			},
		},
		"spec": map[string]any{
			"source": source,
			"storage": map[string]any{
				"accessModes":      []any{string(corev1.ReadWriteOnce)},
				"volumeMode":       string(corev1.PersistentVolumeBlock),
				"storageClassName": goldenImageStorageClass,
				"resources": map[string]any{
					"requests": map[string]any{
						"storage": image.Spec.MinSystemDisk.String(),
					},
				},
			},
		},
	}}
}

// dataVolumeImportState maps a DataVolume's status onto the disk phases common
// to the golden image and an environment's clone.
func dataVolumeState(dv *unstructured.Unstructured) dataVolumeImportState {
	phase, _, _ := unstructured.NestedString(dv.Object, "status", "phase")
	switch phase {
	case "Succeeded":
		return dataVolumeImportState{phase: diskPhaseReady}
	case "Failed":
		return dataVolumeImportState{phase: diskPhaseFailed, message: dataVolumeFailureMessage(dv)}
	}

	// Anything else — no status yet, Pending, ImportScheduled,
	// ImportInProgress, CloneInProgress, Paused — is an import in flight.
	state := dataVolumeImportState{phase: diskPhaseImporting}
	if progress, ok, _ := unstructured.NestedString(dv.Object, "status", "progress"); ok {
		state.progress = parsePercent(progress)
		if state.progress != nil {
			state.message = fmt.Sprintf("Importing: %d%% complete", *state.progress)
		}
	}
	return state
}

// dataVolumeFailureMessage is the importer's own explanation of a failed
// import, falling back to a generic one when CDI recorded none.
func dataVolumeFailureMessage(dv *unstructured.Unstructured) string {
	conditions, _, _ := unstructured.NestedSlice(dv.Object, "status", "conditions")
	for _, raw := range conditions {
		condition, ok := raw.(map[string]any)
		if !ok || condition["type"] != "Ready" || condition["status"] != "False" {
			continue
		}
		if message, ok := condition["message"].(string); ok && message != "" {
			return message
		}
		if reason, ok := condition["reason"].(string); ok && reason != "" {
			return reason
		}
	}
	return "the disk import failed"
}

// goldenImportMessage is the Ready condition message while the golden disk is
// importing: the importer's percentage when it has one.
func goldenImportMessage(state dataVolumeImportState) string {
	if state.progress == nil {
		return "Importing the golden disk"
	}
	return fmt.Sprintf("Importing the golden disk: %d%% complete", *state.progress)
}

// parsePercent reads CDI's progress string ("42.5%") as a whole percentage,
// nil when it is absent or unreadable.
func parsePercent(progress string) *int32 {
	value, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(progress), "%"), 64)
	if err != nil || value < 0 {
		return nil
	}
	whole := int32(value)
	whole = min(whole, 100)
	return &whole
}

// SetupWithManager registers the image watch, the environment watch that
// triggers the first import, and — when the cluster serves CDI — the
// DataVolume watch that reports import progress. A cluster without CDI starts
// normally; the DataVolume watch is simply absent until the operator restarts.
func (r *VMImageReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := registerSharedIndexes(mgr); err != nil {
		return err
	}

	b := ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.VMImage{}).
		Watches(&aiv1alpha1.VMEnvironment{}, handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingImage),
			builder.WithPredicates(imageReferenceChanged()))
	if dataVolumeKindServed(mgr.GetRESTMapper()) {
		b = b.Watches(newDataVolumeObject(),
			handler.EnqueueRequestForOwner(mgr.GetScheme(), mgr.GetRESTMapper(), &aiv1alpha1.VMImage{}, handler.OnlyControllerOwner()))
	}
	return b.Complete(r)
}

// imageReferenceChanged passes the environment writes that can change which
// image an environment references — creation, deletion, and a spec.image edit —
// not the status writes the environment's own controller makes, which would
// re-enqueue the image on every one of them.
func imageReferenceChanged() predicate.Predicate {
	return predicate.Funcs{
		UpdateFunc: func(e event.UpdateEvent) bool {
			oldEnv, okOld := e.ObjectOld.(*aiv1alpha1.VMEnvironment)
			newEnv, okNew := e.ObjectNew.(*aiv1alpha1.VMEnvironment)
			return !okOld || !okNew || oldEnv.Spec.Image != newEnv.Spec.Image
		},
	}
}

// dataVolumeKindServed reports whether the cluster serves CDI's DataVolume
// kind.
func dataVolumeKindServed(mapper meta.RESTMapper) bool {
	_, err := mapper.RESTMapping(dataVolumeGVK.GroupKind(), dataVolumeGVK.Version)
	return err == nil
}

// newDataVolumeObject is the watch's object type.
func newDataVolumeObject() *unstructured.Unstructured {
	dv := &unstructured.Unstructured{}
	dv.SetGroupVersionKind(dataVolumeGVK)
	return dv
}

// enqueueReferencingImage maps an environment to the image it names.
func (r *VMImageReconciler) enqueueReferencingImage(_ context.Context, obj client.Object) []reconcile.Request {
	image := obj.(*aiv1alpha1.VMEnvironment).Spec.Image
	if image == "" {
		return nil
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: image}}}
}

// imageNotAllowed reports why a new environment may not use the image, "" when
// it may. Environments that already reference a deprecated image keep running:
// their disk was cloned before the deprecation and is theirs. The caller
// reports a non-empty reason as Accepted=False / ImageNotAllowed.
func imageNotAllowed(image *aiv1alpha1.VMImage) string {
	if image.Spec.Deprecated {
		return fmt.Sprintf("image %q is deprecated and no longer offered to new environments", image.Name)
	}
	return ""
}

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
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

// applyResult reports the apply-phase outcome.
type applyResult struct {
	// WaitingDependencies lists the roles whose creation is gated on a
	// not-yet-ready dependency (WorkloadsApplied=False, WaitingForDependencies).
	WaitingDependencies []string
}

// serviceApplyErr marks an error from the Service apply step so the caller
// can report ServiceApplyFailed instead of WorkloadApplyFailed.
type serviceApplyErr struct{ err error }

func (e serviceApplyErr) Error() string { return e.err.Error() }
func (e serviceApplyErr) Unwrap() error { return e.err }

// applyWorkloads creates or updates the Services and workloads of every role
// in dependency order with ready gating for creation (design §4.3), decides
// create/rollout/scale/skip via the template-hash (design §5.1), and deletes
// no-longer-desired resources. It returns the per-role status (static
// topology plus observed readiness).
func (r *InferenceServiceReconciler) applyWorkloads(ctx context.Context, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, rendered *renderer.Result, model *aiv1alpha1.ModelVersion) ([]aiv1alpha1.RoleStatus, *applyResult, error) {
	order, err := topoOrder(profile.Spec.Roles, profile.Spec.Endpoint.Role)
	if err != nil {
		return nil, nil, err
	}

	rolesByName := make(map[string]*aiv1alpha1.Role, len(profile.Spec.Roles))
	renderedByName := make(map[string]*renderer.RenderedRole, len(rendered.Roles))
	for i := range profile.Spec.Roles {
		rolesByName[profile.Spec.Roles[i].Name] = &profile.Spec.Roles[i]
	}
	for i := range rendered.Roles {
		renderedByName[rendered.Roles[i].Name] = &rendered.Roles[i]
	}

	res := &applyResult{}
	desiredPrefixes := make(map[string]bool, 2*len(profile.Spec.Roles))
	desiredKinds := make(map[string]aiv1alpha1.WorkloadKind, len(profile.Spec.Roles))
	statuses := make([]aiv1alpha1.RoleStatus, 0, len(order))
	for _, name := range order {
		role := rolesByName[name]
		rr := renderedByName[name]
		if rr == nil {
			// The renderer always emits one RenderedRole per profile role, but
			// a nil entry must surface as a visible error instead of panicking
			// the controller process on the dereference below.
			return statuses, nil, fmt.Errorf("rendered result is missing role %q", name)
		}
		prefix := fmt.Sprintf("%s-%s", isvc.Name, role.Name)
		desiredPrefixes[prefix] = true
		desiredKinds[prefix] = role.Workload.Kind
		if role.Service != nil && role.Service.Headless != nil && *role.Service.Headless {
			desiredPrefixes[prefix+"-hl"] = true
		}

		if err := r.applyService(ctx, isvc, role); err != nil {
			return statuses, nil, serviceApplyErr{err}
		}

		existing, err := r.getWorkload(ctx, isvc, role)
		switch {
		case apierrors.IsNotFound(err):
			ready, err := r.dependenciesReady(ctx, isvc, rolesByName, renderedByName, role, model)
			if err != nil {
				return statuses, nil, err
			}
			if !ready {
				res.WaitingDependencies = append(res.WaitingDependencies, role.Name)
				statuses = append(statuses, roleStatus(role, rr, isvc, nil, false))
				continue
			}
			if err := r.applyWorkload(ctx, isvc, profile, role, rr, rendered, model); err != nil {
				return statuses, nil, err
			}
		case err != nil:
			return statuses, nil, err
		default:
			if err := ensureOwned(existing, isvc.UID); err != nil {
				return statuses, nil, err
			}
			desired := r.desiredWorkload(isvc, profile, role, rr, rendered, model)
			switch {
			case existingHash(existing) != existingHash(desired):
				// Template change: apply the new template (rollout).
				if err := r.updateWorkload(ctx, existing, desired); err != nil {
					return statuses, nil, err
				}
			case existingReplicas(existing) != desiredReplicas(desired) || existingGroupSize(existing) != desiredGroupSize(desired):
				// Only the workload structure changed — replicas and/or the
				// LWS group size (design §3.2: size may be an override
				// template). The template is identical, so none of this is a
				// rollout.
				if existingGroupSize(existing) != desiredGroupSize(desired) {
					// The group size changed (alone or with replicas): apply
					// the whole desired object; the identical template means
					// the LWS resizes its groups without restarting pods.
					if err := r.updateWorkload(ctx, existing, desired); err != nil {
						return statuses, nil, err
					}
				} else {
					// Only replicas changed: scale without touching the
					// template.
					if err := r.scaleWorkload(ctx, existing, desiredReplicas(desired)); err != nil {
						return statuses, nil, err
					}
				}
			}
		}

		ready, err := r.roleReady(ctx, isvc, role, rr.Replicas, model)
		if err != nil {
			return statuses, nil, err
		}
		statuses = append(statuses, roleStatus(role, rr, isvc, existing, ready))
	}

	if err := r.cleanupOrphanWorkloads(ctx, isvc, desiredPrefixes, desiredKinds); err != nil {
		return statuses, nil, err
	}
	return statuses, res, nil
}

// applyService creates or updates the role's Service <isvc>-<role>, plus the
// headless Service <isvc>-<role>-hl when the role declares one. Roles without
// a service declaration get no Service (design §4.3: Service per role that
// declares one; ports are the profile author's responsibility).
func (r *InferenceServiceReconciler) applyService(ctx context.Context, isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role) error {
	if role.Service == nil {
		return nil
	}
	desired := []*corev1.Service{desiredService(isvc, role, r.Scheme)}
	if role.Service.Headless != nil && *role.Service.Headless {
		desired = append(desired, desiredHeadlessService(isvc, role, r.Scheme))
	}
	for _, svc := range desired {
		if err := r.applyResource(ctx, isvc, svc); err != nil {
			return err
		}
	}
	return nil
}

// applyResource creates or updates one generated resource: a same-name
// resource not owned by this service must never be touched, mirroring
// provisionAssets. An existing resource whose controller-owned fields already
// match the desired ones is left untouched: updating it would bump the
// resourceVersion and, through the Owns() watch, re-enqueue this service into
// an unbounded reconcile loop.
func (r *InferenceServiceReconciler) applyResource(ctx context.Context, isvc *aiv1alpha1.InferenceService, obj client.Object) error {
	existing := obj.DeepCopyObject().(client.Object)
	err := r.Get(ctx, client.ObjectKey{Name: obj.GetName(), Namespace: obj.GetNamespace()}, existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, obj)
	}
	if err != nil {
		return err
	}
	if err := ensureOwned(existing, isvc.UID); err != nil {
		return err
	}
	if !serviceNeedsUpdate(existing, obj) {
		return nil
	}
	obj.SetResourceVersion(existing.GetResourceVersion())
	return r.Update(ctx, obj)
}

// serviceNeedsUpdate reports whether the controller-owned fields of an
// existing Service differ from the desired ones: the ObjectMeta labels and
// annotations, the selector, the ports and — when headless — the ClusterIP
// (headless is the literal "None"). Everything else on a Service is
// server-owned (the allocated ClusterIP, defaulted Protocol, ...) and must
// never be compared: treating server defaults as drift would update the
// Service on every reconcile and, through the Owns(Service) watch, re-enqueue
// the InferenceService into a self-perpetuating reconcile loop.
func serviceNeedsUpdate(existing, desired client.Object) bool {
	e, okE := existing.(*corev1.Service)
	d, okD := desired.(*corev1.Service)
	if !okE || !okD {
		return true
	}
	if !apiequality.Semantic.DeepEqual(e.Labels, d.Labels) ||
		!apiequality.Semantic.DeepEqual(e.Annotations, d.Annotations) ||
		!apiequality.Semantic.DeepEqual(e.Spec.Selector, d.Spec.Selector) {
		return true
	}
	if len(e.Spec.Ports) != len(d.Spec.Ports) {
		return true
	}
	for i := range d.Spec.Ports {
		if !servicePortEqual(e.Spec.Ports[i], d.Spec.Ports[i]) {
			return true
		}
	}
	// A cluster IP is server-allocated; only the headless marker is
	// controller-owned and must match.
	if d.Spec.ClusterIP == corev1.ClusterIPNone && e.Spec.ClusterIP != corev1.ClusterIPNone {
		return true
	}
	return false
}

// servicePortEqual compares the controller-authored fields of two service
// ports — name, port, protocol and targetPort — applying the API server's
// defaults (Protocol → TCP, TargetPort → Port) so a server-defaulted port
// does not look like drift. NodePort and other server-owned fields are not
// compared.
func servicePortEqual(e, d corev1.ServicePort) bool {
	if e.Name != d.Name || e.Port != d.Port {
		return false
	}
	if d.Protocol == "" {
		d.Protocol = corev1.ProtocolTCP
	}
	if e.Protocol != d.Protocol {
		return false
	}
	if d.TargetPort == (intstr.IntOrString{}) {
		d.TargetPort = intstr.FromInt32(d.Port)
	}
	return apiequality.Semantic.DeepEqual(e.TargetPort, d.TargetPort)
}

// applyWorkload creates one role's workload. It is only called when the
// workload does not exist yet: the caller gates creation on dependency
// readiness and makes the rollout/scale/skip decisions for existing workloads.
func (r *InferenceServiceReconciler) applyWorkload(ctx context.Context, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, role *aiv1alpha1.Role, rr *renderer.RenderedRole, rendered *renderer.Result, model *aiv1alpha1.ModelVersion) error {
	return r.Create(ctx, r.desiredWorkload(isvc, profile, role, rr, rendered, model))
}

// desiredWorkload builds the role's Deployment or LeaderWorkerSet with the
// template-hash annotations (design §5.1).
func (r *InferenceServiceReconciler) desiredWorkload(isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, role *aiv1alpha1.Role, rr *renderer.RenderedRole, rendered *renderer.Result, model *aiv1alpha1.ModelVersion) client.Object {
	podSpec := buildPodSpec(rr.PodTemplate, isvc.Name, model, profile.Spec.Accelerator.Vendor)
	mountsModel := len(rr.PodTemplate.Mounts) > 0
	// Hash the labels that are actually written to the pod template: a
	// podTemplate.labels change must roll out (design §5.1 hashes the rendered
	// pod template). The labels do not depend on the hash annotations, so they
	// are computed first.
	labels, _ := podObjectMeta(isvc.Name, role.Name, rr.PodTemplate, nil)
	hashAnnotations := templateHashAnnotations(podSpec, labels, rr.PodTemplate.Annotations, rendered.Overrides, rendered.Assets, model, mountsModel)
	_, annotations := podObjectMeta(isvc.Name, role.Name, rr.PodTemplate, hashAnnotations)
	switch role.Workload.Kind {
	case aiv1alpha1.WorkloadKindLeaderWorkerSet:
		return desiredLWS(isvc, role, rr, podSpec, labels, annotations, r.Scheme)
	default:
		return desiredDeployment(isvc, role, rr, podSpec, labels, annotations, r.Scheme)
	}
}

// dependenciesReady reports whether every role this role depends on has its
// workload created and ready. Every DependsOn name is a declared role
// (topoOrder fails the apply on unknown dependencies), so it appears in the
// ordered loop whose rendered-lookup guard already validated the RenderedRole.
func (r *InferenceServiceReconciler) dependenciesReady(ctx context.Context, isvc *aiv1alpha1.InferenceService, rolesByName map[string]*aiv1alpha1.Role, renderedByName map[string]*renderer.RenderedRole, role *aiv1alpha1.Role, model *aiv1alpha1.ModelVersion) (bool, error) {
	for _, dep := range role.DependsOn {
		depRole := rolesByName[dep]
		depRR := renderedByName[dep]
		ready, err := r.roleReady(ctx, isvc, depRole, depRR.Replicas, model)
		if err != nil {
			return false, err
		}
		if !ready {
			return false, nil
		}
	}
	return true, nil
}

// getWorkload gets the role's workload object — Deployment or LeaderWorkerSet
// per role.Workload.Kind — named <isvc>-<role>.
func (r *InferenceServiceReconciler) getWorkload(ctx context.Context, isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role) (client.Object, error) {
	var obj client.Object
	switch role.Workload.Kind {
	case aiv1alpha1.WorkloadKindLeaderWorkerSet:
		obj = &leaderworkersetv1.LeaderWorkerSet{}
	default:
		obj = &appsv1.Deployment{}
	}
	err := r.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-%s", isvc.Name, role.Name), Namespace: isvc.Namespace}, obj)
	if err != nil {
		return nil, err
	}
	return obj, nil
}

// workloadPodTemplate returns the pod template of a Deployment or
// LeaderWorkerSet workload; ok=false for any other kind.
func workloadPodTemplate(obj client.Object) (*corev1.PodTemplateSpec, bool) {
	switch o := obj.(type) {
	case *appsv1.Deployment:
		return &o.Spec.Template, true
	case *leaderworkersetv1.LeaderWorkerSet:
		return &o.Spec.LeaderWorkerTemplate.WorkerTemplate, true
	}
	return nil, false
}

// existingHash is the template-hash annotation of the workload's pod template
// (design §5.1), "" when absent.
func existingHash(obj client.Object) string {
	pt, ok := workloadPodTemplate(obj)
	if !ok {
		return ""
	}
	return pt.Annotations[templateHashAnnotationKey]
}

// existingReplicas is the current *spec.replicas of the workload (nil → 0).
func existingReplicas(obj client.Object) int32 {
	switch o := obj.(type) {
	case *appsv1.Deployment:
		if o.Spec.Replicas != nil {
			return *o.Spec.Replicas
		}
	case *leaderworkersetv1.LeaderWorkerSet:
		if o.Spec.Replicas != nil {
			return *o.Spec.Replicas
		}
	}
	return 0
}

// desiredReplicas is the *spec.replicas of a desired workload object; it
// shares the accessor with existingReplicas.
func desiredReplicas(obj client.Object) int32 { return existingReplicas(obj) }

// existingGroupSize is the current *spec.leaderWorkerTemplate.size of a
// LeaderWorkerSet workload (0 for Deployments and when absent).
func existingGroupSize(obj client.Object) int32 {
	if o, ok := obj.(*leaderworkersetv1.LeaderWorkerSet); ok && o.Spec.LeaderWorkerTemplate.Size != nil {
		return *o.Spec.LeaderWorkerTemplate.Size
	}
	return 0
}

// desiredGroupSize is the *spec.leaderWorkerTemplate.size of a desired LWS
// workload; it shares the accessor with existingGroupSize.
func desiredGroupSize(obj client.Object) int32 { return existingGroupSize(obj) }

// workloadReadyReplicas is the status.readyReplicas of a Deployment or
// LeaderWorkerSet workload (0 when the object does not exist).
func workloadReadyReplicas(obj client.Object) int32 {
	switch o := obj.(type) {
	case *appsv1.Deployment:
		return o.Status.ReadyReplicas
	case *leaderworkersetv1.LeaderWorkerSet:
		return o.Status.ReadyReplicas
	}
	return 0
}

// updateWorkload applies the desired workload — template change (rollout) —
// on top of the existing one: the desired object keeps the existing
// ResourceVersion.
func (r *InferenceServiceReconciler) updateWorkload(ctx context.Context, existing, desired client.Object) error {
	desired.SetResourceVersion(existing.GetResourceVersion())
	return r.Update(ctx, desired)
}

// scaleWorkload changes only the replicas of the existing workload.
func (r *InferenceServiceReconciler) scaleWorkload(ctx context.Context, existing client.Object, replicas int32) error {
	switch o := existing.(type) {
	case *appsv1.Deployment:
		o.Spec.Replicas = &replicas
	case *leaderworkersetv1.LeaderWorkerSet:
		o.Spec.Replicas = &replicas
	}
	return r.Update(ctx, existing)
}

// roleReady reports whether the role's workload exists with enough ready
// replicas, and — for roles mounting the model from PVC storage — that the
// model PVC is bound (ready gating on PVC, design §4.3).
func (r *InferenceServiceReconciler) roleReady(ctx context.Context, isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, desiredReplicas int64, model *aiv1alpha1.ModelVersion) (bool, error) {
	existing, err := r.getWorkload(ctx, isvc, role)
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if int64(workloadReadyReplicas(existing)) < desiredReplicas {
		return false, nil
	}
	if len(role.PodTemplate.Mounts) > 0 && model != nil && model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyPVC {
		pvc := &corev1.PersistentVolumeClaim{}
		err := r.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-model-%s", isvc.Name, modelKeyMain), Namespace: isvc.Namespace}, pvc)
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if pvc.Status.Phase != corev1.ClaimBound {
			return false, nil
		}
	}
	return true, nil
}

// roleStatus builds the status of one role: the static topology plus the
// observed readiness. ReadyReplicas is read from the existing workload's
// status (0 when it does not exist). ServiceName is reported only when the
// role declares a service — a role without one has no Service to point at.
func roleStatus(role *aiv1alpha1.Role, rr *renderer.RenderedRole, isvc *aiv1alpha1.InferenceService, existing client.Object, ready bool) aiv1alpha1.RoleStatus {
	st := aiv1alpha1.RoleStatus{
		Name:          role.Name,
		Kind:          role.Workload.Kind,
		Replicas:      rr.Replicas,
		WorkloadName:  fmt.Sprintf("%s-%s", isvc.Name, role.Name),
		ReadyReplicas: int64(workloadReadyReplicas(existing)),
		Ready:         ready,
	}
	if role.Service != nil {
		st.ServiceName = fmt.Sprintf("%s-%s", isvc.Name, role.Name)
	}
	if role.Workload.Kind == aiv1alpha1.WorkloadKindLeaderWorkerSet {
		st.GroupSize = ptr(rr.GroupSize)
	}
	return st
}

// cleanupOrphanWorkloads deletes the Deployments, LeaderWorkerSets and
// Services this service owns (ownerRef + managed-by label) whose name is no
// longer desired — or whose workload kind changed for a still-desired role
// name (a profile switch turning a role from Deployment to LeaderWorkerSet
// leaves the old-kind workload behind otherwise) — see deleteOrphanWorkload.
// Model PVCs are never touched.
func (r *InferenceServiceReconciler) cleanupOrphanWorkloads(ctx context.Context, isvc *aiv1alpha1.InferenceService, desiredPrefixes map[string]bool, desiredKinds map[string]aiv1alpha1.WorkloadKind) error {
	var deps appsv1.DeploymentList
	if err := r.List(ctx, &deps, client.InNamespace(isvc.Namespace),
		client.MatchingLabels{managedByLabelKey: managedByValue}); err != nil {
		return err
	}
	for i := range deps.Items {
		if err := r.deleteOrphanWorkload(ctx, isvc, desiredPrefixes, desiredKinds, &deps.Items[i]); err != nil {
			return err
		}
	}

	var lws leaderworkersetv1.LeaderWorkerSetList
	if err := r.List(ctx, &lws, client.InNamespace(isvc.Namespace),
		client.MatchingLabels{managedByLabelKey: managedByValue}); err != nil {
		return err
	}
	for i := range lws.Items {
		if err := r.deleteOrphanWorkload(ctx, isvc, desiredPrefixes, desiredKinds, &lws.Items[i]); err != nil {
			return err
		}
	}

	var svcs corev1.ServiceList
	if err := r.List(ctx, &svcs, client.InNamespace(isvc.Namespace),
		client.MatchingLabels{managedByLabelKey: managedByValue}); err != nil {
		return err
	}
	for i := range svcs.Items {
		if err := r.deleteOrphanWorkload(ctx, isvc, desiredPrefixes, desiredKinds, &svcs.Items[i]); err != nil {
			return err
		}
	}
	return nil
}

// deleteOrphanWorkload deletes one listed object when it is no longer desired:
// the name is not a desired prefix, or the name is desired but belongs to a
// workload of a different kind (the role's workload kind changed). The
// ownerRef must point at this service, like cleanupOrphanAssets.
func (r *InferenceServiceReconciler) deleteOrphanWorkload(ctx context.Context, isvc *aiv1alpha1.InferenceService, desiredPrefixes map[string]bool, desiredKinds map[string]aiv1alpha1.WorkloadKind, obj client.Object) error {
	name := obj.GetName()
	if desiredPrefixes[name] {
		// A desired name: keep a Service, and keep a workload whose kind
		// matches the role's. A workload of the old kind shares the name with
		// the Service and the new workload — it must go, the others stay.
		if kind, isWorkload := workloadKindOf(obj); !isWorkload || desiredKinds[name] == kind {
			return nil
		}
	}
	if owner := metav1.GetControllerOf(obj); owner == nil || owner.UID != isvc.UID {
		return nil
	}
	if err := r.Delete(ctx, obj); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

// workloadKindOf maps a workload object to its WorkloadKind; ok=false for
// anything else (Services share the <isvc>-<role> name with workloads and are
// never kind-checked).
func workloadKindOf(obj client.Object) (aiv1alpha1.WorkloadKind, bool) {
	switch obj.(type) {
	case *appsv1.Deployment:
		return aiv1alpha1.WorkloadKindDeployment, true
	case *leaderworkersetv1.LeaderWorkerSet:
		return aiv1alpha1.WorkloadKindLeaderWorkerSet, true
	}
	return "", false
}

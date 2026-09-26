// The development image catalog offered by the create wizard. There is no
// ComputeProfile CR in the operator (the DevEnvironment carries compute inline
// via spec.resources), so the list is simply the platform's own published
// images — one name per image, under the project images/Makefile publishes to.
//
// Each entry also carries the runtime identity that image has to be run as.
// Neither image's layout is discoverable from the cluster: the operator takes
// the account, the workspace mount path and the ssh login from the
// DevEnvironment spec, so pointing an environment at a shipped image means
// stating what the image already is (images/README.md).
//
// The catalog is where that identity is known, so it is both what the wizard
// pre-fills and what the create route falls back to when a client states no
// identity. It is no longer the only source: the wizard lets the user type any
// image reference and edit the account, uid and gid beside it, which the create
// route then honours. That is deliberate — the account/uid pairing belongs to
// the image, not to the platform, and nothing here can check it
// (docs/design/devenv-images/decision.md).

/** One published development image and the identity it must run as. */
export interface DevImage {
  /** Full published reference, written verbatim to spec.image. */
  tag: string;
  /** Short description shown in the wizard's image select. */
  label: string;
  /** spec.runtime.user: the account the image's own sshd serves. */
  user: string;
  /** spec.runtime.securityContext.runAsGroup, when the platform default of 1000 is wrong. */
  runAsGroup?: number;
}

// The platform's own fallbacks, stated once for the wizard and the create
// route: what a DevEnvironment runs as when its image says nothing. The
// controller resolves the same values for an unset spec.runtime — the account
// "user" and a 1000:1000 security context
// (operator/internal/controller/devenvironment_controller.go).
export const PLATFORM_USER = "user";
export const PLATFORM_UID = 1000;
export const PLATFORM_GID = 1000;

const REGISTRY = "harbor.isuanova.com/suanova";

export const DEV_IMAGES: DevImage[] = [
  {
    tag: `${REGISTRY}/jupyter-minimal:latest`,
    label: "suanova/jupyter-minimal · CPU · JupyterLab (jovyan)",
    // Stock-derived overlay: docker-stacks' jovyan is uid 1000 / gid *100*, and
    // no other spec field implies that gid — the platform default is 1000.
    user: "jovyan",
    runAsGroup: 100,
  },
  {
    tag: `${REGISTRY}/ssh-ubuntu22.04:latest`,
    label: "suanova/ssh-ubuntu22.04 · CPU · SSH (ubuntu)",
    // Self-authored family: account ubuntu, uid/gid 1000 — the platform default.
    user: "ubuntu",
  },
  {
    tag: `${REGISTRY}/base-cuda:latest`,
    label: "suanova/base-cuda · NVIDIA CUDA (ubuntu)",
    user: "ubuntu",
  },
  {
    tag: `${REGISTRY}/base-maca:latest`,
    label: "suanova/base-maca · Metax MACA (ubuntu)",
    user: "ubuntu",
  },
];

/**
 * The catalog entry for an image reference, or undefined for an image the
 * platform does not publish. A bring-your-own image resolves to nothing, so it
 * has to state its own runtime identity: the create route falls back to the
 * catalog only, and an environment with no identity at all runs as the
 * platform defaults.
 */
export function devImageFor(tag: string): DevImage | undefined {
  return DEV_IMAGES.find((image) => image.tag === tag);
}

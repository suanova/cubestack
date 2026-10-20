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
  /**
   * The interface the image was built for — the same axis as spec.type, and the
   * reason the vendor images come in pairs. CUBESTACK_IMAGE is baked into each
   * image, so one image cannot serve both a jupyter and an ssh environment: an
   * ssh image under type jupyter runs sshd with nothing serving the token the
   * operator publishes for it (images/README.md).
   */
  interface: "jupyter" | "ssh";
  /**
   * The accelerator stack the image carries — also what the two entries of a
   * pair have in common: cuda-pytorch and ssh-cuda-pytorch are one
   * vendor's stack in two modes. The wizard keeps it across a type change, so
   * an environment moved to ssh from a CUDA jupyter image lands on the CUDA ssh
   * image rather than on the CPU one, which the operator would refuse as a brand
   * mismatch.
   */
  vendor: DevImageVendor;
}

/** The accelerator axis the catalog is split on; `cpu` for the images with none. */
export type DevImageVendor = "cpu" | "nvidia" | "metax";

// The platform's own fallbacks, stated once for the wizard and the create
// route: what a DevEnvironment runs as when its image says nothing. The
// controller resolves the same values for an unset spec.runtime — the account
// "user" and a 1000:1000 security context
// (operator/internal/controller/devenvironment_controller.go).
export const PLATFORM_USER = "user";
export const PLATFORM_UID = 1000;
export const PLATFORM_GID = 1000;

// The registry (host and project path) the platform publishes its images to.
// CUBESTACK_DEV_IMAGE_REGISTRY overrides it (helm: devImageRegistry), so a
// deployment can point the catalog at its own mirror without a rebuild.
const DEFAULT_REGISTRY = "harbor.isuanova.com/suanova";
const REGISTRY =
  (process.env.CUBESTACK_DEV_IMAGE_REGISTRY ?? "").trim().replace(/\/+$/, "") || DEFAULT_REGISTRY;

// The platform's published set (images/README.md), CPU first and then the two
// vendor pairs, in the order the wizard's own accelerator select offers them.
// The superseded base-cuda / base-maca are not here: they are bare vendor SDK
// images with no ENTRYPOINT, no sshd and no launch chain, nothing a
// DevEnvironment can be pointed at (docs/design/devenv-images/decision.md).
export const DEV_IMAGES: DevImage[] = [
  {
    tag: `${REGISTRY}/cpu-pytorch:latest`,
    label: "suanova/cpu-pytorch · CPU · JupyterLab (ubuntu)",
    // Stock-derived overlay: docker-stacks' jovyan is uid 1000 / gid *100*, and
    // no other spec field implies that gid — the platform default is 1000.
    user: "ubuntu",
    interface: "jupyter",
    vendor: "cpu",
  },
  {
    tag: `${REGISTRY}/cpu-pytorch:latest`,
    label: "suanova/cpu-pytorch · CPU · SSH (ubuntu)",
    // Self-authored family: account ubuntu, uid/gid 1000 — the platform default.
    user: "ubuntu",
    interface: "ssh",
    vendor: "cpu",
  },
  {
    tag: `${REGISTRY}/cuda-pytorch:latest`,
    label: "suanova/cuda-pytorch · NVIDIA CUDA · JupyterLab (ubuntu)",
    user: "ubuntu",
    interface: "jupyter",
    vendor: "nvidia",
  },
  {
    tag: `${REGISTRY}/cuda-pytorch:latest`,
    label: "suanova/cuda-pytorch · NVIDIA CUDA · SSH (ubuntu)",
    user: "ubuntu",
    interface: "ssh",
    vendor: "nvidia",
  },
  {
    tag: `${REGISTRY}/maca-pytorch:latest`,
    label: "suanova/maca-pytorch · Metax MACA · JupyterLab (ubuntu)",
    user: "ubuntu",
    interface: "jupyter",
    vendor: "metax",
  },
  {
    tag: `${REGISTRY}/maca-pytorch:latest`,
    label: "suanova/maca-pytorch · Metax MACA · SSH (ubuntu)",
    user: "ubuntu",
    interface: "ssh",
    vendor: "metax",
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

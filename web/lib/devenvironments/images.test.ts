import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_IMAGES, devImageFor } from "./images";

describe("DEV_IMAGES", () => {
  it("names every image with the registry host, so the kubelet can pull it", () => {
    for (const image of DEV_IMAGES) {
      expect(image.tag).toMatch(/^harbor\.isuanova\.com\/suanova\/[a-z0-9.-]+:[a-z0-9.-]+$/);
      expect(image.label).not.toBe("");
    }
  });

  it("names the account every image runs as — no environment should inherit the default", () => {
    // The CRD's default user is "user", which none of the shipped images have:
    // an environment that omitted spec.runtime.user could not log in over ssh.
    for (const image of DEV_IMAGES) {
      expect(image.user).not.toBe("user");
    }
  });

  it("offers the shipped set, and nothing superseded", () => {
    // Stated in full because the catalog drifted silently once already: it kept
    // offering base-cuda and base-maca after both were superseded — bare vendor
    // SDK images with no ENTRYPOINT, no sshd and no launch chain — and never
    // offered the four vendor images the project publishes (images/README.md).
    // Changing the set means changing this list too.
    expect(DEV_IMAGES.map((image) => image.tag)).toEqual([
      "harbor.isuanova.com/suanova/cpu-pytorch:latest",
      "harbor.isuanova.com/suanova/cpu-pytorch:latest",
      "harbor.isuanova.com/suanova/cuda-pytorch:latest",
      "harbor.isuanova.com/suanova/cuda-pytorch:latest",
      "harbor.isuanova.com/suanova/maca-pytorch:latest",
      "harbor.isuanova.com/suanova/maca-pytorch:latest",
    ]);
  });

  it("says which interface each image serves, and offers both of every vendor pair", () => {
    for (const image of DEV_IMAGES) {
      expect(["jupyter", "ssh"]).toContain(image.interface);
    }
    // The vendor images come per interface, because CUBESTACK_IMAGE is baked
    // into the image: one image cannot serve both a jupyter and an ssh
    // environment, which is what the wizard warns about.
    for (const vendor of ["cuda", "maca"]) {
      const pair = DEV_IMAGES.filter((image) => image.tag.includes(vendor)).map((image) => image.interface);
      expect(pair).toEqual(["jupyter", "ssh"]);
    }
  });

  it("says which accelerator each image carries, so a type change can keep it", () => {
    // The vendor is what the two entries of a pair have in common: the wizard
    // moves to this image's counterpart rather than to the first of the new
    // interface, which would put a metax environment on the CPU image — an
    // Accepted=False / BrandMismatch on the cluster.
    expect(DEV_IMAGES.map((image) => [image.tag.split("/").pop(), image.vendor, image.interface])).toEqual([
      ["cpu-pytorch:latest", "cpu", "jupyter"],
      ["cpu-pytorch:latest", "cpu", "ssh"],
      ["cuda-pytorch:latest", "nvidia", "jupyter"],
      ["cuda-pytorch:latest", "nvidia", "ssh"],
      ["maca-pytorch:latest", "metax", "jupyter"],
      ["maca-pytorch:latest", "metax", "ssh"],
    ]);
    // Every vendor with a jupyter image has an ssh one and the other way round,
    // since that is exactly the lookup the wizard performs.
    for (const vendor of ["cpu", "nvidia", "metax"]) {
      const interfaces = DEV_IMAGES.filter((image) => image.vendor === vendor).map((image) => image.interface);
      expect(interfaces.sort()).toEqual(["jupyter", "ssh"]);
    }
  });

  it("states the account each image runs as, and no group the platform default covers", () => {
    // Every shipped image runs 1000:1000 — the platform default — so none pins
    // a securityContext group; the account is the part the image has to state.
    for (const image of DEV_IMAGES) {
      expect(image.user).toBe("ubuntu");
      expect(image.runAsGroup).toBeUndefined();
    }
  });
});

describe("CUBESTACK_DEV_IMAGE_REGISTRY", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("builds every tag under the configured registry host", async () => {
    vi.resetModules();
    vi.stubEnv("CUBESTACK_DEV_IMAGE_REGISTRY", "registry.example.com/");
    const { DEV_IMAGES: images } = await import("./images");
    for (const image of images) {
      expect(image.tag).toMatch(/^registry\.example\.com\/suanova\/[a-z0-9.-]+:[a-z0-9.-]+$/);
    }
  });
});

describe("devImageFor", () => {
  it("resolves each catalog tag, with one image serving both interfaces", () => {
    // A vendor image is listed twice — once per interface — so the pair shares
    // one tag. The lookup answers with the first entry; both state the same
    // account, which is all the create route falls back to.
    for (const image of DEV_IMAGES) {
      const resolved = devImageFor(image.tag);
      expect(resolved).toBeDefined();
      expect(resolved?.tag).toBe(image.tag);
      expect(resolved?.user).toBe(image.user);
    }
  });

  it("resolves nothing for a bring-your-own image", () => {
    expect(devImageFor("harbor.local/ai-images/custom:1.0")).toBeUndefined();
  });
});

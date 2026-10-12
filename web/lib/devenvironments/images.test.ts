import { describe, expect, it } from "vitest";

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
      "harbor.isuanova.com/suanova/jupyter-minimal:latest",
      "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest",
      "harbor.isuanova.com/suanova/jupyter-cuda-pytorch:latest",
      "harbor.isuanova.com/suanova/ssh-cuda-pytorch:latest",
      "harbor.isuanova.com/suanova/jupyter-maca-pytorch:latest",
      "harbor.isuanova.com/suanova/ssh-maca-pytorch:latest",
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
      ["jupyter-minimal:latest", "cpu", "jupyter"],
      ["ssh-ubuntu22.04:latest", "cpu", "ssh"],
      ["jupyter-cuda-pytorch:latest", "nvidia", "jupyter"],
      ["ssh-cuda-pytorch:latest", "nvidia", "ssh"],
      ["jupyter-maca-pytorch:latest", "metax", "jupyter"],
      ["ssh-maca-pytorch:latest", "metax", "ssh"],
    ]);
    // Every vendor with a jupyter image has an ssh one and the other way round,
    // since that is exactly the lookup the wizard performs.
    for (const vendor of ["cpu", "nvidia", "metax"]) {
      const interfaces = DEV_IMAGES.filter((image) => image.vendor === vendor).map((image) => image.interface);
      expect(interfaces.sort()).toEqual(["jupyter", "ssh"]);
    }
  });

  it("states the stock-derived jupyter image's gid, which nothing else implies", () => {
    const jupyter = devImageFor("harbor.isuanova.com/suanova/jupyter-minimal:latest");
    expect(jupyter).toMatchObject({ user: "jovyan", runAsGroup: 100 });

    // The self-authored family runs 1000:1000, the platform default, so it
    // must *not* pin a group — the CRD would otherwise carry a redundant field.
    const ssh = devImageFor("harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest");
    expect(ssh?.user).toBe("ubuntu");
    expect(ssh?.runAsGroup).toBeUndefined();
  });
});

describe("devImageFor", () => {
  it("resolves each catalog entry by its reference", () => {
    for (const image of DEV_IMAGES) {
      expect(devImageFor(image.tag)).toBe(image);
    }
  });

  it("resolves nothing for a bring-your-own image", () => {
    expect(devImageFor("harbor.local/ai-images/custom:1.0")).toBeUndefined();
  });
});

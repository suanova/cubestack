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

"use client";

// External store for the cluster-wide branding (logo + custom wordmark),
// structured like components/cubepilot/tabStore.ts: the shell renders on the
// server with the default brand, then the client fetches
// /api/settings/branding once and re-renders the sidebar and login page. The
// settings page writes through setBranding so a save is visible without a
// reload.

import { useSyncExternalStore } from "react";

import { apiFetch } from "@/lib/base-path";

export interface Branding {
  logo: string | null;
  /** Custom brand name; null means the built-in name. */
  title: string | null;
  /** Custom subtitle; null means the localized built-in tagline. */
  subtitle: string | null;
}

/** Brand name used when the cluster has no custom title. */
export const DEFAULT_BRAND = "CubeStack";

const EMPTY: Branding = { logo: null, title: null, subtitle: null };

let branding: Branding = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeBranding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getBrandingSnapshot = (): Branding => branding;

/** The server has no cluster call at render time: paint the default brand. */
export const getServerBrandingSnapshot = (): Branding => EMPTY;

export function setBranding(next: Partial<Branding>): void {
  branding = { ...branding, ...next };
  emit();
}

/** The live branding, for components that render more than the name. */
export function useBranding(): Branding {
  return useSyncExternalStore(subscribeBranding, getBrandingSnapshot, getServerBrandingSnapshot);
}

/** The effective brand name, for titles and strings that mention it. */
export function useBrandName(): string {
  return useBranding().title || DEFAULT_BRAND;
}

/**
 * Fetch the stored branding once per page load. A failed request leaves the
 * defaults in place; the settings page still reads the cluster directly.
 */
export function ensureBrandingLoaded(): void {
  if (started) return;
  started = true;
  apiFetch("/api/settings/branding")
    .then((res) => (res.ok ? res.json() : null))
    .then((body: Partial<Branding> | null) => {
      if (!body) return;
      setBranding({
        logo: typeof body.logo === "string" ? body.logo : null,
        title: typeof body.title === "string" ? body.title : null,
        subtitle: typeof body.subtitle === "string" ? body.subtitle : null,
      });
    })
    .catch(() => {
      // Keep the defaults; the shell must render regardless.
    });
}

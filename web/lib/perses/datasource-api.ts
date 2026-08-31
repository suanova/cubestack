import {
  DatasourceApi,
  DatasourceResource,
  DatasourceSelector,
  GlobalDatasourceResource,
} from "@perses-dev/core";

import { PERSES_PROXY_BASE_PATH } from "./config";

/**
 * Minimal caching wrapper around the Perses datasource API.
 *
 * The Perses panel system asks for a datasource on every query, so we cache
 * both hits and misses per selector (mirrors the reference's CachedDatasourceAPI,
 * without the LRU/TTL machinery).
 */
class DatasourceCache {
  private readonly hits = new Map<string, DatasourceResource | GlobalDatasourceResource>();
  private readonly misses = new Set<string>();

  get(key: string) {
    if (this.hits.has(key)) {
      return { hit: true, resource: this.hits.get(key) };
    }
    return { hit: this.misses.has(key), resource: undefined };
  }

  set(key: string, resource: DatasourceResource | GlobalDatasourceResource | undefined) {
    if (resource === undefined) {
      this.misses.add(key);
    } else {
      this.hits.set(key, resource);
    }
  }

  static key(selector: DatasourceSelector, project?: string) {
    return [selector.kind, selector.name ?? "*", project ?? ""].join("/");
  }
}

export class PortalDatasourceApi implements DatasourceApi {
  private readonly cache = new DatasourceCache();

  /** Build the URL the browser hits to proxy queries to a datasource. */
  buildProxyUrl({ project, name }: { project?: string; name: string }): string {
    const scope = project
      ? `/proxy/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(name)}`
      : `/proxy/globaldatasources/${encodeURIComponent(name)}`;
    return `${PERSES_PROXY_BASE_PATH}${scope}`;
  }

  async getDatasource(
    project: string,
    selector: DatasourceSelector,
  ): Promise<DatasourceResource | undefined> {
    const key = DatasourceCache.key(selector, project);
    const cached = this.cache.get(key);
    if (cached.hit) {
      return cached.resource as DatasourceResource | undefined;
    }
    const list = await this.listDatasources(project, selector.kind, selector.name, selector.name ? undefined : true);
    this.cache.set(key, list[0]);
    return list[0];
  }

  async getGlobalDatasource(
    selector: DatasourceSelector,
  ): Promise<GlobalDatasourceResource | undefined> {
    const key = DatasourceCache.key(selector);
    const cached = this.cache.get(key);
    if (cached.hit) {
      return cached.resource as GlobalDatasourceResource | undefined;
    }
    const list = await this.listGlobalDatasources(selector.kind, selector.name, selector.name ? undefined : true);
    this.cache.set(key, list[0]);
    return list[0];
  }

  listDatasources(
    project: string,
    pluginKind?: string,
    name?: string,
    defaultDatasource?: boolean,
  ): Promise<DatasourceResource[]> {
    return fetchDatasourceList(project, pluginKind, name, defaultDatasource);
  }

  listGlobalDatasources(
    pluginKind?: string,
    name?: string,
    defaultDatasource?: boolean,
  ): Promise<GlobalDatasourceResource[]> {
    return fetchGlobalDatasourceList(pluginKind, name, defaultDatasource);
  }
}

function buildQueryParams(kind?: string, name?: string, defaultDatasource?: boolean): string {
  const q = new URLSearchParams();
  if (kind !== undefined) q.set("kind", kind);
  if (name !== undefined) q.set("name", name);
  if (defaultDatasource !== undefined) q.set("default", String(defaultDatasource));
  const s = q.toString();
  return s ? `?${s}` : "";
}

function fetchDatasourceList(
  project: string,
  kind?: string,
  name?: string,
  defaultDatasource?: boolean,
): Promise<DatasourceResource[]> {
  return fetchList(
    `/api/v1/projects/${encodeURIComponent(project)}/datasources${buildQueryParams(kind, name, defaultDatasource)}`,
  );
}

function fetchGlobalDatasourceList(
  kind?: string,
  name?: string,
  defaultDatasource?: boolean,
): Promise<GlobalDatasourceResource[]> {
  return fetchList(`/api/v1/globaldatasources${buildQueryParams(kind, name, defaultDatasource)}`);
}

async function fetchList<T>(path: string): Promise<T[]> {
  const res = await fetch(`${PERSES_PROXY_BASE_PATH}${path}`);
  if (!res.ok) {
    throw new Error(`Perses datasource request failed (${res.status})`);
  }
  return res.json();
}

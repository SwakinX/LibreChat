/**
 * Pure catalog × local-state merge for desktop tools: drives the sidebar
 * badges (not installed / installed vX / update available) and the runner
 * switch. The gateway catalog stays the base; installed-but-uncataloged
 * local tools are synthesized into manifest shape so namespace grouping
 * keeps working.
 */

import type { LocalToolRecord } from './toolhost';
import type { ToolManifest } from './types';

export type LocalToolStatus = 'not_installed' | 'installed' | 'update_available';

export type MergedTool = {
  manifest: ToolManifest;
  local?: LocalToolRecord;
  status: LocalToolStatus;
  /** Computed file-presence flag from the Toolhost (1.3.0): install dir or
   * launcher missing. Drives the damaged badge + repair entry. */
  damaged?: boolean;
  /** Admin-approved version from the catalog manifest (contracts 2.8.0:
   * unapproved repo releases are invisible to the frontend). */
  latestVersion?: string;
};

export function isDesktopTool(manifest: ToolManifest): boolean {
  return manifest.execution?.kind === 'desktop';
}

/** 'v'-stripped numeric tuple compare: 1.10.0 > 1.9.0; non-numeric parts score 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): number[] =>
    version
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

export function mergeCatalogWithLocal(
  catalog: ToolManifest[],
  localTools: LocalToolRecord[],
): MergedTool[] {
  const byId = new Map(localTools.map((record) => [record.tool_id, record]));
  const merged: MergedTool[] = catalog.map((manifest) => {
    const local = byId.get(manifest.tool_id);
    byId.delete(manifest.tool_id);
    if (!isDesktopTool(manifest)) {
      /* server/web tools run through the gateway execute path — no local state */
      return { manifest, status: 'installed' };
    }
    if (!local) {
      return { manifest, status: 'not_installed' };
    }
    /* Catalog manifest version is the admin-approved latest (2.8.0 governance):
     * repo releases ahead of it stay hidden until an admin confirms them. */
    const latestVersion = manifest.version;
    const outdated = compareVersions(latestVersion, local.installed_version ?? '') > 0;
    return {
      manifest,
      local,
      status: outdated ? 'update_available' : 'installed',
      damaged: local.damaged === true,
      latestVersion,
    };
  });
  /* Local-only installs (catalog miss / Gitea offline) still show up in the sidebar. */
  for (const local of byId.values()) {
    merged.push({
      manifest: synthesizeManifest(local),
      local,
      status: 'installed',
      damaged: local.damaged === true,
    });
  }
  return merged;
}

/** LocalToolRecord → manifest shape, so a local-only tool flows through the
 * same grouping/runner paths as catalog tools. */
export function synthesizeManifest(record: LocalToolRecord): ToolManifest {
  return {
    schema_version: 1,
    tool_id: record.tool_id,
    version: record.installed_version ?? '',
    display_name: record.name ?? record.tool_id,
    description: record.description ?? '',
    dangerous: record.dangerous ?? false,
    parameters: record.parameters ?? undefined,
    form: (record.form as ToolManifest['form']) ?? undefined,
    result: (record.result as ToolManifest['result']) ?? undefined,
    execution: { kind: 'desktop' },
  };
}

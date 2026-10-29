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

/** Plugin tools (contracts 2.11.0): installed via the Toolhost package
 * lifecycle (install script + host launch), so they share desktop badges. */
export function isPluginTool(manifest: ToolManifest): boolean {
  return manifest.execution?.kind === 'plugin';
}

/** Web-link tools: "run" = open the URL in a new tab; no local state. */
export function isWebTool(manifest: ToolManifest): boolean {
  return manifest.execution?.kind === 'web';
}

/** Tools whose lifecycle (install/update/remove) lives on the local Toolhost. */
export function isLocallyManagedTool(manifest: ToolManifest): boolean {
  return isDesktopTool(manifest) || isPluginTool(manifest);
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

/** repo 通道（2.30.0）的版本锚是 commit SHA——无序，不可跑 semver 比较
 * （"59f352…" vs "7b650d…" 会得出任意方向的假更新）。 */
const SHA_VERSION_RE = /^[0-9a-f]{7,40}$/i;

function isShaVersion(version: string | null | undefined): boolean {
  return !!version && SHA_VERSION_RE.test(version) && !/^\d+\.\d+\.\d+$/.test(version);
}

export function mergeCatalogWithLocal(
  catalog: ToolManifest[],
  localTools: LocalToolRecord[],
): MergedTool[] {
  const byId = new Map(localTools.map((record) => [record.tool_id, record]));
  const merged: MergedTool[] = catalog.map((manifest) => {
    const local = byId.get(manifest.tool_id);
    byId.delete(manifest.tool_id);
    if (!isLocallyManagedTool(manifest)) {
      /* server/web tools run through the gateway execute path — no local state */
      return { manifest, status: 'installed' };
    }
    if (!local) {
      return { manifest, status: 'not_installed' };
    }
    /* Catalog manifest version is the admin-approved latest (2.8.0 governance):
     * repo releases ahead of it stay hidden until an admin confirms them.
     * SHA 锚（repo 通道）无序——仅判等（不同 = 与批准版本不一致，跟随确认更新）。 */
    const latestVersion = manifest.version;
    const outdated =
      isShaVersion(latestVersion) || isShaVersion(local.installed_version)
        ? latestVersion !== (local.installed_version ?? '')
        : compareVersions(latestVersion, local.installed_version ?? '') > 0;
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
    result: (record.result as ToolManifest['result']) ?? undefined,
    execution: { kind: 'desktop' },
  };
}

import type { LocalToolRecord } from '../toolhost';
import type { ToolManifest } from '../types';
import {
  compareVersions,
  isDesktopTool,
  mergeCatalogWithLocal,
  synthesizeManifest,
} from '../toolStatus';

const serverTool: ToolManifest = {
  schema_version: 1,
  tool_id: 'echo.hello',
  version: '1.0.0',
  display_name: 'Echo',
  description: '',
  execution: { kind: 'server', handler: 'echo' },
};

const desktopTool = (tool_id: string, version = '1.0.0'): ToolManifest => ({
  schema_version: 1,
  tool_id,
  version,
  display_name: 'Demo',
  description: '',
  execution: {
    kind: 'desktop',
    distribution: {
      source: { type: 'gitea_release', owner: 'wangjianbo', repo: 'toolsdemo' },
    },
  },
});

const record = (tool_id: string, installed_version: string): LocalToolRecord => ({
  tool_id,
  source: 'tool_package',
  installed_version,
  owner: 'wangjianbo',
  repo: 'toolsdemo',
  name: 'Demo',
});

describe('compareVersions', () => {
  it('compares numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
  });

  it('strips the v prefix', () => {
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('v2.1.0', '2.0.9')).toBeGreaterThan(0);
  });

  it('treats missing parts as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('isDesktopTool', () => {
  it('keys off execution.kind', () => {
    expect(isDesktopTool(desktopTool('demo.pkg'))).toBe(true);
    expect(isDesktopTool(serverTool)).toBe(false);
  });
});

describe('mergeCatalogWithLocal', () => {
  it('leaves server tools untouched (no local management)', () => {
    const merged = mergeCatalogWithLocal([serverTool], [record('echo.hello', '9.9.9')]);
    expect(merged[0]).toEqual({ manifest: serverTool, status: 'installed' });
  });

  it('desktop tool without a local record is not_installed', () => {
    const merged = mergeCatalogWithLocal([desktopTool('demo.pkg')], []);
    expect(merged[0].status).toBe('not_installed');
    expect(merged[0].local).toBeUndefined();
  });

  it('equal versions are installed', () => {
    expect(
      mergeCatalogWithLocal([desktopTool('demo.pkg', '1.0.0')], [record('demo.pkg', '1.0.0')])[0]
        .status,
    ).toBe('installed');
  });

  it('newer admin-approved manifest version marks update_available (2.8.0 governance)', () => {
    const merged = mergeCatalogWithLocal(
      [desktopTool('demo.pkg', '1.1.0')],
      [record('demo.pkg', '1.0.0')],
    );
    expect(merged[0].status).toBe('update_available');
    expect(merged[0].latestVersion).toBe('1.1.0');
  });

  it('appends local-only installs as synthesized manifests', () => {
    const merged = mergeCatalogWithLocal([], [record('solo.tool', '2.3.4')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('installed');
    expect(merged[0].manifest.tool_id).toBe('solo.tool');
    expect(merged[0].manifest.execution?.kind).toBe('desktop');
    expect(merged[0].manifest.version).toBe('2.3.4');
  });

  it('propagates the damaged flag for catalog and local-only entries only when true', () => {
    const healthy = record('demo.pkg', '1.0.0');
    const broken = { ...record('demo.broken', '1.0.0'), damaged: true };
    const solo = { ...record('solo.tool', '2.3.4'), damaged: true };

    const merged = mergeCatalogWithLocal(
      [desktopTool('demo.pkg', '1.0.0'), desktopTool('demo.broken', '1.0.0')],
      [healthy, broken, solo],
    );

    const byId = new Map(merged.map((entry) => [entry.manifest.tool_id, entry]));
    expect(byId.get('demo.pkg')?.damaged).toBe(false);
    expect(byId.get('demo.broken')?.damaged).toBe(true);
    expect(byId.get('solo.tool')?.damaged).toBe(true);
  });
});

describe('synthesizeManifest', () => {
  it('maps a local record into manifest shape', () => {
    const manifest = synthesizeManifest({
      tool_id: 'solo.tool',
      source: 'tool_package',
      name: 'Solo',
      description: 'local only',
      installed_version: '2.0.0',
      dangerous: true,
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      result: { renderer: 'text' },
    });
    expect(manifest.display_name).toBe('Solo');
    expect(manifest.dangerous).toBe(true);
    expect(manifest.parameters?.properties?.q).toEqual({ type: 'string' });
    expect(manifest.result?.renderer).toBe('text');
  });
});

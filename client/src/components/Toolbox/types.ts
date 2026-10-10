/** Tool Manifest v1 (terravox-contracts) — the subset the toolbox UI consumes. */

export type FieldHint = {
  label?: string;
  help?: string;
  placeholder?: string;
  widget?:
    | 'text'
    | 'textarea'
    | 'number'
    | 'select'
    | 'multiselect'
    | 'checkbox'
    | 'date'
    | 'datetime'
    | 'file'
    | 'directory'
    | 'hidden'
    /** 2.15.0: browser file bytes go through the multipart execute channel
     * (distinct from 'file' = a local path string). */
    | 'upload';
  choices?: string[];
  /** Extension filter for the file widget (2.13.0): leading-dot entries
   * like ['.gdb', '.shp'] — the native dialog shows matching files only. */
  accept?: string[];
  choices_from?: { tool: string; value_field?: string; label_field?: string };
};

export type ToolManifest = {
  schema_version: 1;
  tool_id: string;
  version: string;
  display_name: string;
  description: string;
  expose?: string[];
  allowed_groups?: string[];
  enabled?: boolean;
  dangerous?: boolean;
  /** 2.16.0 presentation group (sidebar grouping); empty = tool_id namespace. */
  display_group?: string;
  /** 2.22.0 display order within its display_group: ascending; unset sinks
   * after ordered tools (then tool_id). Ordering is applied gateway-side. */
  display_order?: number;
  /** 2.16.0 help doc URL — header help button; absent = no button. */
  help_url?: string;
  /** 2.16.0 usage-stats opt-out (gateway stops writing run_reports). */
  usage_stats?: boolean;
  parameters?: {
    type: 'object';
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  form?: {
    order?: string[];
    fields?: Record<string, FieldHint>;
  };
  execution?: {
    kind: string;
    handler?: string;
    /** web arm (2.11.0): open in a new tab; no server execution. */
    url?: string;
    catalog_tool_id?: string;
    /** desktop arm: where the Toolhost pulls the package from. */
    distribution?: {
      source?: {
        type: 'gitea_release' | 'gitea_repo';
        owner: string;
        repo: string;
        /** gitea_repo（2.30.0）：跟踪分支，缺省 main。 */
        ref?: string;
      };
      /** Supplemental fields (tool.json fallback), trusted because admin-registered. */
      version?: string;
      package_sha256?: string;
      launcher?: string;
      runtime?: 'self-contained' | 'standard-python' | 'arcpy3';
      /** gitea_repo（2.30.0）：单脚本入口（仓库内相对路径）。 */
      entry?: string;
      /** plugin arm (2.11.0): host-software launch registration. */
      host_launcher?: string;
      host_root_hints?: string[];
      install_script?: string;
      uninstall_script?: string;
    };
  };
  /** 脚本合集（2.30.0）：存在时为合集形态——前端按脚本切换参数表单，
   * 执行参数 = {script: id, ...该脚本参数}。同步自仓库 tool.json。 */
  scripts?: Array<{
    id: string;
    name: string;
    description?: string;
    entry: string;
    dangerous?: boolean;
    parameters: ToolManifest['parameters'];
    form?: ToolManifest['form'];
  }>;
  result?: {
    renderer?: 'table' | 'map' | 'file' | 'link' | 'text' | 'markdown' | 'json';
    config?: { columns?: string[]; title?: string };
  };
  timeout_seconds?: number;
};

export type ExecuteResult = {
  run_id: string;
  tool_id: string;
  renderer: string;
  result: unknown;
};

export type NextcloudStatus = { linked: boolean; login_name?: string; linked_at?: string };

export type LinkState = { link_id: string; login_url: string };
export type LinkPoll = { status: 'pending' | 'linked' | 'expired' | 'failed'; login_name?: string };

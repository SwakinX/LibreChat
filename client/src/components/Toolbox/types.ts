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
    | 'hidden';
  choices?: string[];
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
    catalog_tool_id?: string;
    /** desktop arm: where the Toolhost pulls the package from. */
    distribution?: {
      source?: { type: 'gitea_release'; owner: string; repo: string };
      /** Supplemental fields (tool.json fallback), trusted because admin-registered. */
      version?: string;
      package_sha256?: string;
      launcher?: string;
      runtime?: 'self-contained' | 'standard-python' | 'arcpy3';
    };
  };
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

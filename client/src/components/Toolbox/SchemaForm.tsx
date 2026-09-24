import { useMemo } from 'react';
import type { FieldHint, ToolManifest } from './types';
import { useLocalize } from '~/hooks';

type SchemaFormProps = {
  manifest: ToolManifest;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
};

type FieldDef = {
  name: string;
  hint: FieldHint;
  required: boolean;
  type: string;
  enumValues?: string[];
  default?: unknown;
};

/**
 * Minimal JSON-Schema-driven form generator for Tool Manifest parameters.
 * Deliberately dependency-free (no rjsf/formily) to keep fork drift low;
 * covers the v1 parameter surface: string/number/boolean + enums.
 */
export default function SchemaForm({ manifest, values, onChange, disabled }: SchemaFormProps) {
  const localize = useLocalize();
  const fields = useMemo<FieldDef[]>(() => {
    const props = manifest.parameters?.properties ?? {};
    const hints = manifest.form?.fields ?? {};
    const order = manifest.form?.order;
    const required = new Set(manifest.parameters?.required ?? []);
    const names = [...(order ?? []), ...Object.keys(props).filter((n) => !order?.includes(n))];
    return names
      .filter((name) => props[name] && hints[name]?.widget !== 'hidden')
      .map((name) => {
        const prop = props[name] as Record<string, unknown>;
        const enumValues = Array.isArray(prop.enum) ? (prop.enum as string[]) : undefined;
        return {
          name,
          hint: hints[name] ?? {},
          required: required.has(name),
          type: typeof prop.type === 'string' ? prop.type : 'string',
          enumValues,
          default: prop.default,
        };
      });
  }, [manifest]);

  const set = (name: string, value: unknown) => onChange({ ...values, [name]: value });

  const renderControl = (field: FieldDef, value: unknown) => {
    const commonCls =
      'flex w-full rounded-md border border-border-medium bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-border-xheavy focus:outline-none disabled:opacity-50';
    if (field.enumValues) {
      return (
        <select
          className={commonCls}
          disabled={disabled}
          value={String(value ?? '')}
          onChange={(e) =>
            set(
              field.name,
              field.type === 'number' || field.type === 'integer'
                ? Number(e.target.value)
                : e.target.value,
            )
          }
        >
          <option value="">—</option>
          {field.enumValues.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    if (field.type === 'boolean') {
      return (
        <input
          type="checkbox"
          className="size-4 rounded border-border-medium accent-indigo-500"
          disabled={disabled}
          checked={Boolean(value)}
          onChange={(e) => set(field.name, e.target.checked)}
        />
      );
    }
    if (field.hint.widget === 'textarea') {
      return (
        <textarea
          className={`${commonCls} min-h-[80px]`}
          disabled={disabled}
          placeholder={field.hint.placeholder}
          value={String(value ?? '')}
          onChange={(e) => set(field.name, e.target.value)}
        />
      );
    }
    if (field.type === 'number' || field.type === 'integer') {
      return (
        <input
          type="number"
          className={commonCls}
          disabled={disabled}
          placeholder={field.hint.placeholder}
          value={value === '' ? '' : Number(value)}
          onChange={(e) => set(field.name, e.target.value === '' ? '' : Number(e.target.value))}
        />
      );
    }
    return (
      <input
        type="text"
        className={commonCls}
        disabled={disabled}
        placeholder={field.hint.placeholder}
        value={String(value ?? '')}
        onChange={(e) => set(field.name, e.target.value)}
      />
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => {
        const label = field.hint.label ?? field.name;
        const value = values[field.name] ?? field.default ?? '';
        return (
          <label key={field.name} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-primary">
              {label}
              {field.required && <span className="text-text-error ml-0.5">*</span>}
            </span>
            {renderControl(field, value)}
            {field.hint.help && (
              <span className="text-xs text-text-tertiary">{field.hint.help}</span>
            )}
          </label>
        );
      })}
      {fields.length === 0 && (
        <p className="text-sm text-text-tertiary">{localize('com_toolbox_no_params')}</p>
      )}
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import { Calendar, FolderOpen } from 'lucide-react';
import type { FieldHint, ToolManifest } from './types';
import type { ChoiceOption } from './api';
import { pickLocalPath } from './toolhost';
import { useChoicesFrom } from './api';
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
 * JSON-Schema-driven form generator for Tool Manifest parameters.
 * Deliberately dependency-free (no rjsf/formily) to keep fork drift low;
 * covers the v1 parameter surface (contracts 2.11.0): string/number/boolean/
 * enums + multiselect, date, datetime, file, directory, static choices and
 * dynamic choices_from. file/directory take absolute local paths (no upload —
 * desktop tools read/write them on the user's machine).
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
    const choices = staticChoices(field);

    /* multiselect: checkbox group over choices/enum (array of strings). */
    if (
      field.hint.widget === 'multiselect' ||
      (field.type === 'array' && (choices || field.enumValues))
    ) {
      return (
        <MultiSelectControl
          field={field}
          staticOptions={choices}
          value={Array.isArray(value) ? (value as unknown[]).map(String) : []}
          disabled={disabled}
          commonCls={commonCls}
          onToggle={(option, checked) => {
            const current = Array.isArray(value) ? (value as unknown[]).map(String) : [];
            set(
              field.name,
              checked ? [...current, option] : current.filter((item) => item !== option),
            );
          }}
        />
      );
    }
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
    if (field.hint.choices_from) {
      return (
        <ChoicesControl
          hint={field.hint}
          value={String(value ?? '')}
          disabled={disabled}
          commonCls={commonCls}
          onChange={(next) => set(field.name, next)}
        />
      );
    }
    if (field.hint.choices) {
      return (
        <select
          className={commonCls}
          disabled={disabled}
          value={String(value ?? '')}
          onChange={(e) => set(field.name, e.target.value)}
        >
          <option value="">—</option>
          {field.hint.choices.map((opt) => (
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
    if (field.hint.widget === 'date') {
      return (
        <PickerInput
          inputType="date"
          disabled={disabled}
          value={String(value ?? '')}
          iconLabel={localize('com_toolbox_widget_open_calendar')}
          onChange={(next) => set(field.name, next)}
        />
      );
    }
    if (field.hint.widget === 'datetime') {
      return (
        <PickerInput
          inputType="datetime-local"
          disabled={disabled}
          value={String(value ?? '')}
          iconLabel={localize('com_toolbox_widget_open_calendar')}
          onChange={(next) => set(field.name, next)}
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
    if (field.hint.widget === 'file' || field.hint.widget === 'directory') {
      return (
        <PathPickInput
          mode={field.hint.widget === 'file' ? 'file' : 'directory'}
          accept={field.hint.accept}
          disabled={disabled}
          placeholder={
            field.hint.placeholder ??
            (field.hint.widget === 'file'
              ? localize('com_toolbox_widget_file_placeholder')
              : localize('com_toolbox_widget_directory_placeholder'))
          }
          browseLabel={localize('com_toolbox_widget_browse')}
          value={String(value ?? '')}
          dialogTitle={field.hint.label || field.name}
          onChange={(next) => set(field.name, next)}
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

/** Static options: hint.choices wins, schema enum is the fallback. */
function staticChoices(field: FieldDef): string[] | undefined {
  if (field.hint.choices?.length) {
    return field.hint.choices;
  }
  return field.enumValues;
}

function MultiSelectControl({
  field,
  staticOptions,
  value,
  disabled,
  commonCls,
  onToggle,
}: {
  field: FieldDef;
  staticOptions?: string[];
  value: string[];
  disabled?: boolean;
  commonCls: string;
  onToggle: (option: string, checked: boolean) => void;
}) {
  const localize = useLocalize();
  const dynamic = useChoicesFrom(field.hint.choices_from);
  if (dynamic.data) {
    return (
      <OptionCheckGroup
        options={dynamic.data}
        value={value}
        disabled={disabled}
        onToggle={onToggle}
      />
    );
  }
  if (dynamic.isError) {
    return <p className="text-text-error text-xs">{localize('com_toolbox_choices_failed')}</p>;
  }
  if (staticOptions?.length) {
    return (
      <OptionCheckGroup
        options={staticOptions.map((opt) => ({ value: opt, label: opt }))}
        value={value}
        disabled={disabled}
        onToggle={onToggle}
      />
    );
  }
  if (dynamic.isLoading) {
    return <p className={commonCls}>{localize('com_toolbox_choices_loading')}</p>;
  }
  return <p className="text-xs text-text-tertiary">{localize('com_toolbox_choices_empty')}</p>;
}

function OptionCheckGroup({
  options,
  value,
  disabled,
  onToggle,
}: {
  options: ChoiceOption[];
  value: string[];
  disabled?: boolean;
  onToggle: (option: string, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="group">
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-1.5 text-sm text-text-secondary">
          <input
            type="checkbox"
            aria-label={option.label}
            className="size-4 rounded border-border-medium accent-indigo-500"
            disabled={disabled}
            checked={value.includes(option.value)}
            onChange={(e) => onToggle(option.value, e.target.checked)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function ChoicesControl({
  hint,
  value,
  disabled,
  commonCls,
  onChange,
}: {
  hint: FieldHint;
  value: string;
  disabled?: boolean;
  commonCls: string;
  onChange: (next: string) => void;
}) {
  const localize = useLocalize();
  const dynamic = useChoicesFrom(hint.choices_from);
  if (dynamic.isError) {
    return <p className="text-text-error text-xs">{localize('com_toolbox_choices_failed')}</p>;
  }
  if (!dynamic.data) {
    return <p className={commonCls}>{localize('com_toolbox_choices_loading')}</p>;
  }
  return (
    <select
      className={commonCls}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {dynamic.data.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* Combo shell: one bordered box (same border/radius/focus ring as every
 * other input) with a bare input and an inline action button inside — the
 * button reads as part of the control instead of a sibling element. */
const COMBO_SHELL =
  'flex w-full items-stretch overflow-hidden rounded-md border border-border-medium bg-surface-primary text-sm focus-within:border-border-xheavy';
const COMBO_INPUT =
  'min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-text-primary placeholder-text-tertiary outline-none';
const COMBO_BUTTON =
  'flex shrink-0 items-center gap-1.5 border-l border-border-medium px-2.5 py-2 text-xs text-text-secondary transition-colors hover:bg-surface-active-alt';

/** date/datetime input with an explicit calendar button: the native picker
 * indicator is easy to miss, so the button calls input.showPicker() (Chromium
 * 99+) to pop the calendar on demand. */
function PickerInput({
  inputType,
  disabled,
  value,
  iconLabel,
  onChange,
}: {
  inputType: 'date' | 'datetime-local';
  disabled?: boolean;
  value: string;
  iconLabel: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={COMBO_SHELL}>
      <input
        ref={inputRef}
        type={inputType}
        className={COMBO_INPUT}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-label={iconLabel}
        title={iconLabel}
        disabled={disabled}
        className={COMBO_BUTTON}
        onClick={() => {
          inputRef.current?.focus();
          inputRef.current?.showPicker?.();
        }}
      >
        <Calendar className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** file/directory input + a Browse button that opens the NATIVE Windows
 * dialog via the local Toolhost (browsers never expose local paths). */
function PathPickInput({
  mode,
  accept,
  disabled,
  placeholder,
  browseLabel,
  value,
  dialogTitle,
  onChange,
}: {
  mode: 'file' | 'directory';
  /** Extension filter (2.13.0), forwarded to the native dialog. */
  accept?: string[];
  disabled?: boolean;
  placeholder?: string;
  browseLabel: string;
  value: string;
  dialogTitle: string;
  onChange: (next: string) => void;
}) {
  const localize = useLocalize();
  const [picking, setPicking] = useState(false);
  const browse = async () => {
    setPicking(true);
    try {
      const path = await pickLocalPath(mode, dialogTitle, accept);
      if (path) {
        onChange(path);
      }
    } catch {
      /* Toolhost offline or pick failed — the text input stays usable. */
    } finally {
      setPicking(false);
    }
  };
  return (
    <div className={COMBO_SHELL}>
      <input
        type="text"
        className={COMBO_INPUT}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        disabled={disabled || picking}
        className={COMBO_BUTTON}
        onClick={() => void browse()}
      >
        <FolderOpen className="size-4" aria-hidden="true" />
        {picking ? localize('com_toolbox_widget_picking') : browseLabel}
      </button>
    </div>
  );
}

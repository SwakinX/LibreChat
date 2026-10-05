import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { useChoicesFrom } from '../api';
import SchemaForm from '../SchemaForm';

/* Contracts 2.11.0 widgets: multiselect, date, datetime, file, directory,
 * static choices and dynamic choices_from. */

jest.mock('../api', () => ({
  useChoicesFrom: jest.fn(),
  useCloudBrowse: () => ({ data: undefined, isLoading: false, isError: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join(',')}` : key,
}));

const manifest = {
  schema_version: 1 as const,
  tool_id: 'demo.params',
  version: '1.1.0',
  display_name: '参数控件演示',
  description: '',
  parameters: {
    type: 'object' as const,
    properties: {
      tags: { type: 'array', items: { type: 'string' } },
      export_date: { type: 'string' },
      run_at: { type: 'string' },
      source_file: { type: 'string' },
      out_dir: { type: 'string' },
      region: { type: 'string' },
      format: { type: 'string' },
    },
  },
  form: {
    order: ['tags', 'export_date', 'run_at', 'source_file', 'out_dir', 'region', 'format'],
    fields: {
      tags: { widget: 'multiselect' as const, label: '输出格式', choices: ['gdb', 'shp', 'udbx'] },
      export_date: { widget: 'date' as const, label: '导出日期' },
      run_at: { widget: 'datetime' as const, label: '执行时间' },
      source_file: { widget: 'file' as const, label: '输入文件' },
      out_dir: { widget: 'directory' as const, label: '输出目录' },
      region: {
        widget: 'select' as const,
        label: '大区',
        choices_from: { tool: 'demo.options', value_field: 'id', label_field: 'name' },
      },
      format: { widget: 'select' as const, label: '静态选择', choices: ['a', 'b'] },
    },
  },
};

/** Source-less calls (static multiselect) get a loading query; calls with a
 * choices_from tool get the fixture rows — mirrors the enabled flag. */
function mockChoices(data?: { value: string; label: string }[]) {
  (useChoicesFrom as jest.Mock).mockImplementation((source?: { tool?: string }) =>
    source
      ? { data: data ?? [], isLoading: false, isError: false }
      : { data: undefined, isLoading: true, isError: false },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockChoices();
});

/** Controlled harness so toggles accumulate like the real page. */
function Harness({ manifest }: { manifest: typeof manifest }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return <SchemaForm manifest={manifest} values={values} onChange={setValues} />;
}

describe('SchemaForm v1 widgets', () => {
  it('renders a checkbox group for multiselect and toggles array values', async () => {
    render(<Harness manifest={manifest} />);

    const gdb = screen.getByRole('checkbox', { name: 'gdb' });
    const shp = screen.getByRole('checkbox', { name: 'shp' });
    expect(gdb).not.toBeChecked();
    await userEvent.click(gdb);
    expect(gdb).toBeChecked();
    expect(shp).not.toBeChecked();
    await userEvent.click(shp);
    expect(shp).toBeChecked();
    await userEvent.click(gdb);
    expect(gdb).not.toBeChecked();
    expect(shp).toBeChecked();
  });

  it('renders native date and datetime inputs carrying their values', async () => {
    const onChange = jest.fn();
    render(<SchemaForm manifest={manifest} values={{}} onChange={onChange} />);

    const date = screen.getByLabelText('导出日期') as HTMLInputElement;
    expect(date.type).toBe('date');
    await userEvent.type(date, '2026-09-28');
    expect(onChange).toHaveBeenLastCalledWith({ export_date: '2026-09-28' });

    const datetime = screen.getByLabelText('执行时间') as HTMLInputElement;
    expect(datetime.type).toBe('datetime-local');
  });

  it('renders file/directory inputs with localized path placeholders', () => {
    render(<SchemaForm manifest={manifest} values={{}} onChange={jest.fn()} />);
    expect(screen.getByPlaceholderText('com_toolbox_widget_file_placeholder')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('com_toolbox_widget_directory_placeholder'),
    ).toBeInTheDocument();
  });

  it('loads choices_from options dynamically and selects one', async () => {
    mockChoices([
      { value: 'north', label: '北方大区' },
      { value: 'south', label: '南方大区' },
    ]);
    const onChange = jest.fn();
    render(<SchemaForm manifest={manifest} values={{}} onChange={onChange} />);

    // region（动态）与 format（静态 choices）两条 select 都渲染
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(2);
    const region = screen.getByLabelText('大区') as HTMLSelectElement;
    await userEvent.selectOptions(region, 'north');
    expect(onChange).toHaveBeenLastCalledWith({ region: 'north' });
  });

  it('shows the failure note when the choices source errors', () => {
    (useChoicesFrom as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<SchemaForm manifest={manifest} values={{}} onChange={jest.fn()} />);
    expect(screen.getAllByText('com_toolbox_choices_failed').length).toBeGreaterThan(0);
  });

  it('renders static choices for a plain select without dynamic sources', async () => {
    (useChoicesFrom as jest.Mock).mockReturnValue({
      data: [{ value: 'north', label: '北方大区' }],
      isLoading: false,
      isError: false,
    });
    const onChange = jest.fn();
    render(<SchemaForm manifest={manifest} values={{}} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('静态选择'), 'b');
    expect(onChange).toHaveBeenLastCalledWith({ format: 'b' });
  });

  it('renders form-only upload fields (no properties entry) without crashing', () => {
    /* ParamBuilder 生成的上传参数只写 form.fields 不进 properties（contracts
     * 2.15.0）——此前 prop.enum 直接 TypeError 整页崩（2026-10-05 实测）。 */
    const uploadOnly = {
      ...manifest,
      parameters: { type: 'object' as const, properties: {} },
      form: {
        order: ['attachment'],
        fields: { attachment: { widget: 'upload' as const, label: '附件' } },
      },
    };
    const onChange = jest.fn();
    render(<SchemaForm manifest={uploadOnly} values={{}} onChange={onChange} />);
    expect(screen.getByText('附件')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_widget_pick_file')).toBeInTheDocument();
  });
});

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
      tags: {
        type: 'array',
        items: { type: 'string' },
        enum: ['gdb', 'shp', 'udbx'],
        title: '输出格式',
        widget: 'multiselect' as const,
      },
      export_date: { type: 'string', title: '导出日期', widget: 'date' as const },
      run_at: { type: 'string', title: '执行时间', widget: 'datetime' as const },
      source_file: { type: 'string', title: '输入文件', widget: 'file' as const },
      out_dir: { type: 'string', title: '输出目录', widget: 'directory' as const },
      region: {
        type: 'string',
        title: '大区',
        widget: 'select' as const,
        choices_from: { tool: 'demo.options', value_field: 'id', label_field: 'name' },
      },
      format: {
        type: 'string',
        title: '静态选择',
        enum: ['a', 'b'],
        widget: 'select' as const,
      },
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
function Harness({ manifest: m }: { manifest: typeof manifest }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return <SchemaForm manifest={m} values={values} onChange={setValues} />;
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

  it('degrades choices_from fields to manual inputs when the source errors', async () => {
    /* 契约（manifest v1 choices_from）：来源工具对当前用户不可见时降级为
     * 手输——错误文案只作提示线，字段仍可填写提交。 */
    (useChoicesFrom as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<Harness manifest={manifest} />);
    /* 带静态选项的多选字段优先回退到静态选项组（优雅降级） */
    expect(screen.getByLabelText('gdb')).toBeInTheDocument();
    /* 无静态选项的单选字段降级为手输，值可正常提交 */
    await userEvent.type(screen.getByLabelText('大区'), '北方大区');
    expect(screen.getByLabelText('大区')).toHaveValue('北方大区');
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

  it('renders upload fields declared in properties without crashing', () => {
    /* 3.0.0：upload 字段与普通字段一样声明在 properties（widget: upload），
     * multipart 通道语义不变。 */
    const uploadManifest = {
      ...manifest,
      parameters: {
        type: 'object' as const,
        properties: {
          attachment: { type: 'string', title: '附件', widget: 'upload' as const },
        },
      },
    };
    const onChange = jest.fn();
    render(<SchemaForm manifest={uploadManifest} values={{}} onChange={onChange} />);
    expect(screen.getByText('附件')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_widget_pick_file')).toBeInTheDocument();
  });
});

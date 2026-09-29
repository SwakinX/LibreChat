/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { InstallJob, LocalRun } from '../toolhost';
import type { MergedTool } from '../toolStatus';
import LocalRunner from '../LocalRunner';

/* Controllable hook state — LocalRunner consumes these hooks. */
const mockHooks = {
  install: { isLoading: false, error: null as unknown, mutateAsync: jest.fn() },
  remove: { isLoading: false, error: null as unknown, mutate: jest.fn() },
  job: { data: null as InstallJob | null },
  startRun: { isLoading: false, error: null as unknown, mutateAsync: jest.fn() },
  run: { data: null as LocalRun | null },
  stopRun: { isLoading: false, mutate: jest.fn() },
  logs: { data: null as { stdout: string[]; stderr: string[] } | null },
  runs: { data: null as { runs: LocalRun[] } | null },
  health: { data: true as boolean | undefined },
};

const mockReport = { mutate: jest.fn() };
const mockInvalidate = jest.fn();

jest.mock('../toolhostHooks', () => ({
  useInstallTool: () => mockHooks.install,
  useDeleteLocalTool: () => mockHooks.remove,
  useInstallJob: () => mockHooks.job,
  useStartLocalRun: () => mockHooks.startRun,
  useLocalRun: () => mockHooks.run,
  useStopRun: () => mockHooks.stopRun,
  useRunLogs: () => mockHooks.logs,
  useRunsForTool: () => mockHooks.runs,
  useToolhostHealth: () => mockHooks.health,
}));

jest.mock('../api', () => ({
  useReportToolRun: () => mockReport,
  /* CloudPickerDialog (SchemaForm upload) needs a benign browse hook */
  useCloudBrowse: () => ({ data: undefined, isLoading: false, isError: false }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

/* Keys pass through; option values appended so interpolated texts are assertable. */
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join(',')}` : key,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

jest.mock('../ResultView', () => (props: { outcome: { result: unknown } }) => (
  <div data-testid="result-view">{JSON.stringify(props.outcome.result)}</div>
));

const DISTRIBUTION = {
  source: { type: 'gitea_release' as const, owner: 'wangjianbo', repo: 'toolsdemo' },
  launcher: 'main.py',
  runtime: 'standard-python' as const,
};

const tool = (over: Partial<MergedTool> = {}): MergedTool => ({
  manifest: {
    schema_version: 1,
    tool_id: 'wangjianbo.toolsdemo',
    version: '1.0.0',
    display_name: 'Demo',
    description: 'd',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execution: { kind: 'desktop', distribution: DISTRIBUTION },
    result: { renderer: 'json' },
  },
  status: 'not_installed',
  ...over,
});

const local = (installed_version: string) => ({
  tool_id: 'wangjianbo.toolsdemo',
  source: 'tool_package',
  installed_version,
  owner: 'wangjianbo',
  repo: 'toolsdemo',
});

const job = (state: InstallJob['state'], over: Partial<InstallJob> = {}): InstallJob => ({
  job_id: 'j1',
  tool_id: 'wangjianbo.toolsdemo',
  owner: 'wangjianbo',
  repo: 'toolsdemo',
  version: '1.0.0',
  state,
  progress_percent: null,
  error: null,
  created_at: 't',
  finished_at: null,
  ...over,
});

beforeEach(() => {
  mockHooks.install = { isLoading: false, error: null, mutateAsync: jest.fn() };
  mockHooks.remove = { isLoading: false, error: null, mutate: jest.fn() };
  mockHooks.job = { data: null };
  mockHooks.startRun = { isLoading: false, error: null, mutateAsync: jest.fn() };
  mockHooks.run = { data: null };
  mockHooks.stopRun = { isLoading: false, mutate: jest.fn() };
  mockHooks.logs = { data: null };
  mockHooks.runs = { data: null };
  mockHooks.health = { data: true };
  mockReport.mutate = jest.fn();
  mockInvalidate.mockClear();
});

describe('LocalRunner', () => {
  it('not installed: install button posts the exact body (fallback, no stray fields)', async () => {
    mockHooks.install.mutateAsync.mockResolvedValue({ job_id: 'j1' });
    mockHooks.job.data = job('downloading', { progress_percent: 42 });
    render(<LocalRunner tool={tool()} />);

    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_install/ }));
    await waitFor(() =>
      expect(mockHooks.install.mutateAsync).toHaveBeenCalledWith({
        tool_id: 'wangjianbo.toolsdemo',
        owner: 'wangjianbo',
        repo: 'toolsdemo',
        fallback: { launcher: 'main.py', runtime: 'standard-python' },
      }),
    );
    /* job accepted → progress bar with the download stage + percent */
    const progress = await screen.findByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText(/com_toolbox_stage_downloading/)).toBeInTheDocument();
  });

  it('failed job: alert with the mapped error code and raw message', async () => {
    mockHooks.install.mutateAsync.mockResolvedValue({ job_id: 'j1' });
    mockHooks.job.data = job('failed', {
      error: { code: 'checksum_mismatch', message: 'sha mismatch: abc' },
    });
    render(<LocalRunner tool={tool()} />);

    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_install/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('com_toolbox_install_failed');
    expect(alert).toHaveTextContent('com_toolbox_err_checksum_mismatch');
    expect(alert).toHaveTextContent('sha mismatch: abc');
  });

  it('installed: remove is two-step inline confirmation', () => {
    const merged = tool({ status: 'installed', local: local('1.0.0') });
    render(<LocalRunner tool={merged} />);

    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_remove/ }));
    expect(screen.getByText('com_toolbox_remove_confirm')).toBeInTheDocument();
    /* first click only reveals the confirmation — nothing deleted yet */
    expect(mockHooks.remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_remove_confirm_yes/ }));
    expect(mockHooks.remove.mutate).toHaveBeenCalledWith('wangjianbo.toolsdemo');
  });

  it('update available: upgrade button targets the catalog latest version', async () => {
    mockHooks.install.mutateAsync.mockResolvedValue({ job_id: 'j1' });
    const merged = tool({
      status: 'update_available',
      latestVersion: '1.1.0',
      local: local('1.0.0'),
    });
    render(<LocalRunner tool={merged} />);

    const button = screen.getByRole('button', { name: 'com_toolbox_update_to:1.1.0' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(mockHooks.install.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ version: '1.1.0' }),
      ),
    );
  });

  it('dangerous tool: run stays disabled until acknowledged, then posts {arguments} only', () => {
    const merged = tool({
      status: 'installed',
      local: local('1.0.0'),
      manifest: {
        ...tool().manifest,
        dangerous: true,
      },
    });
    render(<LocalRunner tool={merged} />);

    const runButton = screen.getByRole('button', { name: /com_toolbox_run/ });
    expect(runButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(runButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/text/), { target: { value: '你好 world' } });
    fireEvent.click(runButton);
    expect(mockHooks.startRun.mutateAsync).toHaveBeenCalledWith({
      toolId: 'wangjianbo.toolsdemo',
      arguments: { text: '你好 world' },
    });
  });

  it('succeeded run renders the local result inline', () => {
    mockHooks.run.data = {
      run_id: 'r1',
      tool_id: 'wangjianbo.toolsdemo',
      status: 'succeeded',
      result: { chars: 5 },
    };
    const merged = tool({ status: 'installed', local: local('1.0.0') });
    render(<LocalRunner tool={merged} />);

    expect(screen.getByTestId('result-view')).toHaveTextContent('"chars":5');
  });

  it('failed run shows status, exit code and toggleable logs', () => {
    mockHooks.run.data = {
      run_id: 'r1',
      tool_id: 'wangjianbo.toolsdemo',
      status: 'failed',
      exit_code: 3,
      error: 'boom',
    };
    const merged = tool({ status: 'installed', local: local('1.0.0') });
    render(<LocalRunner tool={merged} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('com_toolbox_run_failed');
    expect(alert).toHaveTextContent('exit 3');
    expect(screen.queryByText(/stdout/)).not.toBeInTheDocument();

    mockHooks.logs.data = { stdout: ['line-out'], stderr: ['line-err'] };
    fireEvent.click(screen.getByRole('button', { name: 'com_toolbox_show_logs' }));
    expect(screen.getByText('line-out')).toBeInTheDocument();
    expect(screen.getByText('line-err')).toBeInTheDocument();
  });

  it('terminal run reports once per run_id with summary-only fields', async () => {
    const terminalRun: LocalRun = {
      run_id: 'r9',
      tool_id: 'wangjianbo.toolsdemo',
      version: '1.0.0',
      status: 'failed',
      started_at: '2026-09-28T10:00:00.000Z',
      finished_at: '2026-09-28T10:00:08.500Z',
      arguments: { text: 'secret-value', count: 3 },
    };
    mockHooks.run.data = terminalRun;
    const merged = tool({ status: 'installed', local: local('1.0.0') });
    const { rerender } = render(<LocalRunner tool={merged} />);

    await waitFor(() => expect(mockReport.mutate).toHaveBeenCalledTimes(1));
    /* argument values never leave the machine — key names only */
    expect(mockReport.mutate).toHaveBeenCalledWith({
      tool_id: 'wangjianbo.toolsdemo',
      version: '1.0.0',
      status: 'failed',
      duration_ms: 8500,
      argument_keys: ['text', 'count'],
    });
    expect(mockInvalidate).toHaveBeenCalledWith({
      queryKey: ['toolhost', 'runs', 'wangjianbo.toolsdemo'],
    });

    /* a refetch delivering a new object for the same run_id must not re-report */
    mockHooks.run.data = { ...terminalRun };
    rerender(<LocalRunner tool={merged} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockReport.mutate).toHaveBeenCalledTimes(1);
  });

  it('bottom run-history section: count header + compact newest-first rows', () => {
    const now = Date.now();
    mockHooks.runs.data = {
      runs: [
        {
          run_id: 'r2',
          tool_id: 'wangjianbo.toolsdemo',
          status: 'succeeded',
          created_at: new Date(now - 120_000).toISOString(),
          started_at: new Date(now - 120_000).toISOString(),
          finished_at: new Date(now - 118_800).toISOString(),
        },
        {
          run_id: 'r1',
          tool_id: 'wangjianbo.toolsdemo',
          status: 'failed',
          created_at: new Date(now - 3_600_000).toISOString(),
          started_at: new Date(now - 3_600_000).toISOString(),
          finished_at: new Date(now - 3_592_000).toISOString(),
        },
      ],
    };
    render(<LocalRunner tool={tool({ status: 'installed', local: local('1.0.0') })} />);

    expect(screen.getByRole('region', { name: 'com_toolbox_runs_title' })).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_section:2,20')).toBeInTheDocument();
    /* status is dot + label (never color alone) */
    expect(screen.getByText('com_toolbox_runs_status_succeeded')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_status_failed')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_minutes_ago:2')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_hours_ago:1')).toBeInTheDocument();
    expect(screen.getByText('1.2s')).toBeInTheDocument();
    expect(screen.getByText('8.0s')).toBeInTheDocument();
  });

  it('empty history shows the placeholder, not a bare heading', () => {
    mockHooks.runs.data = { runs: [] };
    render(<LocalRunner tool={tool({ status: 'installed', local: local('1.0.0') })} />);
    expect(screen.getByText('com_toolbox_runs_empty')).toBeInTheDocument();
  });

  it('damaged: warning alert, run blocked, repair reinstalls the installed version', async () => {
    mockHooks.install.mutateAsync.mockResolvedValue({ job_id: 'j9' });
    render(
      <LocalRunner tool={tool({ status: 'installed', local: local('1.0.0'), damaged: true })} />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('com_toolbox_repair_hint');
    expect(screen.getByRole('button', { name: 'com_toolbox_run' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'com_toolbox_repair' }));
    await waitFor(() =>
      expect(mockHooks.install.mutateAsync).toHaveBeenCalledWith({
        tool_id: 'wangjianbo.toolsdemo',
        owner: 'wangjianbo',
        repo: 'toolsdemo',
        version: '1.0.0',
      }),
    );
  });
});

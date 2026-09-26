/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { InstallJob, LocalRun } from '../toolhost';
import type { MergedTool } from '../toolStatus';
import LocalRunner from '../LocalRunner';

/* Controllable hook state — LocalRunner only consumes these seven hooks. */
const mockHooks = {
  install: { isLoading: false, error: null as unknown, mutateAsync: jest.fn() },
  remove: { isLoading: false, error: null as unknown, mutate: jest.fn() },
  job: { data: null as InstallJob | null },
  startRun: { isLoading: false, error: null as unknown, mutateAsync: jest.fn() },
  run: { data: null as LocalRun | null },
  stopRun: { isLoading: false, mutate: jest.fn() },
  logs: { data: null as { stdout: string[]; stderr: string[] } | null },
};

jest.mock('../toolhostHooks', () => ({
  useInstallTool: () => mockHooks.install,
  useDeleteLocalTool: () => mockHooks.remove,
  useInstallJob: () => mockHooks.job,
  useStartLocalRun: () => mockHooks.startRun,
  useLocalRun: () => mockHooks.run,
  useStopRun: () => mockHooks.stopRun,
  useRunLogs: () => mockHooks.logs,
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
});

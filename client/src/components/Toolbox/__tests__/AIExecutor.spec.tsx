/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { LocalPending } from '../api';
import AIExecutor from '../AIExecutor';

let mockItems: LocalPending[];
let mockCurrentRun: { status: string; result?: unknown; error?: string | null } | undefined;
const mockStartCalls: Array<{ toolId: string; arguments: Record<string, unknown> }> = [];
let mockStartError: Error | null = null;
const mockResolveCalls: Array<Record<string, unknown>> = [];
const mockStopCalls: string[] = [];
const mockInvalidate = jest.fn();
const mockSaveCode = jest.fn();
let mockFetchedPairingCode: string | null = null;
let mockStartErrorOnce = false;
/* 工厂内定义的 ToolhostError 类——beforeEach 里经 requireMock 取引用（工厂
   在 import 阶段执行，测试模块顶层的绑定那时还没初始化）。 */
let MockToolhostError: any;

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

jest.mock('../toolhost', () => {
  class TE extends Error {
    status?: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ToolhostError: TE,
    fetchPairingCode: () =>
      mockFetchedPairingCode != null
        ? Promise.resolve(mockFetchedPairingCode)
        : Promise.reject(new Error('pairing unavailable')),
  };
});

jest.mock('../api', () => ({
  useLocalPending: () => ({ data: { items: mockItems } }),
  useResolveLocalPending: () => ({
    mutate: (args: Record<string, unknown>, opts?: { onSettled?: () => void }) => {
      mockResolveCalls.push(args);
      opts?.onSettled?.();
    },
  }),
}));

jest.mock('../toolhostHooks', () => ({
  usePairingCode: () => ({ saveCode: mockSaveCode }),
  useStartLocalRun: () => ({
    mutate: (
      vars: { toolId: string; arguments: Record<string, unknown> },
      opts?: { onSuccess?: (job: { run_id: string }) => void; onError?: (err: Error) => void },
    ) => {
      mockStartCalls.push(vars);
      /* mockStartErrorOnce：只让第一次调用失败（403 自愈重试场景） */
      const shouldFail =
        mockStartError != null && (!mockStartErrorOnce || mockStartCalls.length === 1);
      if (shouldFail) {
        opts?.onError?.(mockStartError as Error);
      } else {
        opts?.onSuccess?.({ run_id: 'run-1' });
      }
    },
  }),
  useLocalRun: () => ({ data: mockCurrentRun }),
  useStopRun: () => ({ mutate: (runId: string) => mockStopCalls.push(runId) }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, rest?: { 0?: string }) =>
    rest && rest[0] != null ? `${key}:${rest[0]}` : key,
}));

/* StatusPopover styles via cn — keep it a pure join here. */
jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

const PENDING: LocalPending = {
  id: 'a'.repeat(32),
  tool_id: 'demo.desktop_echo',
  tool_name: '本机演示工具',
  description: 'd',
  version: '1.0.0',
  dangerous: false,
  params: { target: 'D:\\data' },
  created_at: '2026-10-08T00:00:00Z',
  expires_at: '2026-10-08T00:01:40Z',
};

beforeEach(() => {
  MockToolhostError = jest.requireMock('../toolhost').ToolhostError;
  mockItems = [];
  mockCurrentRun = undefined;
  mockStartError = null;
  mockStartErrorOnce = false;
  mockStartCalls.length = 0;
  mockResolveCalls.length = 0;
  mockStopCalls.length = 0;
  mockFetchedPairingCode = null;
  mockSaveCode.mockClear();
  mockInvalidate.mockClear();
  localStorage.clear();
});

describe('AIExecutor (global pending executor)', () => {
  it('renders nothing without pending items', () => {
    const { container } = render(<AIExecutor />);
    expect(container).toBeEmptyDOMElement();
  });

  it('auto-starts the local run with the model params, reports succeeded result', async () => {
    mockItems = [PENDING];
    const { rerender } = render(<AIExecutor />);

    expect(mockStartCalls).toEqual([
      { toolId: 'demo.desktop_echo', arguments: { target: 'D:\\data' } },
    ]);
    expect(screen.getByText('com_aiexec_starting')).toBeInTheDocument();

    mockCurrentRun = { status: 'running' };
    rerender(<AIExecutor />);
    expect(screen.getByText('com_aiexec_running')).toBeInTheDocument();

    mockCurrentRun = { status: 'succeeded', result: { rows: [1] } };
    rerender(<AIExecutor />);
    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({
      id: PENDING.id,
      status: 'succeeded',
      result: { rows: [1] },
    });
    expect(typeof mockResolveCalls[0].duration_ms).toBe('number');
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['terravox', 'local-pending'] });
  });

  it('reports failed (no result payload) when the local run fails', async () => {
    mockItems = [PENDING];
    const { rerender } = render(<AIExecutor />);
    mockCurrentRun = { status: 'failed', error: 'exit code 2' };
    rerender(<AIExecutor />);
    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({ status: 'failed', error: 'exit code 2' });
    expect(mockResolveCalls[0].result).toBeUndefined();
  });

  it('resolves the pending as failed on local start failure (Toolhost offline etc.)', async () => {
    mockItems = [PENDING];
    mockStartError = new Error('network error');
    render(<AIExecutor />);
    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({ status: 'failed', error: 'network error' });
    expect(screen.getByText('com_aiexec_start_failed:network error')).toBeInTheDocument();
  });

  it('offers stop while running and never reports twice', async () => {
    mockItems = [PENDING];
    const { rerender } = render(<AIExecutor />);
    mockCurrentRun = { status: 'running' };
    rerender(<AIExecutor />);

    screen.getByRole('button', { name: 'com_aiexec_stop' }).click();
    expect(mockStopCalls).toEqual(['run-1']);

    mockCurrentRun = { status: 'stopped' };
    rerender(<AIExecutor />);
    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({ status: 'stopped' });
  });

  it('a tab that lost the cross-tab claim does not start or report', () => {
    localStorage.setItem(`terravox-ai-claim-${PENDING.id}`, '1');
    mockItems = [PENDING];
    render(<AIExecutor />);
    expect(mockStartCalls).toEqual([]);
    expect(mockResolveCalls).toEqual([]);
    expect(screen.queryByTestId('ai-executor-card')).not.toBeInTheDocument();
  });

  it('403 on start self-heals: clears code, fetches a fresh pairing code, retries once', async () => {
    mockItems = [PENDING];
    mockStartError = new MockToolhostError(403, 'pairing code is invalid');
    mockStartErrorOnce = true;
    mockFetchedPairingCode = 'fresh-code';
    const { rerender } = render(<AIExecutor />);

    await waitFor(() => {
      expect(mockStartCalls).toHaveLength(2);
    });
    expect(mockSaveCode).toHaveBeenCalledWith('');
    expect(mockSaveCode).toHaveBeenCalledWith('fresh-code');

    /* 重跑成功 → 正常走运行/回传链 */
    mockCurrentRun = { status: 'succeeded', result: { ok: 1 } };
    rerender(<AIExecutor />);
    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({ status: 'succeeded', result: { ok: 1 } });
  });

  it('403 self-heal falls back to failed when the fresh pairing code is unavailable', async () => {
    mockItems = [PENDING];
    mockStartError = new MockToolhostError(403, 'pairing code is invalid');
    mockFetchedPairingCode = null; // pairing-code 文件不可读
    render(<AIExecutor />);

    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({
      status: 'failed',
      error: 'pairing unavailable',
    });
  });
});

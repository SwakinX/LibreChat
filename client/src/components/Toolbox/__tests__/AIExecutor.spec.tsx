/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { LocalPending } from '../api';
import AIExecutor from '../AIExecutor';

let mockItems: LocalPending[];
let mockCurrentRun: { status: string; result?: unknown; error?: string | null } | undefined;
const mockStartCalls: Array<{ toolId: string; arguments: Record<string, unknown> }> = [];
let mockStartError: Error | null = null;
let mockStartErrorOnce = false;
const mockResolveCalls: Array<Record<string, unknown>> = [];
const mockInvalidate = jest.fn();
const mockSaveCode = jest.fn();
let mockFetchedPairingCode: string | null = null;
let mockOrphanRuns: Array<{ run_id: string; status: string; created_at: string }> = [];
/* 类在 jest.mock 工厂里定义，beforeEach 经 requireMock 取引用再 new。 */
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
    fetchRuns: () => Promise.resolve({ runs: mockOrphanRuns }),
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
      /* mockStartErrorOnce：只让第一次调用失败（403 自愈/孤儿接管重试场景） */
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
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

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
  expires_at: '2026-10-08T01:00:00Z',
};

beforeEach(() => {
  MockToolhostError = jest.requireMock('../toolhost').ToolhostError;
  mockItems = [];
  mockCurrentRun = undefined;
  mockStartError = null;
  mockStartErrorOnce = false;
  mockStartCalls.length = 0;
  mockResolveCalls.length = 0;
  mockFetchedPairingCode = null;
  mockOrphanRuns = [];
  mockSaveCode.mockClear();
  mockInvalidate.mockClear();
  localStorage.clear();
});

describe('AIExecutor (headless pending executor)', () => {
  it('renders nothing (no UI) even with pending items', () => {
    mockItems = [PENDING];
    const { container } = render(<AIExecutor />);
    expect(container).toBeEmptyDOMElement();
  });

  it('auto-starts the local run with the model params, reports succeeded result', async () => {
    mockItems = [PENDING];
    const { rerender } = render(<AIExecutor />);

    expect(mockStartCalls).toEqual([
      { toolId: 'demo.desktop_echo', arguments: { target: 'D:\\data' } },
    ]);

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
    mockOrphanRuns = []; // 无孤儿 run 可接管
    render(<AIExecutor />);
    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({ status: 'failed', error: 'network error' });
  });

  it('start abort adopts the orphan toolhost run and reports its real result', async () => {
    mockItems = [PENDING];
    mockStartError = new Error('signal is aborted without reason');
    mockOrphanRuns = [
      { run_id: 'run-adopt', status: 'running', created_at: new Date().toISOString() },
    ];
    const { rerender } = render(<AIExecutor />);

    await waitFor(() => {
      expect(mockStartCalls).toHaveLength(1);
      expect(mockResolveCalls).toHaveLength(0);
    });

    mockCurrentRun = { status: 'succeeded', result: { report: '质检完成' } };
    rerender(<AIExecutor />);
    await waitFor(() => {
      expect(mockResolveCalls).toHaveLength(1);
    });
    expect(mockResolveCalls[0]).toMatchObject({
      id: PENDING.id,
      status: 'succeeded',
      result: { report: '质检完成' },
    });
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

  it('a tab that lost the cross-tab claim does not start or report', () => {
    localStorage.setItem(`terravox-ai-claim-${PENDING.id}`, '1');
    mockItems = [PENDING];
    render(<AIExecutor />);
    expect(mockStartCalls).toEqual([]);
    expect(mockResolveCalls).toEqual([]);
  });
});

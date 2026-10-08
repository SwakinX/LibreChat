/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { McpRefreshButton } from '../index';

let mockResult: { success: boolean; message?: string } | null = null;
let mockError: Error | null = null;
const reinitCalls: number[] = [];

jest.mock('../api', () => ({
  reinitializeTerravoxMcp: () => {
    reinitCalls.push(1);
    if (mockError) {
      return Promise.reject(mockError);
    }
    return Promise.resolve(mockResult ?? { success: true });
  },
}));

jest.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    mutationFn: () => Promise<{ success: boolean }>;
    onSuccess?: (data: { success: boolean }) => void;
    onError?: () => void;
    onSettled?: () => void;
  }) => ({
    mutate: (_vars: unknown, callOpts?: { onSettled?: () => void }) => {
      options.mutationFn().then(
        (data) => {
          options.onSuccess?.(data);
          callOpts?.onSettled?.();
        },
        () => {
          options.onError?.();
          callOpts?.onSettled?.();
        },
      );
    },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

beforeEach(() => {
  mockResult = null;
  mockError = null;
  reinitCalls.length = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('McpRefreshButton', () => {
  it('calls the reinitialize endpoint, shows the done label, and resets after 5s', async () => {
    mockResult = { success: true };
    render(<McpRefreshButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(reinitCalls).toHaveLength(1);
    expect(screen.getByText('com_toolbox_mcp_refresh_done')).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.getByText('com_toolbox_mcp_refresh')).toBeInTheDocument();
  });

  it('shows the failed label on error and on success=false; stays retryable', async () => {
    mockError = new Error('boom');
    render(<McpRefreshButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByText('com_toolbox_mcp_refresh_failed')).toBeInTheDocument();
    /* 失败态不禁用——用户可直接重试 */
    expect(screen.getByRole('button')).toBeEnabled();

    mockError = null;
    mockResult = { success: false };
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      jest.advanceTimersByTime(5000);
    });
    expect(reinitCalls).toHaveLength(2);
  });
});

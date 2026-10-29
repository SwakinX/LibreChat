/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { pairingCodeAtom, pairingRejectedAtom } from '../atoms';
import { ToolhostStatusCompact } from '../ToolhostStatus';

let mockOnline: boolean | undefined;
let mockAuto: {
  phase: 'idle' | 'pairing' | 'failed' | 'paired';
  reason: string | null;
  retry: () => void;
};

jest.mock('../toolhostHooks', () => ({
  ...jest.requireActual('../toolhostHooks'),
  useToolhostHealth: () => ({ data: mockOnline }),
  useAutoPairing: () => mockAuto,
  useToolhostVersion: () => ({ data: { version: '1.0.1', portable: true } }),
  useSelfUpdate: () => ({
    mutate: jest.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
}));

jest.mock('../api', () => ({
  useToolhostReleaseInfo: () => ({
    data: { version: '1.0.0', download_url: 'https://gitea.example/x.zip', size: 19_000_000 },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/* StatusPopover styles via cn — keep it a pure join here. */
jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

describe('ToolhostStatusCompact (sidebar icon strip)', () => {
  beforeEach(() => {
    mockOnline = undefined;
    mockAuto = { phase: 'idle', reason: null, retry: jest.fn() };
  });

  const renderCompact = () => {
    const store = createStore();
    store.set(pairingCodeAtom, '');
    const utils = render(
      <JotaiProvider store={store}>
        <ToolhostStatusCompact />
      </JotaiProvider>,
    );
    return { store, ...utils };
  };

  it('holds the icon-slot height while the probe is pending (no offline flash)', () => {
    const { container } = renderCompact();
    const slot = container.firstElementChild;
    expect(slot?.tagName).toBe('SPAN');
    expect(slot?.className).toContain('h-8');
  });

  it('offline: closed by default, opens to the guidance hint, Escape closes', () => {
    mockOnline = false;
    renderCompact();
    const button = screen.getByRole('button', { name: /com_toolbox_status_toolhost/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('com_toolbox_toolhost_offline_hint')).toBeInTheDocument();
    /* terravox:// 一键唤起链接（安装器版协议处理器） */
    expect(screen.getByRole('link', { name: 'com_toolbox_toolhost_launch' })).toHaveAttribute(
      'href',
      'terravox://start',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('online unpaired: popover carries the manual paste (short codes rejected)', () => {
    mockOnline = true;
    const { store } = renderCompact();
    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_status_toolhost/ }));

    const input = screen.getByPlaceholderText('com_toolbox_toolhost_pair_prompt');
    fireEvent.change(input, { target: { value: 'too-short' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(screen.getByText('com_toolbox_toolhost_code_short')).toBeInTheDocument();
    expect(store.get(pairingCodeAtom)).toBe('');

    fireEvent.change(input, { target: { value: '  abcdefghij0123456789  ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(store.get(pairingCodeAtom)).toBe('abcdefghij0123456789');
  });

  it('paired: popover shows the local-run hint instead of the form', () => {
    mockOnline = true;
    const { store } = renderCompact();
    act(() => {
      store.set(pairingCodeAtom, 'abcdefghij0123456789');
    });
    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_status_toolhost/ }));
    expect(screen.getByText('com_toolbox_local_run_hint')).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('com_toolbox_toolhost_pair_prompt'),
    ).not.toBeInTheDocument();
  });

  it('rejected flag (403 cleared the code) shows the rotated-code hint', () => {
    mockOnline = true;
    const { store } = renderCompact();
    act(() => {
      store.set(pairingRejectedAtom, true);
    });
    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_status_toolhost/ }));
    expect(screen.getByText('com_toolbox_toolhost_pair_rejected')).toBeInTheDocument();
  });

  it('auto-pairing in progress: spinner trigger with the manual paste fallback inside', () => {
    mockOnline = true;
    mockAuto = { phase: 'pairing', reason: null, retry: jest.fn() };
    renderCompact();
    const button = screen.getByRole('button', { name: /com_toolbox_status_toolhost/ });
    fireEvent.click(button);
    expect(screen.getByPlaceholderText('com_toolbox_toolhost_pair_prompt')).toBeInTheDocument();
  });

  it('auto-pairing failure shows the reason and a retry button beside the manual fallback', () => {
    mockOnline = true;
    const retry = jest.fn();
    mockAuto = { phase: 'failed', reason: 'origin is not allowed', retry };
    renderCompact();
    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_status_toolhost/ }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('com_toolbox_pair_auto_failed');
    expect(alert).toHaveTextContent('origin is not allowed');
    /* manual paste remains available as the fallback */
    expect(screen.getByPlaceholderText('com_toolbox_toolhost_pair_prompt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_toolbox_pair_retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

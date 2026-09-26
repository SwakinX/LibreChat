/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { pairingCodeAtom, pairingRejectedAtom } from '../atoms';
import ToolhostStatus from '../ToolhostStatus';

let mockOnline: boolean | undefined;

jest.mock('../toolhostHooks', () => ({
  ...jest.requireActual('../toolhostHooks'),
  useToolhostHealth: () => ({ data: mockOnline }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderChip = () => {
  const store = createStore();
  store.set(pairingCodeAtom, '');
  const utils = render(
    <JotaiProvider store={store}>
      <ToolhostStatus />
    </JotaiProvider>,
  );
  return { store, ...utils };
};

describe('ToolhostStatus chip', () => {
  beforeEach(() => {
    mockOnline = undefined;
  });

  it('renders nothing while the probe is pending', () => {
    const { container } = renderChip();
    expect(container).toBeEmptyDOMElement();
  });

  it('offline: gray chip with the guidance hint', () => {
    mockOnline = false;
    renderChip();
    expect(screen.getByText('com_toolbox_toolhost_offline')).toBeInTheDocument();
    expect(screen.getByTitle('com_toolbox_toolhost_offline_hint')).toBeInTheDocument();
  });

  it('online unpaired: short paste is rejected, valid code is saved to the atom', () => {
    mockOnline = true;
    const { store } = renderChip();
    const input = screen.getByPlaceholderText('com_toolbox_toolhost_pair_prompt');

    fireEvent.change(input, { target: { value: 'too-short' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(screen.getByText('com_toolbox_toolhost_code_short')).toBeInTheDocument();
    expect(store.get(pairingCodeAtom)).toBe('');

    fireEvent.change(input, { target: { value: '  abcdefghij0123456789  ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    /* optimistic save, trimmed — validity is only proven by the next mutation */
    expect(store.get(pairingCodeAtom)).toBe('abcdefghij0123456789');
    expect(screen.getByText('com_toolbox_toolhost_paired')).toBeInTheDocument();
  });

  it('rejected flag (403 cleared the code) shows the rotated-code hint', () => {
    mockOnline = true;
    const { store } = renderChip();
    act(() => {
      store.set(pairingRejectedAtom, true);
    });
    expect(screen.getByText('com_toolbox_toolhost_pair_rejected')).toBeInTheDocument();
  });
});

/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NextcloudConnectCompact } from '../NextcloudConnect';

let mockStatus: { linked: boolean; login_name?: string | null } | undefined;
const mockStartLink = { isLoading: false, mutateAsync: jest.fn() };
const mockUnlink = { isLoading: false, mutate: jest.fn() };

jest.mock('../api', () => ({
  useNextcloudStatus: () => ({ data: mockStatus }),
  useStartLink: () => mockStartLink,
  useUnlink: () => mockUnlink,
  usePollLink: () => ({ data: null }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

describe('NextcloudConnectCompact (sidebar icon strip)', () => {
  beforeEach(() => {
    mockStatus = undefined;
    mockStartLink.mutateAsync = jest.fn();
    mockUnlink.mutate = jest.fn();
    jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('holds the icon-slot height while the status query is pending', () => {
    const { container } = render(<NextcloudConnectCompact />);
    const slot = container.firstElementChild;
    expect(slot?.tagName).toBe('SPAN');
    expect(slot?.className).toContain('h-8');
  });

  it('linked: popover shows the account and unlink posts the mutation', () => {
    mockStatus = { linked: true, login_name: 'wangjianbo' };
    render(<NextcloudConnectCompact />);
    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_status_nextcloud/ }));

    expect(screen.getByText(/wangjianbo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_toolbox_unlink' }));
    expect(mockUnlink.mutate).toHaveBeenCalledTimes(1);
  });

  it('not linked: connect starts Login Flow v2 in a new tab', async () => {
    mockStatus = { linked: false };
    mockStartLink.mutateAsync.mockResolvedValue({
      link_id: 'lnk-1',
      login_url: 'https://nextcloud.example/index.php/login/flow/x',
    });
    render(<NextcloudConnectCompact />);
    fireEvent.click(screen.getByRole('button', { name: /com_toolbox_status_nextcloud/ }));

    fireEvent.click(screen.getByRole('button', { name: 'com_toolbox_connect_nextcloud' }));
    expect(mockStartLink.mutateAsync).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        'https://nextcloud.example/index.php/login/flow/x',
        '_blank',
        'noreferrer',
      ),
    );
  });
});

import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { RunRecordRow } from '../RunRecordsSection';
import { RunRecordsSection } from '../RunRecordsSection';

/* History rows expand to show the run's parameters/result and offer one-click
 * restore; rows without any detail render a bare line (no expander). */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join(',')}` : key,
}));

const baseRow: RunRecordRow = {
  key: 'r1',
  status: 'succeeded',
  created_at: new Date().toISOString(),
  duration_ms: 1200,
};

describe('RunRecordsSection detail & restore', () => {
  it('expands a row with params/result and restores the params', async () => {
    const onRestore = jest.fn();
    render(
      <RunRecordsSection
        localize={(k) => k}
        rows={[
          {
            ...baseRow,
            params: { text: '你好', count: 8 },
            result: { chars: 8 },
            onRestore: onRestore,
          },
        ]}
      />,
    );

    // collapsed by default: detail not yet visible
    expect(screen.queryByText('com_toolbox_runs_params')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'com_toolbox_runs_toggle_detail' }));
    expect(screen.getByText('com_toolbox_runs_params')).toBeInTheDocument();
    expect(screen.getByText('text')).toBeInTheDocument();
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_result')).toBeInTheDocument();
    expect(screen.getByText(/"chars": 8/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'com_toolbox_runs_restore' }));
    expect(onRestore).toHaveBeenCalledWith({ text: '你好', count: 8 });
  });

  it('hides restore when params are empty but still shows the result', async () => {
    render(
      <RunRecordsSection
        localize={(k) => k}
        rows={[{ ...baseRow, params: null, result: 'done', onRestore: jest.fn() }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'com_toolbox_runs_toggle_detail' }));
    expect(screen.getByText('com_toolbox_runs_params_empty')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_toolbox_runs_restore' }),
    ).not.toBeInTheDocument();
  });

  it('renders a bare row without an expander when nothing can be shown', () => {
    render(<RunRecordsSection localize={(k) => k} rows={[baseRow]} />);
    expect(
      screen.queryByRole('button', { name: 'com_toolbox_runs_toggle_detail' }),
    ).not.toBeInTheDocument();
  });
});

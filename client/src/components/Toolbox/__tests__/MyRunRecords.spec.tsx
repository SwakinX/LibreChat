import { render, screen } from '@testing-library/react';
import { useMyRunsForTool } from '../api';
import { MyRunRecords } from '../index';

/* Server-tool run history (contracts 2.10.0): rows come from the gateway's
 * usage records via useMyRunsForTool — own rows only, duration_ms carried. */

jest.mock('../api', () => ({
  useMyRunsForTool: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join(',')}` : key,
}));

const mockRuns = { data: null as { runs: MyRunRow[]; total: number } | null };
type MyRunRow = {
  id: string;
  tool_id: string;
  status: 'succeeded' | 'failed' | 'stopped' | 'timeout';
  duration_ms?: number | null;
  created_at: string;
  version?: string | null;
  source?: string;
};

const baseRun = (over: Partial<MyRunRow>): MyRunRow => ({
  id: 'run-1',
  tool_id: 'demo.table',
  status: 'succeeded',
  duration_ms: 1200,
  created_at: '2026-09-28T06:00:00.000Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRuns.data = null;
  (useMyRunsForTool as jest.Mock).mockImplementation(() => mockRuns);
});

describe('MyRunRecords (server tools)', () => {
  it('renders rows with status labels, durations and count heading', () => {
    mockRuns.data = {
      runs: [
        baseRun({
          id: 'r2',
          status: 'failed',
          duration_ms: 8500,
          created_at: new Date().toISOString(),
        }),
        baseRun({ id: 'r1', status: 'succeeded', duration_ms: 300 }),
      ],
      total: 2,
    };
    render(<MyRunRecords toolId="demo.table" />);

    expect(screen.getByRole('region', { name: 'com_toolbox_runs_title' })).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_section:2,200')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_status_failed')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_status_succeeded')).toBeInTheDocument();
    expect(screen.getByText('8.5s')).toBeInTheDocument();
    expect(screen.getByText('300ms')).toBeInTheDocument();
    // newest first: created_at "just now" for r2
    expect(screen.getByText('com_toolbox_runs_just_now')).toBeInTheDocument();
  });

  it('shows the empty state while there is no data', () => {
    render(<MyRunRecords toolId="demo.table" />);
    expect(screen.getByText('com_toolbox_runs_empty')).toBeInTheDocument();
    expect(screen.getByText('com_toolbox_runs_section:0,200')).toBeInTheDocument();
  });

  it('omits the duration cell when the report has none', () => {
    mockRuns.data = {
      runs: [baseRun({ duration_ms: null })],
      total: 1,
    };
    render(<MyRunRecords toolId="demo.table" />);
    expect(screen.getByText('com_toolbox_runs_status_succeeded')).toBeInTheDocument();
    expect(screen.queryByText(/s$/)).not.toBeInTheDocument();
  });
});

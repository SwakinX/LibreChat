import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import WebRunner from '../WebRunner';

/* Web-link tools (2.11.0): "run" opens the URL in a new tab and reports one
 * usage row; the run-history section renders below. */

const mockReport = { mutate: jest.fn() };
const mockInvalidate = jest.fn();

jest.mock('../api', () => ({
  useReportToolRun: () => mockReport,
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join(',')}` : key,
}));

jest.mock('../index', () => ({
  MyRunRecords: ({ toolId }: { toolId: string }) => <div data-testid="my-runs">{toolId}</div>,
}));

const manifest = {
  schema_version: 1 as const,
  tool_id: 'demo.weblink',
  version: '1.0.0',
  display_name: '网页工具演示',
  description: 'web 型工具演示',
  execution: { kind: 'web', url: 'https://gitea.gislife.local' },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('WebRunner', () => {
  it('opens the registered URL in a new tab and reports one usage row', async () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    render(<WebRunner manifest={manifest} />);

    await userEvent.click(screen.getByRole('button', { name: 'com_toolbox_web_open' }));

    expect(open).toHaveBeenCalledWith('https://gitea.gislife.local', '_blank', 'noopener');
    expect(mockReport.mutate).toHaveBeenCalledWith({
      tool_id: 'demo.weblink',
      version: '1.0.0',
      status: 'succeeded',
      duration_ms: 0,
      argument_keys: [],
    });
    expect(mockInvalidate).toHaveBeenCalledWith({
      queryKey: ['terravox', 'myruns', 'demo.weblink'],
    });
    expect(screen.getByTestId('my-runs')).toHaveTextContent('demo.weblink');
    open.mockRestore();
  });

  it('disables the button and shows the note when no URL is registered', () => {
    render(<WebRunner manifest={{ ...manifest, execution: { kind: 'web', url: '' } }} />);
    expect(screen.getByText('com_toolbox_web_no_url')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_toolbox_web_open' })).toBeDisabled();
  });
});

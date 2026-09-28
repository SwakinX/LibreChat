/**
 * @jest-environment @happy-dom/jest-environment
 */
import {
  deleteLocalTool,
  fetchHealth,
  fetchInstallJob,
  fetchLocalTools,
  fetchPairingCode,
  postInstall,
  postRun,
  TOOLHOST_BASE,
  ToolhostError,
} from '../toolhost';

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const fetchMock = jest.fn<Promise<MockResponse>, [string, RequestInit?]>();

const jsonResponse = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('toolhost fetch client', () => {
  it('targets the 127.0.0.1 literal and stays token-free on GETs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));
    await fetchHealth();
    expect(fetchMock).toHaveBeenCalledWith(
      `${TOOLHOST_BASE}/healthz`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).toBeUndefined();
  });

  it('injects X-Approval-Token only when a code is stored', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tools: [] }));
    await fetchLocalTools(); // call 0 — GET, no headers
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(jsonResponse({ tool_id: 't', deleted: true }));
    await deleteLocalTool('demo.tool', 'pairing-code-1234567890'); // call 1
    const headers = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(headers['X-Approval-Token']).toBe('pairing-code-1234567890');

    /* empty code → header absent (a blank token would be rejected) */
    await deleteLocalTool('demo.tool', ''); // call 2
    const bare = fetchMock.mock.calls[2][1]?.headers as Record<string, string> | undefined;
    expect(bare?.['X-Approval-Token']).toBeUndefined();
  });

  it('auto-pairing bootstrap is token-free and unwraps {code}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'auto-pairing-code-0123456789' }));
    await expect(fetchPairingCode()).resolves.toBe('auto-pairing-code-0123456789');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TOOLHOST_BASE}/v1/local/pairing-code`);
    expect(init?.headers).toBeUndefined();
  });

  it('sends the install body with no stray fields', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        job_id: 'j1',
        tool_id: 'demo.tool',
        owner: 'o',
        repo: 'r',
        version: '1.0.0',
        state: 'downloading',
        progress_percent: null,
        error: null,
        created_at: 't',
        finished_at: null,
      }),
    );
    const job = await postInstall(
      { tool_id: 'demo.tool', owner: 'o', repo: 'r', fallback: { launcher: 'main.py' } },
      'code',
    );
    expect(job.job_id).toBe('j1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TOOLHOST_BASE}/v1/local/tools/install`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      tool_id: 'demo.tool',
      owner: 'o',
      repo: 'r',
      fallback: { launcher: 'main.py' },
    });
  });

  it('run body is {arguments} only — confirmed is never sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run_id: 'r1' }));
    await postRun('demo.tool', { arguments: { text: 'hi' } }, 'code');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({ arguments: { text: 'hi' } });
    expect(body.confirmed).toBeUndefined();
  });

  it('unwraps string details into ToolhostError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'tool is currently running' }, 409));
    await expect(deleteLocalTool('demo.tool', 'code')).rejects.toMatchObject({
      name: 'ToolhostError',
      status: 409,
      message: 'tool is currently running',
    });
  });

  it('unwraps object details (code + message) for 403 pairing failures', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: { code: 'forbidden', message: 'approval token invalid' } }, 403),
    );
    const error = await postRun('demo.tool', { arguments: {} }, 'stale').catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ToolhostError);
    expect((error as ToolhostError).status).toBe(403);
    expect((error as ToolhostError).message).toBe('approval token invalid');
    expect((error as ToolhostError).code).toBe('forbidden');
  });

  it('encodes path parameters', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        job_id: 'j1',
        tool_id: 't',
        owner: 'o',
        repo: 'r',
        version: '1',
        state: 'installed',
        progress_percent: null,
        error: null,
        created_at: 't',
        finished_at: null,
      }),
    );
    await fetchInstallJob('job id/slash');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${TOOLHOST_BASE}/v1/local/install-jobs/job%20id%2Fslash`,
    );
  });
});

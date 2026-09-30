/**
 * TerraVox Tool Gateway proxy (/api/terravox/*).
 *
 * Forwards the user's federated OIDC access token to the Tool Gateway so the
 * client never handles IdP tokens. Token freshness is delegated to the
 * OpenIDSessionRefresh provider (requires OPENID_REUSE_TOKENS=true).
 */
const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const openIDSessionRefresh = require('~/server/services/OpenIDSessionRefresh');

const router = express.Router();
router.use(requireJwtAuth);

const GATEWAY_URL = (process.env.TOOL_GATEWAY_URL || 'http://127.0.0.1:8810').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.TOOL_GATEWAY_TIMEOUT_MS || 120000);
/* Shared secret for read-only catalog routes. The admin panel calls
 * /api/terravox/tools/all server-side (Bearer JWT only, no browser session
 * cookie), so no OpenID session token can ever exist on that path; the
 * gateway accepts this token on catalog endpoints instead. */
const SERVICE_TOKEN = process.env.TERRAVOX_SERVICE_TOKEN || '';

/**
 * Resolve a fresh access token for the authenticated user; null when the
 * OPENID_REUSE_TOKENS session capability is absent (flag off or stale login).
 *
 * The provider REJECTS (rather than resolving null) when a session exists but
 * its OpenID capability was cleared — e.g. the login predates the
 * OPENID_REUSE_TOKENS flag. That rejection is expected here, so it is caught
 * and folded into the null → 503 re-login path instead of bubbling up as 500.
 */
async function resolveAccessToken(req, res, { forceRefresh = false } = {}) {
  const provider = openIDSessionRefresh.createOpenIDSessionTokenProvider({
    req,
    res,
    user: req.user,
    tokenPreference: 'access_token',
  });
  let tokens = null;
  try {
    tokens = await provider({ forceRefresh });
  } catch (error) {
    logger.warn('[terravox] OpenID session token unavailable:', error?.message);
    return null;
  }
  return (
    tokens?.access_token || (forceRefresh ? null : req.user?.federatedTokens?.access_token) || null
  );
}

async function forwardToGateway(
  req,
  res,
  path,
  { method = 'GET', body, retried = false, service = false, allowServiceToken = false } = {},
) {
  const accessToken = service ? null : await resolveAccessToken(req, res);
  if (!service && !accessToken) {
    /* No OpenID session token: expected for admin-panel server-side calls.
     * Catalog-only routes may fall back to the shared service token; anything
     * user-identified keeps the 503 re-login answer. */
    if (allowServiceToken && SERVICE_TOKEN) {
      return forwardToGateway(req, res, path, { method, body, service: true });
    }
    return res.status(503).json({
      message:
        'Tool Gateway requires an OpenID session token. Log out and back in (OPENID_REUSE_TOKENS must be enabled).',
    });
  }
  if (service && !SERVICE_TOKEN) {
    return res.status(503).json({ message: 'TERRAVOX_SERVICE_TOKEN is not configured' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {
      ...(service
        ? {
            'X-Service-Token': SERVICE_TOKEN,
            /* Acting admin identity: the gateway records it in its audit trail.
             * requireJwtAuth already authenticated this request. */
            'X-Acting-Sub': String(req.user?.id ?? ''),
            'X-Acting-Username': String(req.user?.username ?? ''),
          }
        : { Authorization: `Bearer ${accessToken}` }),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    const response = await fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    // A 401 from the gateway means the forwarded token was stale/rotated:
    // force one refresh and retry before surfacing the failure (bearer mode only).
    if (response.status === 401 && !retried && !service) {
      const fresh = await resolveAccessToken(req, res, { forceRefresh: true });
      if (fresh && fresh !== accessToken) {
        return forwardToGateway(req, res, path, { method, body, retried: true });
      }
    }
    const payload = await response.text();
    return res
      .status(response.status)
      .set('Content-Type', response.headers.get('content-type') || 'application/json')
      .send(payload);
  } catch (error) {
    const message =
      error.name === 'AbortError' ? 'Tool Gateway timed out' : 'Tool Gateway unreachable';
    return res.status(502).json({ message: `${message} (${GATEWAY_URL})` });
  } finally {
    clearTimeout(timer);
  }
}

const jsonBody = express.json({ limit: '1mb' });
const handler =
  (path, options = {}) =>
  async (req, res) => {
    const { allowServiceToken, ...forwardOptions } = options;
    try {
      await forwardToGateway(req, res, path(req), {
        ...forwardOptions,
        body: forwardOptions.body?.(req),
        allowServiceToken,
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  };

router.get(
  '/tools',
  handler((req) => `/api/v1/tools?front=${encodeURIComponent(req.query.front || 'ui')}`),
);
/* Admin catalog for the admin panel: full tool list incl. disabled. The gateway
 * enforces the manager group (or the shared service token) on its side; this
 * side keeps admins-only so the route never broadens who can even probe it.
 * allowServiceToken: the admin panel's server-side apiFetch carries no browser
 * session, so this read-only catalog route falls back to the service token. */
router.get(
  '/tools/all',
  requireJwtAuth,
  requireCapability(SystemCapabilities.ACCESS_ADMIN),
  handler(() => '/api/v1/tools/all', { allowServiceToken: true }),
);
router.post(
  '/tools/:toolId/execute',
  jsonBody,
  handler((req) => `/api/v1/tools/${encodeURIComponent(req.params.toolId)}/execute`, {
    method: 'POST',
    body: (req) => ({ params: req.body?.params ?? {}, confirmed: req.body?.confirmed === true }),
  }),
);
router.post(
  '/nextcloud/link',
  handler(() => '/api/v1/nextcloud/link', { method: 'POST' }),
);
router.get(
  '/nextcloud/link/:linkId',
  handler((req) => `/api/v1/nextcloud/link/${encodeURIComponent(req.params.linkId)}`),
);
router.get(
  '/nextcloud/status',
  handler(() => '/api/v1/nextcloud/status'),
);
router.delete(
  '/nextcloud/link',
  handler(() => '/api/v1/nextcloud/link', { method: 'DELETE' }),
);

/* Multipart execute channel (2.15.0): the browser sends FormData; the raw
 * body streams straight to the gateway with the original content-type so
 * multer on the gateway side parses it. No JSON body parsing here. */
router.post('/tools/:toolId/execute-upload', async (req, res) => {
  const accessToken = await resolveAccessToken(req, res);
  if (!accessToken) {
    return res.status(503).json({
      message: 'Tool Gateway requires an OpenID session token. Log out and back in.',
    });
  }
  try {
    const upstream = await fetch(
      `${GATEWAY_URL}/api/v1/tools/${encodeURIComponent(req.params.toolId)}/execute-upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': req.headers['content-type'],
        },
        body: req,
        duplex: 'half',
      },
    );
    const payload = await upstream.text();
    return res
      .status(upstream.status)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
      .send(payload);
  } catch (error) {
    logger.error(
      '[terravox] execute-upload/file-download forward failed:',
      error?.name,
      error?.message,
      error?.cause?.code ?? '',
    );
    const message =
      error.name === 'AbortError' ? 'Tool Gateway timed out' : 'Tool Gateway unreachable';
    return res.status(502).json({ message: `${message} (${GATEWAY_URL})` });
  }
});

/* File download proxy (2.15.0): stream bytes verbatim — buffering here
 * would corrupt binary payloads, so this route never uses forwardToGateway. */
router.get('/files/download', async (req, res) => {
  const accessToken = await resolveAccessToken(req, res);
  if (!accessToken) {
    return res
      .status(503)
      .json({ message: 'Tool Gateway requires an OpenID session token. Log out and back in.' });
  }
  try {
    const upstream = await fetch(
      `${GATEWAY_URL}/api/v1/nextcloud/files/download?path=${encodeURIComponent(String(req.query.path || ''))}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!upstream.ok || !upstream.body) {
      const payload = await upstream.text();
      return res
        .status(upstream.status)
        .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
        .send(payload);
    }
    res.status(upstream.status);
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) {
      res.set('Content-Disposition', disposition);
    }
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (error) {
    logger.error(
      '[terravox] execute-upload/file-download forward failed:',
      error?.name,
      error?.message,
      error?.cause?.code ?? '',
    );
    const message =
      error.name === 'AbortError' ? 'Tool Gateway timed out' : 'Tool Gateway unreachable';
    return res.status(502).json({ message: `${message} (${GATEWAY_URL})` });
  }
});

/* Map panel config (2.15.0): base tile template served same-origin via the
 * nginx /iserver/ reverse proxy; nothing sensitive reaches the browser. */
router.get(
  '/map/config',
  handler(() => '/api/v1/map/config'),
);

/* Visible service bindings for the current user (contracts 2.16.0): the data
 * source for toolbox layer dropdowns and the map browser's layer tree. */
router.get(
  '/services',
  handler(() => '/api/v1/services'),
);

/* Maps inside a service-level map binding (2.18.0): the add-layer dialog
 * lists these for multi-select import. */
router.get(
  '/services/:serviceId/maps',
  handler((req) => `/api/v1/services/${encodeURIComponent(req.params.serviceId)}/maps`),
);

/* Direct-add temp layers (2.16.0): resolve a pasted iServer REST service URL into
 * type + candidates. Read-only probe; nothing is written to the registry. */
router.post(
  '/services/resolve',
  jsonBody,
  handler(() => '/api/v1/services/resolve', { method: 'POST', body: (req) => req.body }),
);

/* Cloud-drive browsing for pickers (2.16.0): lists folders of the current
 * user's own drive via their stored app credential (never sent to the browser). */
router.get(
  '/nextcloud/browse',
  handler(
    (req) => `/api/v1/nextcloud/browse?path=${encodeURIComponent(String(req.query.path ?? ''))}`,
  ),
);

/* Temp artifact download (2.16.0): stream bytes verbatim from the gateway's
 * in-memory run store — same shape as /files/download, never buffered. */
router.get('/files/temp/:token', async (req, res) => {
  const accessToken = await resolveAccessToken(req, res);
  if (!accessToken) {
    return res
      .status(503)
      .json({ message: 'Tool Gateway requires an OpenID session token. Log out and back in.' });
  }
  try {
    const upstream = await fetch(
      `${GATEWAY_URL}/api/v1/files/temp/${encodeURIComponent(req.params.token)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!upstream.ok || !upstream.body) {
      const payload = await upstream.text();
      return res
        .status(upstream.status)
        .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
        .send(payload);
    }
    res.status(upstream.status);
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) {
      res.set('Content-Disposition', disposition);
    }
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (error) {
    logger.error('[terravox] temp file forward failed:', error?.name, error?.message);
    const message =
      error.name === 'AbortError' ? 'Tool Gateway timed out' : 'Tool Gateway unreachable';
    return res.status(502).json({ message: `${message} (${GATEWAY_URL})` });
  }
});

/* One-click save of textual tool results into the user's drive (2.16.0). */
router.post(
  '/nextcloud/save-text',
  jsonBody,
  handler(() => '/api/v1/nextcloud/save-text', { method: 'POST', body: (req) => req.body }),
);

/* Save a temp artifact into the user's chosen drive folder (2.16.0). */
router.post(
  '/nextcloud/save-file',
  jsonBody,
  handler(() => '/api/v1/files/temp/save-to-drive', { method: 'POST', body: (req) => req.body }),
);

/* Direct-run terminal report from the toolbox page (local-tool-plan §8):
 * the browser posts best-effort once a local run finishes; user identity is
 * the forwarded OIDC bearer. */
router.post(
  '/runs/report',
  jsonBody,
  handler(() => '/api/v1/runs/report', { method: 'POST', body: (req) => req.body }),
);

/* User's own usage records (contracts 2.10.0): the data source for the
 * server-tool run-history section on the toolbox page. Forwards the user's
 * OIDC bearer; the gateway filters by user_sub, so rows are always own-only. */
router.get(
  '/runs',
  handler((req) => {
    const params = new URLSearchParams();
    for (const key of ['tool_id', 'limit']) {
      const value = req.query[key];
      if (value !== undefined && value !== '') {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    return `/api/v1/runs${query ? `?${query}` : ''}`;
  }),
);

/* Admin surface for the admin panel: tool/group CRUD, batch import, handler
 * list. All calls arrive server-side from the admin panel (Bearer JWT, no
 * browser session cookie), so they always forward with the service token plus
 * the acting admin's identity headers — the user-side admin check
 * (ACCESS_ADMIN) happens here, the gateway audits the acting user. */
router.use('/admin', requireCapability(SystemCapabilities.ACCESS_ADMIN));

const adminHandler =
  (path, options = {}) =>
  async (req, res) => {
    try {
      await forwardToGateway(req, res, path(req), {
        ...options,
        service: true,
        body: options.body?.(req),
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  };

router.get(
  '/admin/groups',
  adminHandler(() => '/api/v1/admin/groups'),
);
router.post(
  '/admin/groups',
  jsonBody,
  adminHandler(() => '/api/v1/admin/groups', { method: 'POST', body: (req) => req.body }),
);
router.patch(
  '/admin/groups/:name',
  jsonBody,
  adminHandler((req) => `/api/v1/admin/groups/${encodeURIComponent(req.params.name)}`, {
    method: 'PATCH',
    body: (req) => req.body,
  }),
);
router.delete(
  '/admin/groups/:name',
  adminHandler((req) => `/api/v1/admin/groups/${encodeURIComponent(req.params.name)}`, {
    method: 'DELETE',
  }),
);

/* Service registry (contracts 2.16.0): admin binds external GIS services
 * (iServer map / data), probes availability, sets group visibility. */
router.get(
  '/admin/services',
  adminHandler(() => '/api/v1/admin/services'),
);
router.post(
  '/admin/services',
  jsonBody,
  adminHandler(() => '/api/v1/admin/services', { method: 'POST', body: (req) => req.body }),
);
/* iServer base-address discovery (2.18.0): enumerate REST map/data services. */
router.post(
  '/admin/services/discover',
  jsonBody,
  adminHandler(() => '/api/v1/admin/services/discover', {
    method: 'POST',
    body: (req) => req.body,
  }),
);
router.patch(
  '/admin/services/:serviceId',
  jsonBody,
  adminHandler((req) => `/api/v1/admin/services/${encodeURIComponent(req.params.serviceId)}`, {
    method: 'PATCH',
    body: (req) => req.body,
  }),
);
router.delete(
  '/admin/services/:serviceId',
  adminHandler((req) => `/api/v1/admin/services/${encodeURIComponent(req.params.serviceId)}`, {
    method: 'DELETE',
  }),
);
router.post(
  '/admin/services/:serviceId/probe',
  adminHandler(
    (req) => `/api/v1/admin/services/${encodeURIComponent(req.params.serviceId)}/probe`,
    {
      method: 'POST',
    },
  ),
);
router.get(
  '/admin/services/:serviceId/maps',
  adminHandler((req) => `/api/v1/services/${encodeURIComponent(req.params.serviceId)}/maps`),
);
router.get(
  '/admin/services/:serviceId/datasources',
  adminHandler(
    (req) => `/api/v1/admin/services/${encodeURIComponent(req.params.serviceId)}/datasources`,
  ),
);
router.get(
  '/admin/handlers',
  adminHandler(() => '/api/v1/admin/handlers'),
);
router.post(
  '/admin/tools',
  jsonBody,
  adminHandler(() => '/api/v1/admin/tools', { method: 'POST', body: (req) => req.body }),
);
router.post(
  '/admin/tools/import',
  jsonBody,
  adminHandler(() => '/api/v1/admin/tools/import', { method: 'POST', body: (req) => req.body }),
);

/* Pending repo updates for the admin panel's confirm-before-publish flow
 * (2026-09-28 governance: users never see repo versions ahead of the
 * approved manifest until an admin confirms them). Literal route declared
 * beside the other literal /admin/tools routes, above the `:toolId` params. */
router.get(
  '/admin/tools/pending-updates',
  adminHandler(() => '/api/v1/admin/tools/pending-updates'),
);
router.put(
  '/admin/tools/:toolId',
  jsonBody,
  adminHandler((req) => `/api/v1/admin/tools/${encodeURIComponent(req.params.toolId)}`, {
    method: 'PUT',
    body: (req) => req.body,
  }),
);
router.patch(
  '/admin/tools/:toolId',
  jsonBody,
  adminHandler((req) => `/api/v1/admin/tools/${encodeURIComponent(req.params.toolId)}`, {
    method: 'PATCH',
    body: (req) => req.body,
  }),
);
router.delete(
  '/admin/tools/:toolId',
  adminHandler((req) => `/api/v1/admin/tools/${encodeURIComponent(req.params.toolId)}`, {
    method: 'DELETE',
  }),
);
router.get(
  '/admin/gitea/repos',
  adminHandler((req) => {
    const baseUrl = req.query.base_url
      ? `?base_url=${encodeURIComponent(String(req.query.base_url))}`
      : '';
    return `/api/v1/admin/gitea/repos${baseUrl}`;
  }),
);
router.post(
  '/admin/gitea/repos/check',
  jsonBody,
  adminHandler(() => '/api/v1/admin/gitea/repos/check', {
    method: 'POST',
    body: (req) => req.body,
  }),
);

/* Usage-stats query for the admin panel's page + CSV export: filters
 * (tool/user/time range) and pagination forwarded verbatim; the panel loops
 * pages for a full export. */
router.get(
  '/admin/runs/reports',
  adminHandler((req) => {
    const params = new URLSearchParams();
    for (const key of ['tool_id', 'user_sub', 'since', 'until', 'limit', 'offset']) {
      const value = req.query[key];
      if (value !== undefined && value !== '') {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    return `/api/v1/admin/runs/reports${query ? `?${query}` : ''}`;
  }),
);

module.exports = router;

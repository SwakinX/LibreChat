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

async function forwardToGateway(req, res, path, { method = 'GET', body, retried = false } = {}) {
  const accessToken = await resolveAccessToken(req, res);
  if (!accessToken) {
    return res.status(503).json({
      message:
        'Tool Gateway requires an OpenID session token. Log out and back in (OPENID_REUSE_TOKENS must be enabled).',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    // A 401 from the gateway means the forwarded token was stale/rotated:
    // force one refresh and retry before surfacing the failure.
    if (response.status === 401 && !retried) {
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
    try {
      await forwardToGateway(req, res, path(req), { ...options, body: options.body?.(req) });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  };

router.get(
  '/tools',
  handler((req) => `/api/v1/tools?front=${encodeURIComponent(req.query.front || 'ui')}`),
);
/* Admin catalog for the admin panel: full tool list incl. disabled. The gateway
 * enforces the manager group on its side; this side keeps admins-only so the
 * route never broadens who can even probe it. */
router.get(
  '/tools/all',
  requireJwtAuth,
  requireCapability(SystemCapabilities.ACCESS_ADMIN),
  handler(() => '/api/v1/tools/all'),
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

module.exports = router;

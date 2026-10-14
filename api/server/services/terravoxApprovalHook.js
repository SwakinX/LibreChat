/**
 * TerraVox 危险工具动态审批钩子（ADR-0017 伴生）。
 *
 * 后台目录页 manifest 的 dangerous 标志是唯一真相源：每次 MCP 工具调用时
 * 查 gateway 目录（进程内短 TTL 缓存），命中 dangerous → 返回 ask 弹原生
 * 审批卡（对静态 policy 是「收紧」——SDK 折叠序 deny > ask > allow > bypass，
 * 钩子永远无法放松 bypass 的静默直通，方向安全）。
 *
 * - 只对 terravox 来源（`*_mcp_terravox`）查询；其他 MCP 服务器（weknora
 *   检索等只读面）直接弃权。
 * - gateway 不可达 → 沿用最近一次目录（stale-while-error），无目录则弃权
 *   直通并 WARN——可用性优先，目录最终一致。
 * - 弃权 = 返回 undefined，落到静态 policy 的 bypass → 静默放行。
 *
 * 由 api/server/index.js 在启动时 require 一次完成进程级注册
 * （registerToolApprovalHook；未开 HITL 时钩子整体惰性，无额外开销）。
 */
const { logger } = require('@librechat/data-schemas');
const { registerToolApprovalHook } = require('@librechat/api');

const DANGEROUS_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 3_000;
const TERRAVOX_SUFFIX = '_mcp_terravox';

/** handler 名 → true 的危险集合缓存（stale-while-error）。 */
let dangerousCache = { at: 0, handlers: new Set() };
let inflight = null;

async function fetchDangerousHandlers() {
  const base = (process.env.TOOL_GATEWAY_URL || '').replace(/\/+$/, '');
  const token = process.env.TERRAVOX_SERVICE_TOKEN;
  if (!base || !token) {
    return null;
  }
  const response = await fetch(`${base}/api/v1/tools/all`, {
    headers: {
      'X-Service-Token': token,
      'X-Acting-Sub': 'librechat-approval-hook',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`gateway responded ${response.status}`);
  }
  const payload = await response.json();
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const handlers = new Set();
  for (const tool of tools) {
    if (!tool?.enabled || tool?.dangerous !== true) {
      continue;
    }
    const handler = (tool?.execution ?? {}).handler;
    if (typeof handler === 'string' && handler) {
      handlers.add(handler);
    }
  }
  return handlers;
}

/** 返回当前可用的危险 handler 集合；过期则后台刷新（失败沿用旧值）。 */
async function getDangerousHandlers() {
  if (Date.now() - dangerousCache.at < DANGEROUS_TTL_MS) {
    return dangerousCache.handlers;
  }
  if (!inflight) {
    inflight = fetchDangerousHandlers()
      .then((handlers) => {
        if (handlers != null) {
          dangerousCache = { at: Date.now(), handlers };
        }
      })
      .catch((error) => {
        logger.warn(
          '[terravox-approval] gateway catalog fetch failed, reusing stale cache:',
          error?.message,
        );
      })
      .finally(() => {
        inflight = null;
      });
  }
  // 不等刷新完成——用 stale 值先决策，刷新结果服务下一次调用
  return dangerousCache.handlers;
}

/** 注册进程级 PreToolUse 钩子。 */
function register() {
  registerToolApprovalHook(() => {
    return async (input) => {
      const toolName = typeof input?.toolName === 'string' ? input.toolName : '';
      if (!toolName.endsWith(TERRAVOX_SUFFIX)) {
        return undefined; // 非 terravox（weknora 检索等）：弃权，走静态 bypass
      }
      const tool = toolName.slice(0, -TERRAVOX_SUFFIX.length);
      const dangerous = await getDangerousHandlers();
      if (!dangerous || !dangerous.has(tool)) {
        return undefined;
      }
      logger.info(`[terravox-approval] dangerous tool flagged for approval: ${tool}`);
      return { decision: 'ask', reason: '危险工具（后台 dangerous 标记）' };
    };
  });
  logger.info('[terravox-approval] dynamic danger approval hook registered');
}

register();

module.exports = { register };

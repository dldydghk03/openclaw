import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import { callGateway } from "../../../gateway/call.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { resolveEffectiveResetTargetSessionKey } from "../acp-reset-target.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { SESSION_ID_RE } from "./shared.js";

const RECENT_REQUESTER_ACP_TARGETS = new Map<
  string,
  {
    sessionKey: string;
    updatedAt: number;
  }
>();
const RECENT_REQUESTER_ACP_TARGET_TTL_MS = 6 * 60 * 60 * 1000;

async function resolveSessionKeyByToken(token: string): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const attempts: Array<Record<string, string>> = [{ key: trimmed }];
  if (SESSION_ID_RE.test(trimmed)) {
    attempts.push({ sessionId: trimmed });
  }
  attempts.push({ label: trimmed });

  for (const params of attempts) {
    try {
      const resolved = await callGateway({
        method: "sessions.resolve",
        params,
        timeoutMs: 8_000,
      });
      const key = normalizeOptionalString(resolved?.key) ?? "";
      if (key) {
        return key;
      }
    } catch {
      // Try next resolver strategy.
    }
  }
  return null;
}

function resolveRequesterLookupKey(params: HandleCommandsParams): string | undefined {
  const requesterSessionKey = resolveRequesterSessionKey(params, {
    preferCommandTarget: true,
  });
  const scopedRequesterKey = requesterSessionKey?.trim();
  if (!scopedRequesterKey) {
    return undefined;
  }
  const bindingContext = resolveAcpCommandBindingContext(params);
  const channel = bindingContext.channel.trim().toLowerCase();
  const accountId = bindingContext.accountId.trim().toLowerCase();
  const conversationId = bindingContext.conversationId?.trim().toLowerCase() || "";
  const threadId = bindingContext.threadId?.trim().toLowerCase() || "";
  return `${scopedRequesterKey}|${channel}|${accountId}|${conversationId}|${threadId}`;
}

function getRecentRequesterAcpSessionKey(params: HandleCommandsParams): string | undefined {
  const requesterLookupKey = resolveRequesterLookupKey(params);
  if (!requesterLookupKey) {
    return undefined;
  }

  const now = Date.now();
  const remembered = RECENT_REQUESTER_ACP_TARGETS.get(requesterLookupKey);
  if (!remembered) {
    return undefined;
  }
  if (now - remembered.updatedAt > RECENT_REQUESTER_ACP_TARGET_TTL_MS) {
    RECENT_REQUESTER_ACP_TARGETS.delete(requesterLookupKey);
    return undefined;
  }

  const resolved = getAcpSessionManager().resolveSession({
    cfg: params.cfg,
    sessionKey: remembered.sessionKey,
  });
  if (resolved.kind === "none") {
    RECENT_REQUESTER_ACP_TARGETS.delete(requesterLookupKey);
    return undefined;
  }

  return remembered.sessionKey;
}

export function resolveRecentAcpTargetForRequester(
  commandParams: HandleCommandsParams,
): string | undefined {
  return getRecentRequesterAcpSessionKey(commandParams);
}

export function rememberRecentAcpTargetForRequester(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
}): void {
  const requesterLookupKey = resolveRequesterLookupKey(params.commandParams);
  const sessionKey = params.sessionKey.trim();
  if (!requesterLookupKey || !sessionKey) {
    return;
  }
  RECENT_REQUESTER_ACP_TARGETS.set(requesterLookupKey, {
    sessionKey,
    updatedAt: Date.now(),
  });
}

export function clearRecentAcpTargetForRequester(params: {
  commandParams: HandleCommandsParams;
  sessionKey?: string;
}): void {
  const requesterLookupKey = resolveRequesterLookupKey(params.commandParams);
  if (!requesterLookupKey) {
    return;
  }

  const targetSessionKey = params.sessionKey?.trim();
  if (!targetSessionKey) {
    RECENT_REQUESTER_ACP_TARGETS.delete(requesterLookupKey);
    return;
  }

  const current = RECENT_REQUESTER_ACP_TARGETS.get(requesterLookupKey);
  if (!current) {
    return;
  }
  if (current.sessionKey === targetSessionKey) {
    RECENT_REQUESTER_ACP_TARGETS.delete(requesterLookupKey);
  }
}

export function resolveBoundAcpThreadSessionKey(params: HandleCommandsParams): string | undefined {
  const commandTargetSessionKey = normalizeOptionalString(params.ctx.CommandTargetSessionKey) ?? "";
  const activeSessionKey =
    commandTargetSessionKey || (normalizeOptionalString(params.sessionKey) ?? "");
  const bindingContext = resolveAcpCommandBindingContext(params);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey,
    allowNonAcpBindingSessionKey: true,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
  });
}

export async function resolveAcpTargetSessionKey(params: {
  commandParams: HandleCommandsParams;
  token?: string;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; error: string }> {
  const token = normalizeOptionalString(params.token) ?? "";
  if (token) {
    const resolved = await resolveSessionKeyByToken(token);
    if (resolved) {
      return { ok: true, sessionKey: resolved };
    }
    // Token was supplied but could not be resolved as a session key/id/label.
    // Fall through to thread-bound resolution so that callers that auto-fill
    // the current thread ID as the token (e.g. Discord slash commands) still
    // reach the correct session via the binding context.
  }

  const threadBound = resolveBoundAcpThreadSessionKey(params.commandParams);
  if (threadBound) {
    rememberRecentAcpTargetForRequester({
      commandParams: params.commandParams,
      sessionKey: threadBound,
    });
    return {
      ok: true,
      sessionKey: threadBound,
    };
  }

  if (token) {
    return {
      ok: false,
      error: `Unable to resolve session target: ${token}`,
    };
  }

  const fallback = resolveRequesterSessionKey(params.commandParams, {
    preferCommandTarget: true,
  });
  if (!fallback) {
    return {
      ok: false,
      error: "Missing session key.",
    };
  }
  return {
    ok: true,
    sessionKey: fallback,
  };
}

export const __testing = {
  clearRecentAcpTargetCache() {
    RECENT_REQUESTER_ACP_TARGETS.clear();
  },
};

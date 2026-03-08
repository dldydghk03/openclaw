import { DISCORD_THREAD_BINDING_CHANNEL } from "../../../channels/thread-bindings-policy.js";
import { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import type { HandleCommandsParams } from "../commands-types.js";

function normalizeString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return "";
}

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  const raw =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return normalizeString(raw).toLowerCase();
}

export function resolveAcpCommandAccountId(params: HandleCommandsParams): string {
  const accountId = normalizeString(params.ctx.AccountId);
  return accountId || "default";
}

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  const threadId =
    params.ctx.MessageThreadId != null ? normalizeString(String(params.ctx.MessageThreadId)) : "";
  return threadId || undefined;
}

export function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined {
  const fromTargets = resolveConversationIdFromTargets({
    threadId: params.ctx.MessageThreadId,
    targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
  });
  if (fromTargets) {
    return fromTargets;
  }

  return resolveConversationIdFromSessionKeys({
    channel: resolveAcpCommandChannel(params),
    candidates: [
      params.ctx.CommandTargetSessionKey,
      params.ctx.SessionKey,
      params.sessionKey,
      params.ctx.ParentSessionKey,
    ],
  });
}

export function isAcpCommandDiscordChannel(params: HandleCommandsParams): boolean {
  return resolveAcpCommandChannel(params) === DISCORD_THREAD_BINDING_CHANNEL;
}

export function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
} {
  return {
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    conversationId: resolveAcpCommandConversationId(params),
  };
}

const CHAT_KIND_TOKENS = new Set(["direct", "dm", "group", "channel"]);

function resolveConversationIdFromSessionKeys(params: {
  channel: string;
  candidates: Array<string | undefined | null>;
}): string | undefined {
  const expectedChannel = normalizeString(params.channel).toLowerCase();
  if (!expectedChannel) {
    return undefined;
  }

  for (const candidate of params.candidates) {
    const parsed = parseAgentSessionKey(candidate);
    if (!parsed) {
      continue;
    }
    const scoped = normalizeString(parsed.rest).toLowerCase();
    if (!scoped) {
      continue;
    }
    const tokens = scoped.split(":").filter(Boolean);
    if (tokens[0] !== expectedChannel) {
      continue;
    }

    // Supported scoped layouts:
    // - <channel>:<kind>:<peerId>
    // - <channel>:<accountId>:<kind>:<peerId>
    // Optional trailing topic/thread suffix:
    // - ...:<peerId>:topic:<id>
    // - ...:<peerId>:thread:<id>
    let kindIndex = 1;
    if (!CHAT_KIND_TOKENS.has(tokens[kindIndex] ?? "") && CHAT_KIND_TOKENS.has(tokens[2] ?? "")) {
      kindIndex = 2;
    }
    if (!CHAT_KIND_TOKENS.has(tokens[kindIndex] ?? "")) {
      continue;
    }
    const peerId = tokens[kindIndex + 1];
    if (!peerId) {
      continue;
    }

    const suffixKind = tokens[kindIndex + 2];
    const suffixId = tokens[kindIndex + 3];
    if ((suffixKind === "topic" || suffixKind === "thread") && suffixId) {
      return `${peerId}:${suffixKind}:${suffixId}`;
    }
    return peerId;
  }

  return undefined;
}

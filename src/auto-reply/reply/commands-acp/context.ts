import { normalizeConversationText } from "../../../acp/conversation-id.js";
import { normalizeConversationTargetRef } from "../../../infra/outbound/session-binding-normalization.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import type { HandleCommandsParams } from "../commands-types.js";
import {
  resolveConversationBindingAccountIdFromMessage,
  resolveConversationBindingChannelFromMessage,
  resolveConversationBindingContextFromAcpCommand,
  resolveConversationBindingThreadIdFromMessage,
} from "../conversation-binding-input.js";

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  const resolved = resolveConversationBindingChannelFromMessage(params.ctx, params.command.channel);
  return normalizeLowercaseStringOrEmpty(normalizeConversationText(resolved));
}

export function resolveAcpCommandAccountId(params: HandleCommandsParams): string {
  return resolveConversationBindingAccountIdFromMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    commandChannel: params.command.channel,
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

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  return resolveConversationBindingThreadIdFromMessage(params.ctx);
}

function resolveAcpCommandConversationRef(params: HandleCommandsParams): {
  conversationId: string;
  parentConversationId?: string;
} | null {
  const resolved = resolveConversationBindingContextFromAcpCommand(params);
  if (!resolved) {
    return null;
  }
  return normalizeConversationTargetRef({
    conversationId: resolved.conversationId,
    parentConversationId: resolved.parentConversationId,
  });
}

export function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined {
  return resolveAcpCommandConversationRef(params)?.conversationId;
}

export function resolveAcpCommandParentConversationId(
  params: HandleCommandsParams,
): string | undefined {
  return resolveAcpCommandConversationRef(params)?.parentConversationId;
}

export function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const conversationRef = resolveAcpCommandConversationRef(params);
  if (!conversationRef) {
    return {
      channel: resolveAcpCommandChannel(params),
      accountId: resolveAcpCommandAccountId(params),
      threadId: resolveAcpCommandThreadId(params),
    };
  }
  return {
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    conversationId: conversationRef.conversationId,
    ...(conversationRef.parentConversationId
      ? { parentConversationId: conversationRef.parentConversationId }
      : {}),
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

const CHANNEL_PREFIX_ALLOWLIST = new Set([
  "telegram",
  "whatsapp",
  "signal",
  "discord",
  "slack",
  "irc",
  "imessage",
  "googlechat",
  "feishu",
  "nostr",
  "msteams",
  "mattermost",
  "nextcloud-talk",
  "matrix",
  "bluebubbles",
  "line",
  "zalo",
  "zalouser",
  "synology-chat",
  "tlon",
]);

function normalizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveConversationIdFromTargets(params: {
  threadId?: string | number;
  targets: Array<string | undefined | null>;
}): string | undefined {
  const threadId =
    params.threadId != null ? normalizeConversationId(String(params.threadId)) : undefined;
  if (threadId) {
    return threadId;
  }

  for (const rawTarget of params.targets) {
    const target = normalizeConversationId(rawTarget);
    if (!target) {
      continue;
    }
    if (target.startsWith("channel:")) {
      const channelId = normalizeConversationId(target.slice("channel:".length));
      if (channelId) {
        return channelId;
      }
      continue;
    }

    const prefixedTarget = target.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
    if (prefixedTarget) {
      const prefix = prefixedTarget[1]?.trim().toLowerCase();
      const suffix = normalizeConversationId(prefixedTarget[2]);
      if (prefix && suffix && CHANNEL_PREFIX_ALLOWLIST.has(prefix)) {
        return suffix;
      }
      continue;
    }

    const mentionMatch = target.match(/^<#(\d+)>$/);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^\d{6,}$/.test(target)) {
      return target;
    }
  }

  return undefined;
}

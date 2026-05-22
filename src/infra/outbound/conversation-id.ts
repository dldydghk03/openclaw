import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

function resolveExplicitConversationTargetId(target: string): string | undefined {
  for (const prefix of ["channel:", "conversation:", "group:", "room:", "dm:"]) {
    if (normalizeLowercaseStringOrEmpty(target).startsWith(prefix)) {
      return normalizeOptionalString(target.slice(prefix.length));
    }
  }
  return undefined;
}

export function resolveConversationIdFromTargets(params: {
  threadId?: string | number;
  targets: Array<string | undefined | null>;
}): string | undefined {
  const threadId = stringifyRouteThreadId(params.threadId);
  if (threadId) {
    return threadId;
  }

  for (const rawTarget of params.targets) {
    const target = normalizeOptionalString(rawTarget);
    if (!target) {
      continue;
    }
    const explicitConversationId = resolveExplicitConversationTargetId(target);
    if (explicitConversationId) {
      return explicitConversationId;
    }
    if (target.includes(":") && explicitConversationId === undefined) {
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

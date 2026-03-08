import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { buildCommandTestParams } from "../commands-spawn.test-harness.js";
import {
  isAcpCommandDiscordChannel,
  resolveAcpCommandBindingContext,
  resolveAcpCommandConversationId,
} from "./context.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("commands-acp context", () => {
  it("resolves channel/account/thread context from originating fields", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:parent-1",
      AccountId: "work",
      MessageThreadId: "thread-42",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "discord",
      accountId: "work",
      threadId: "thread-42",
      conversationId: "thread-42",
    });
    expect(isAcpCommandDiscordChannel(params)).toBe(true);
  });

  it("falls back to default account and target-derived conversation id", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      To: "<#123456789>",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "slack",
      accountId: "default",
      threadId: undefined,
      conversationId: "123456789",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("123456789");
    expect(isAcpCommandDiscordChannel(params)).toBe(false);
  });

  it("falls back to telegram session key when originating targets are missing", () => {
    const params = buildCommandTestParams("/acp spawn codex --thread auto", baseCfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:main:telegram:direct:6848608231",
    });

    expect(resolveAcpCommandConversationId(params)).toBe("6848608231");
    expect(resolveAcpCommandBindingContext(params)).toEqual({
      channel: "telegram",
      accountId: "default",
      threadId: undefined,
      conversationId: "6848608231",
    });
  });

  it("preserves topic suffix when recovering telegram group conversation from session key", () => {
    const params = buildCommandTestParams("/acp spawn codex --thread auto", baseCfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
    });

    expect(resolveAcpCommandConversationId(params)).toBe("-1001234567890:topic:99");
  });

  it("uses CommandTargetSessionKey for native telegram slash command context", () => {
    const params = buildCommandTestParams("/acp spawn codex --thread auto", baseCfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "telegram:slash:6848608231",
      CommandTargetSessionKey: "agent:main:telegram:direct:6848608231",
    });

    expect(resolveAcpCommandConversationId(params)).toBe("6848608231");
  });
});

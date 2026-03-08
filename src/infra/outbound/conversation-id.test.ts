import { describe, expect, it } from "vitest";
import { resolveConversationIdFromTargets } from "./conversation-id.js";

describe("resolveConversationIdFromTargets", () => {
  it("prefers explicit thread id when present", () => {
    const resolved = resolveConversationIdFromTargets({
      threadId: "123456789",
      targets: ["channel:987654321"],
    });
    expect(resolved).toBe("123456789");
  });

  it("extracts channel ids from channel: targets", () => {
    const resolved = resolveConversationIdFromTargets({
      targets: ["channel:987654321"],
    });
    expect(resolved).toBe("987654321");
  });

  it("extracts ids from Discord channel mentions", () => {
    const resolved = resolveConversationIdFromTargets({
      targets: ["<#1475250310120214812>"],
    });
    expect(resolved).toBe("1475250310120214812");
  });

  it("accepts raw numeric ids", () => {
    const resolved = resolveConversationIdFromTargets({
      targets: ["1475250310120214812"],
    });
    expect(resolved).toBe("1475250310120214812");
  });

  it("extracts conversation ids from telegram:<id> targets", () => {
    const resolved = resolveConversationIdFromTargets({
      targets: ["telegram:6848608231"],
    });
    expect(resolved).toBe("6848608231");
  });

  it("supports negative Telegram supergroup ids in prefixed targets", () => {
    const resolved = resolveConversationIdFromTargets({
      targets: ["telegram:-100249586642"],
    });
    expect(resolved).toBe("-100249586642");
  });

  it("ignores non-channel prefixes", () => {
    const resolved = resolveConversationIdFromTargets({
      targets: ["session:abc", "user:alice"],
    });
    expect(resolved).toBeUndefined();
  });

  it("returns undefined for non-channel targets", () => {
    const resolved = resolveConversationIdFromTargets({
      targets: ["user:alice", "general"],
    });
    expect(resolved).toBeUndefined();
  });
});

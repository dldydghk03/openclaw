import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSkillSnapshot } from "../../config/sessions.js";
import { runPreparedReply } from "./get-reply-run.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn().mockReturnValue("main"),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

vi.mock("./groups.js", () => ({
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
}));

vi.mock("./queue.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "followup" }),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
  prependSystemEvents: vi.fn().mockImplementation(async ({ prefixedBodyBase }) => prefixedBodyBase),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

import { runReplyAgent } from "./agent-runner.js";
import { ensureSkillSnapshot } from "./session-updates.js";

type ResolvedSkill = NonNullable<SessionSkillSnapshot["resolvedSkills"]>[number];

function mockResolvedSkill(name: string): ResolvedSkill {
  return {
    name,
    description: `${name} skill`,
    filePath: `/tmp/skills/${name}/SKILL.md`,
    baseDir: "/tmp/skills",
    source: "workspace",
    disableModelInvocation: false,
  };
}

function mockSkillsSnapshot(skillNames: string[]): SessionSkillSnapshot {
  return {
    prompt: "",
    skills: skillNames.map((name) => ({ name })),
    resolvedSkills: skillNames.map((name) => mockResolvedSkill(name)),
    version: 1,
  };
}

function baseParams(
  body: string,
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: {
      Body: body,
      RawBody: body,
      CommandBody: body,
      ThreadHistoryBody: "Earlier message in this thread",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      ChatType: "group",
    },
    sessionCtx: {
      Body: body,
      BodyStripped: body,
      ThreadHistoryBody: "Earlier message in this thread",
      Provider: "telegram",
      ChatType: "group",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: {
      hasThinkDirective: false,
      thinkLevel: undefined,
    } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    ...overrides,
  };
}

describe("runPreparedReply skill consent routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for obsidian skill consent on note-edit intent", async () => {
    vi.mocked(ensureSkillSnapshot).mockImplementationOnce(async ({ sessionEntry, systemSent }) => ({
      sessionEntry,
      systemSent,
      skillsSnapshot: mockSkillsSnapshot(["obsidian", "weather"]),
    }));

    const result = await runPreparedReply(baseParams("옵시디언 마스터 노트 업데이트해줘"));

    expect(result).toEqual({
      text: "obsidian 스킬을 사용해서 수행할까요?",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("skips extra consent when user explicitly requests a skill", async () => {
    vi.mocked(ensureSkillSnapshot).mockImplementationOnce(async ({ sessionEntry, systemSent }) => ({
      sessionEntry,
      systemSent,
      skillsSnapshot: mockSkillsSnapshot(["obsidian"]),
    }));

    const result = await runPreparedReply(
      baseParams("obsidian 스킬을 사용해서 마스터 노트 업데이트"),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledTimes(1);
  });

  it("does not suggest spotify skill for generic playlist intents", async () => {
    vi.mocked(ensureSkillSnapshot).mockImplementationOnce(async ({ sessionEntry, systemSent }) => ({
      sessionEntry,
      systemSent,
      skillsSnapshot: mockSkillsSnapshot(["spotify-player"]),
    }));

    const result = await runPreparedReply(baseParams("괜찮은 플레이리스트 틀어줘"));

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledTimes(1);
  });

  it("does not suggest spotify skill for youtube tab intents", async () => {
    vi.mocked(ensureSkillSnapshot).mockImplementationOnce(async ({ sessionEntry, systemSent }) => ({
      sessionEntry,
      systemSent,
      skillsSnapshot: mockSkillsSnapshot(["spotify-player"]),
    }));

    const result = await runPreparedReply(baseParams("유튜브 열어줘"));

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledTimes(1);
  });

  it("does not route finance text containing 식비 to weather skill", async () => {
    vi.mocked(ensureSkillSnapshot).mockImplementationOnce(async ({ sessionEntry, systemSent }) => ({
      sessionEntry,
      systemSent,
      skillsSnapshot: mockSkillsSnapshot(["weather", "obsidian"]),
    }));

    const result = await runPreparedReply(baseParams("가계부에 저녁 식비 18000원 썼어"));

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledTimes(1);
  });

  it("asks apple-reminders consent for reminder intents", async () => {
    vi.mocked(ensureSkillSnapshot).mockImplementationOnce(async ({ sessionEntry, systemSent }) => ({
      sessionEntry,
      systemSent,
      skillsSnapshot: mockSkillsSnapshot(["apple-reminders", "obsidian"]),
    }));

    const result = await runPreparedReply(baseParams("내일 할 일 리마인더 추가해줘"));

    expect(result).toEqual({
      text: "apple-reminders 스킬을 사용해서 수행할까요?",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });
});

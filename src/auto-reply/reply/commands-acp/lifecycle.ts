import { randomUUID } from "node:crypto";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../../../acp/control-plane/spawn.js";
import {
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
  resolveAcpDispatchPolicyMessage,
} from "../../../acp/policy.js";
import { AcpRuntimeError } from "../../../acp/runtime/errors.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  DISCORD_THREAD_BINDING_CHANNEL,
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import { callGateway } from "../../../gateway/call.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  resolveAcpCommandAccountId,
  resolveAcpCommandBindingContext,
  resolveAcpCommandThreadId,
} from "./context.js";
import {
  ACP_MODE_CODEX_TEXT,
  ACP_MODE_DEFAULT_TEXT,
  ACP_OFF_USAGE,
  ACP_ON_USAGE,
  ACP_STEER_OUTPUT_LIMIT,
  collectAcpErrorText,
  parseSpawnInput,
  parseSteerInput,
  resolveCommandRequestId,
  stopWithText,
  type AcpSpawnThreadMode,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import {
  clearRecentAcpTargetForRequester,
  rememberRecentAcpTargetForRequester,
  resolveRecentAcpTargetForRequester,
  resolveAcpTargetSessionKey,
} from "./targets.js";

const DEFAULT_ACP_STEER_TIMEOUT_MS = 120_000;
const MIN_ACP_STEER_TIMEOUT_MS = 1_000;
const MAX_ACP_STEER_TIMEOUT_MS = 10 * 60_000;

function resolveAcpSteerTimeoutMs(): number {
  const rawText = process.env.OPENCLAW_ACP_STEER_TIMEOUT_MS;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return DEFAULT_ACP_STEER_TIMEOUT_MS;
  }
  const raw = Number(rawText);
  if (!Number.isFinite(raw)) {
    return DEFAULT_ACP_STEER_TIMEOUT_MS;
  }
  const rounded = Math.round(raw);
  return Math.min(MAX_ACP_STEER_TIMEOUT_MS, Math.max(MIN_ACP_STEER_TIMEOUT_MS, rounded));
}

function runtimeStatusLooksDead(runtimeStatus: { summary?: string; details?: unknown }): boolean {
  const summary = runtimeStatus.summary?.toLowerCase() || "";
  if (summary.includes("status=dead")) {
    return true;
  }
  const details =
    runtimeStatus.details && typeof runtimeStatus.details === "object"
      ? (runtimeStatus.details as Record<string, unknown>)
      : undefined;
  return (typeof details?.status === "string" ? details.status.toLowerCase() : "") === "dead";
}

async function resolveSteerTimeoutRecoveryMessage(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  timeoutMs: number;
}): Promise<string> {
  const acpManager = getAcpSessionManager();
  const timeoutSeconds = Math.ceil(params.timeoutMs / 1000);
  try {
    const status = await acpManager.getSessionStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!status.runtimeStatus) {
      return [
        `ACP steer timed out after ${timeoutSeconds}s.`,
        "auto-check: /acp status did not return runtime health details.",
        "next:",
        "1) /acp status",
        "2) /acp on",
      ].join("\n");
    }
    if (runtimeStatusLooksDead(status.runtimeStatus)) {
      return [
        `ACP steer timed out after ${timeoutSeconds}s.`,
        "auto-check: /acp status shows the runtime is not healthy.",
        "next:",
        "1) /acp on",
        "2) /acp status",
      ].join("\n");
    }
    return [
      `ACP steer timed out after ${timeoutSeconds}s.`,
      "auto-check: /acp status indicates the runtime is still alive.",
      "next:",
      "1) /acp steer <repo instruction>",
      "2) if needed, /acp cancel and retry",
    ].join("\n");
  } catch {
    return [
      `ACP steer timed out after ${timeoutSeconds}s.`,
      "auto-check: /acp status probe failed.",
      "next:",
      "1) /acp status",
      "2) /acp on",
    ].join("\n");
  }
}

async function bindSpawnedAcpSessionToThread(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
  threadMode: AcpSpawnThreadMode;
  sessionMeta?: SessionAcpMeta;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  const { commandParams, threadMode } = params;
  if (threadMode === "off") {
    return {
      ok: false,
      error: "internal: thread binding is disabled for this spawn",
    };
  }

  const bindingContext = resolveAcpCommandBindingContext(commandParams);
  const channel = bindingContext.channel;
  if (!channel) {
    return {
      ok: false,
      error: "ACP thread binding requires a channel context.",
    };
  }

  const accountId = resolveAcpCommandAccountId(commandParams);
  const spawnPolicy = resolveThreadBindingSpawnPolicy({
    cfg: commandParams.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!spawnPolicy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        kind: "acp",
      }),
    };
  }
  if (!spawnPolicy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        kind: "acp",
      }),
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: spawnPolicy.channel,
    accountId: spawnPolicy.accountId,
  });
  if (!capabilities.adapterAvailable) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${channel}.`,
    };
  }
  if (!capabilities.bindSupported) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${channel}.`,
    };
  }

  const currentThreadId = bindingContext.threadId ?? "";

  if (threadMode === "here" && !currentThreadId) {
    return {
      ok: false,
      error: `--thread here requires running /acp spawn inside an active ${channel} thread/conversation.`,
    };
  }

  const threadId = currentThreadId || undefined;
  const placement = threadId ? "current" : "child";
  if (!capabilities.placements.includes(placement)) {
    return {
      ok: false,
      error: `Thread bindings do not support ${placement} placement for ${channel}.`,
    };
  }
  const channelId = placement === "child" ? bindingContext.conversationId : undefined;

  if (placement === "child" && !channelId) {
    return {
      ok: false,
      error: `Could not resolve a ${channel} conversation for ACP thread spawn.`,
    };
  }

  const senderId = commandParams.command.senderId?.trim() || "";
  if (threadId) {
    const existingBinding = bindingService.resolveByConversation({
      channel: spawnPolicy.channel,
      accountId: spawnPolicy.accountId,
      conversationId: threadId,
    });
    const boundBy =
      typeof existingBinding?.metadata?.boundBy === "string"
        ? existingBinding.metadata.boundBy.trim()
        : "";
    if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      return {
        ok: false,
        error: `Only ${boundBy} can rebind this thread.`,
      };
    }
  }

  const label = params.label || params.agentId;
  const conversationId = threadId || channelId;
  if (!conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${channel} conversation for ACP thread spawn.`,
    };
  }

  try {
    const binding = await bindingService.bind({
      targetSessionKey: params.sessionKey,
      targetKind: "session",
      conversation: {
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        conversationId,
      },
      placement,
      metadata: {
        threadName: resolveThreadBindingThreadName({
          agentId: params.agentId,
          label,
        }),
        agentId: params.agentId,
        label,
        boundBy: senderId || "unknown",
        introText: resolveThreadBindingIntroText({
          agentId: params.agentId,
          label,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: commandParams.cfg,
            channel: spawnPolicy.channel,
            accountId: spawnPolicy.accountId,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: commandParams.cfg,
            channel: spawnPolicy.channel,
            accountId: spawnPolicy.accountId,
          }),
          sessionCwd: resolveAcpSessionCwd(params.sessionMeta),
          sessionDetails: resolveAcpThreadSessionDetailLines({
            sessionKey: params.sessionKey,
            meta: params.sessionMeta,
          }),
        }),
      },
    });
    return {
      ok: true,
      binding,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message || `Failed to bind a ${channel} thread/conversation to the new ACP session.`,
    };
  }
}

async function cleanupFailedSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  shouldDeleteSession: boolean;
  initializedRuntime?: AcpSpawnRuntimeCloseHandle;
}) {
  await cleanupFailedAcpSpawn({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    shouldDeleteSession: params.shouldDeleteSession,
    deleteTranscript: false,
    runtimeCloseHandle: params.initializedRuntime,
  });
}

function resolveConversationAttachedAcpSpawnTarget(params: {
  commandParams: HandleCommandsParams;
  threadMode: AcpSpawnThreadMode;
}):
  | {
      ok: true;
      target?: {
        sessionKey: string;
        channel: string;
        conversationId: string;
      };
    }
  | { ok: false; error: string } {
  if (params.threadMode === "off") {
    return { ok: true };
  }

  const bindingContext = resolveAcpCommandBindingContext(params.commandParams);
  const channel = bindingContext.channel.trim().toLowerCase();
  if (!channel || channel === DISCORD_THREAD_BINDING_CHANNEL) {
    return { ok: true };
  }

  const conversationId = bindingContext.conversationId?.trim() || "";
  if (!conversationId) {
    return {
      ok: false,
      error:
        params.threadMode === "here"
          ? `--thread here requires running /acp spawn inside an active ${channel} conversation.`
          : `--thread auto requires running /acp spawn inside an active ${channel} conversation.`,
    };
  }

  const sessionKey =
    resolveRequesterSessionKey(params.commandParams, {
      preferCommandTarget: true,
    })?.trim() || "";
  if (!sessionKey) {
    return {
      ok: false,
      error: "Missing session key for ACP spawn.",
    };
  }

  return {
    ok: true,
    target: {
      sessionKey,
      channel,
      conversationId,
    },
  };
}

export async function handleAcpOnAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (restTokens.length > 0) {
    return stopWithText(`⚠️ ${ACP_ON_USAGE}`);
  }
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return stopWithText("ACP is disabled by policy (`acp.enabled=false`).");
  }

  const acpManager = getAcpSessionManager();
  const recentSessionKey = resolveRecentAcpTargetForRequester(params);
  if (recentSessionKey) {
    const resolved = acpManager.resolveSession({
      cfg: params.cfg,
      sessionKey: recentSessionKey,
    });
    if (
      resolved.kind === "ready" &&
      resolved.meta.mode === "persistent" &&
      resolved.meta.agent.trim().toLowerCase() === "codex"
    ) {
      rememberRecentAcpTargetForRequester({
        commandParams: params,
        sessionKey: recentSessionKey,
      });
      return stopWithText(
        [
          `✅ ACP on: resumed Codex session ${recentSessionKey}.`,
          "You can run /acp steer, /acp status, and /acp cancel without a session key.",
          ACP_MODE_CODEX_TEXT,
        ].join("\n"),
      );
    }
  }

  return await handleAcpSpawnAction(params, ["codex", "--mode", "persistent"]);
}

export function handleAcpOffAction(
  params: HandleCommandsParams,
  restTokens: string[],
): CommandHandlerResult {
  if (restTokens.length > 0) {
    return stopWithText(`⚠️ ${ACP_OFF_USAGE}`);
  }

  const recentSessionKey = resolveRecentAcpTargetForRequester(params);
  clearRecentAcpTargetForRequester({
    commandParams: params,
  });

  if (!recentSessionKey) {
    return stopWithText(
      [
        "ℹ️ ACP off: no recent ACP target was set for this conversation.",
        ACP_MODE_DEFAULT_TEXT,
      ].join("\n"),
    );
  }

  return stopWithText(
    [
      `✅ ACP off: cleared recent ACP target for this conversation (${recentSessionKey}).`,
      `Session remains available. Use /acp close ${recentSessionKey} to fully close it.`,
      ACP_MODE_DEFAULT_TEXT,
    ].join("\n"),
  );
}

export async function handleAcpSpawnAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return stopWithText("ACP is disabled by policy (`acp.enabled=false`).");
  }

  const parsed = parseSpawnInput(params, restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }

  const spawn = parsed.value;
  const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, spawn.agentId);
  if (agentPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: agentPolicyError,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "ACP target agent is not allowed by policy.",
      }),
    );
  }

  const conversationAttachedTarget = resolveConversationAttachedAcpSpawnTarget({
    commandParams: params,
    threadMode: spawn.thread,
  });
  if (!conversationAttachedTarget.ok) {
    return stopWithText(`⚠️ ${conversationAttachedTarget.error}`);
  }

  const acpManager = getAcpSessionManager();
  const sessionKey =
    conversationAttachedTarget.target?.sessionKey || `agent:${spawn.agentId}:acp:${randomUUID()}`;
  const shouldDeleteSpawnSession = !conversationAttachedTarget.target;

  let initializedBackend = "";
  let initializedMeta: SessionAcpMeta | undefined;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    const initialized = await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey,
      agent: spawn.agentId,
      mode: spawn.mode,
      cwd: spawn.cwd,
    });
    initializedRuntime = {
      runtime: initialized.runtime,
      handle: initialized.handle,
    };
    initializedBackend = initialized.handle.backend || initialized.meta.backend;
    initializedMeta = initialized.meta;
  } catch (err) {
    return stopWithText(
      collectAcpErrorText({
        error: err,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      }),
    );
  }

  let binding: SessionBindingRecord | null = null;
  if (spawn.thread !== "off" && !conversationAttachedTarget.target) {
    const bound = await bindSpawnedAcpSessionToThread({
      commandParams: params,
      sessionKey,
      agentId: spawn.agentId,
      label: spawn.label,
      threadMode: spawn.thread,
      sessionMeta: initializedMeta,
    });
    if (!bound.ok) {
      await cleanupFailedSpawn({
        cfg: params.cfg,
        sessionKey,
        shouldDeleteSession: shouldDeleteSpawnSession,
        initializedRuntime,
      });
      return stopWithText(`⚠️ ${bound.error}`);
    }
    binding = bound.binding;
  }

  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        ...(spawn.label ? { label: spawn.label } : {}),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    await cleanupFailedSpawn({
      cfg: params.cfg,
      sessionKey,
      shouldDeleteSession: shouldDeleteSpawnSession,
      initializedRuntime,
    });
    const message = err instanceof Error ? err.message : String(err);
    return stopWithText(`⚠️ ACP spawn failed: ${message}`);
  }

  rememberRecentAcpTargetForRequester({
    commandParams: params,
    sessionKey,
  });

  const parts = [
    `✅ Spawned ACP session ${sessionKey} (${spawn.mode}, backend ${initializedBackend}).`,
  ];
  if (binding) {
    const currentThreadId = resolveAcpCommandThreadId(params) ?? "";
    const boundConversationId = binding.conversation.conversationId.trim();
    if (currentThreadId && boundConversationId === currentThreadId) {
      parts.push(`Bound this thread to ${sessionKey}.`);
    } else {
      parts.push(`Created thread ${boundConversationId} and bound it to ${sessionKey}.`);
    }
  } else if (conversationAttachedTarget.target) {
    parts.push(
      `Attached this ${conversationAttachedTarget.target.channel} conversation to ${sessionKey}.`,
    );
  } else {
    const channel = resolveAcpCommandBindingContext(params).channel.trim().toLowerCase();
    if (channel && channel !== DISCORD_THREAD_BINDING_CHANNEL) {
      parts.push(
        `Session is unbound (use explicit target commands like /acp status ${sessionKey} or /acp steer --session ${sessionKey} <instruction>).`,
      );
    } else {
      parts.push("Session is unbound (use /focus <session-key> to bind this thread/conversation).");
    }
  }
  parts.push("This session is now your recent ACP target in this conversation.");
  parts.push("You can run /acp steer, /acp status, and /acp cancel without a session key.");
  parts.push(ACP_MODE_CODEX_TEXT);

  const dispatchNote = resolveAcpDispatchPolicyMessage(params.cfg);
  if (dispatchNote) {
    parts.push(`ℹ️ ${dispatchNote}`);
  }

  return stopWithText(parts.join(" "));
}

export async function handleAcpCancelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const acpManager = getAcpSessionManager();
  const token = restTokens.join(" ").trim() || undefined;
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const resolved = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (resolved.kind === "none") {
    return stopWithText(
      collectAcpErrorText({
        error: new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${target.sessionKey}`,
        ),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Session is not ACP-enabled.",
      }),
    );
  }
  if (resolved.kind === "stale") {
    return stopWithText(
      collectAcpErrorText({
        error: resolved.error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: resolved.error.message,
      }),
    );
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        reason: "manual-cancel",
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP cancel failed before completion.",
    onSuccess: () => stopWithText(`✅ Cancel requested for ACP session ${target.sessionKey}.`),
  });
}

async function runAcpSteer(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  instruction: string;
  requestId: string;
}): Promise<string> {
  const acpManager = getAcpSessionManager();
  const timeoutMs = resolveAcpSteerTimeoutMs();
  let output = "";
  const timeoutController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const runPromise = acpManager.runTurn({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    text: params.instruction,
    mode: "steer",
    requestId: params.requestId,
    signal: timeoutController.signal,
    onEvent: (event) => {
      if (event.type !== "text_delta") {
        return;
      }
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (event.text) {
        output += event.text;
        if (output.length > ACP_STEER_OUTPUT_LIMIT) {
          output = `${output.slice(0, ACP_STEER_OUTPUT_LIMIT)}…`;
        }
      }
    },
  });

  try {
    await Promise.race([
      runPromise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
          reject(new AcpRuntimeError("ACP_TURN_FAILED", "ACP steer timed out."));
        }, timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      void runPromise.catch(() => {});
      await acpManager
        .cancelSession({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          reason: "steer-timeout",
        })
        .catch(() => {});
      const recoveryMessage = await resolveSteerTimeoutRecoveryMessage({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        timeoutMs,
      });
      throw new AcpRuntimeError("ACP_TURN_FAILED", recoveryMessage);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
  return output.trim();
}

export async function handleAcpSteerAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
  if (dispatchPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: dispatchPolicyError,
        fallbackCode: "ACP_DISPATCH_DISABLED",
        fallbackMessage: dispatchPolicyError.message,
      }),
    );
  }

  const parsed = parseSteerInput(restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const acpManager = getAcpSessionManager();

  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const resolved = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (resolved.kind === "none") {
    return stopWithText(
      collectAcpErrorText({
        error: new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${target.sessionKey}`,
        ),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Session is not ACP-enabled.",
      }),
    );
  }
  if (resolved.kind === "stale") {
    return stopWithText(
      collectAcpErrorText({
        error: resolved.error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: resolved.error.message,
      }),
    );
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await runAcpSteer({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        instruction: parsed.value.instruction,
        requestId: `${resolveCommandRequestId(params)}:steer`,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP steer failed before completion.",
    onSuccess: (steerOutput) => {
      if (!steerOutput) {
        return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.`);
      }
      return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.\n${steerOutput}`);
    },
  });
}

export async function handleAcpCloseAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const acpManager = getAcpSessionManager();
  const token = restTokens.join(" ").trim() || undefined;
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const resolved = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (resolved.kind === "none") {
    return stopWithText(
      collectAcpErrorText({
        error: new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Session is not ACP-enabled: ${target.sessionKey}`,
        ),
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Session is not ACP-enabled.",
      }),
    );
  }
  if (resolved.kind === "stale") {
    return stopWithText(
      collectAcpErrorText({
        error: resolved.error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: resolved.error.message,
      }),
    );
  }

  let runtimeNotice = "";
  try {
    const closed = await acpManager.closeSession({
      cfg: params.cfg,
      sessionKey: target.sessionKey,
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });
    runtimeNotice = closed.runtimeNotice ? ` (${closed.runtimeNotice})` : "";
  } catch (error) {
    return stopWithText(
      collectAcpErrorText({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      }),
    );
  }

  const removedBindings = await getSessionBindingService().unbind({
    targetSessionKey: target.sessionKey,
    reason: "manual",
  });

  clearRecentAcpTargetForRequester({
    commandParams: params,
    sessionKey: target.sessionKey,
  });

  return stopWithText(
    [
      `✅ Closed ACP session ${target.sessionKey}${runtimeNotice}. Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
      ACP_MODE_DEFAULT_TEXT,
    ].join("\n"),
  );
}

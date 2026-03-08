import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import {
  parseRuntimeTimeoutSecondsInput,
  validateRuntimeConfigOptionInput,
  validateRuntimeCwdInput,
  validateRuntimeModeInput,
  validateRuntimeModelInput,
  validateRuntimePermissionProfileInput,
} from "../../../acp/control-plane/runtime-options.js";
import { toAcpRuntimeError } from "../../../acp/runtime/errors.js";
import { resolveAcpSessionIdentifierLinesFromIdentity } from "../../../acp/runtime/session-identifiers.js";
import type { AcpRuntimeStatus } from "../../../acp/runtime/types.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  ACP_MODE_CODEX_TEXT,
  ACP_CWD_USAGE,
  ACP_MODEL_USAGE,
  ACP_PERMISSIONS_USAGE,
  ACP_RESET_OPTIONS_USAGE,
  ACP_SET_MODE_USAGE,
  ACP_STATUS_USAGE,
  ACP_TIMEOUT_USAGE,
  formatAcpCapabilitiesText,
  formatRuntimeOptionsText,
  parseOptionalSingleTarget,
  parseSetCommandInput,
  parseSingleValueCommandInput,
  stopWithText,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildRuntimeHealthLines(params: {
  mode: string;
  runtimeStatus?: AcpRuntimeStatus;
}): string[] {
  const summary = params.runtimeStatus?.summary?.toLowerCase() ?? "";
  const details = params.runtimeStatus?.details;
  const detailsRecord = details && typeof details === "object" ? details : undefined;
  const status = asOptionalString(detailsRecord?.status)?.toLowerCase();
  const effectiveStatus = status ?? (summary.includes("status=dead") ? "dead" : undefined);

  if (effectiveStatus !== "dead") {
    return [];
  }

  const ownerStatus = asOptionalString(detailsRecord?.ownerStatus)?.toLowerCase();
  const exitCode = asOptionalFiniteNumber(detailsRecord?.exitCode);
  const signal = asOptionalString(detailsRecord?.signal);

  if (params.mode === "persistent") {
    if (exitCode != null || signal) {
      const cause =
        exitCode != null ? `exitCode=${exitCode}` : signal ? `signal=${signal}` : "unknown";
      return [
        `runtimeHealth: degraded (persistent runtime exited: ${cause})`,
        "next: run /acp close, then /acp spawn codex --mode persistent and retry in this conversation.",
      ];
    }
    if (ownerStatus === "active") {
      return [
        "runtimeHealth: standby (owner active; worker process starts on demand when a turn runs).",
      ];
    }
    return [
      "runtimeHealth: cold (session is attached but owner is inactive until the first prompt).",
    ];
  }

  if (params.mode === "oneshot") {
    return ["runtimeHealth: idle (oneshot runtime is not kept alive between turns)."];
  }

  return [];
}

function mapPermissionProfileToMode(permissionProfile: string): string | null {
  const normalized = permissionProfile.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized === "never" ||
    normalized === "approve-all" ||
    normalized === "full-access" ||
    normalized === "danger-full-access" ||
    normalized === "yolo"
  ) {
    return "full-access";
  }
  if (
    normalized === "read-only" ||
    normalized === "deny-all" ||
    normalized === "strict" ||
    normalized === "deny"
  ) {
    return "read-only";
  }
  if (
    normalized === "approve-reads" ||
    normalized === "auto" ||
    normalized === "default" ||
    normalized === "on-request"
  ) {
    return "auto";
  }
  return null;
}

export async function handleAcpStatusAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseOptionalSingleTarget(restTokens, ACP_STATUS_USAGE);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().getSessionStatus({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not read ACP session status.",
    onSuccess: (status) => {
      const sessionIdentifierLines = resolveAcpSessionIdentifierLinesFromIdentity({
        backend: status.backend,
        identity: status.identity,
      });
      const lines = [
        "ACP status:",
        "-----",
        ACP_MODE_CODEX_TEXT,
        `session: ${status.sessionKey}`,
        `backend: ${status.backend}`,
        `agent: ${status.agent}`,
        ...sessionIdentifierLines,
        `sessionMode: ${status.mode}`,
        `state: ${status.state}`,
        `runtimeOptions: ${formatRuntimeOptionsText(status.runtimeOptions)}`,
        `capabilities: ${formatAcpCapabilitiesText(status.capabilities.controls)}`,
        `lastActivityAt: ${new Date(status.lastActivityAt).toISOString()}`,
        ...(status.lastError ? [`lastError: ${status.lastError}`] : []),
        ...(status.runtimeStatus?.summary ? [`runtime: ${status.runtimeStatus.summary}`] : []),
        ...buildRuntimeHealthLines({
          mode: status.mode,
          runtimeStatus: status.runtimeStatus,
        }),
        ...(status.runtimeStatus?.details
          ? [`runtimeDetails: ${JSON.stringify(status.runtimeStatus.details)}`]
          : []),
      ];
      return stopWithText(lines.join("\n"));
    },
  });
}

export async function handleAcpSetModeAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(restTokens, ACP_SET_MODE_USAGE);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const runtimeMode = validateRuntimeModeInput(parsed.value.value);
      const options = await getAcpSessionManager().setSessionRuntimeMode({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        runtimeMode,
      });
      return {
        runtimeMode,
        options,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP runtime mode.",
    onSuccess: ({ runtimeMode, options }) =>
      stopWithText(
        `✅ Updated ACP runtime mode for ${target.sessionKey}: ${runtimeMode}. Effective options: ${formatRuntimeOptionsText(options)}`,
      ),
  });
}

export async function handleAcpSetAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSetCommandInput(restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  const key = parsed.value.key.trim();
  const value = parsed.value.value.trim();

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "cwd") {
        const cwd = validateRuntimeCwdInput(value);
        const options = await getAcpSessionManager().updateSessionRuntimeOptions({
          cfg: params.cfg,
          sessionKey: target.sessionKey,
          patch: { cwd },
        });
        return {
          text: `✅ Updated ACP cwd for ${target.sessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
        };
      }
      const validated = validateRuntimeConfigOptionInput(key, value);
      const options = await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        key: validated.key,
        value: validated.value,
      });
      return {
        text: `✅ Updated ACP config option for ${target.sessionKey}: ${validated.key}=${validated.value}. Effective options: ${formatRuntimeOptionsText(options)}`,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP config option.",
    onSuccess: ({ text }) => stopWithText(text),
  });
}

export async function handleAcpCwdAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(restTokens, ACP_CWD_USAGE);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const cwd = validateRuntimeCwdInput(parsed.value.value);
      const options = await getAcpSessionManager().updateSessionRuntimeOptions({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        patch: { cwd },
      });
      return {
        cwd,
        options,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP cwd.",
    onSuccess: ({ cwd, options }) =>
      stopWithText(
        `✅ Updated ACP cwd for ${target.sessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
      ),
  });
}

export async function handleAcpPermissionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(restTokens, ACP_PERMISSIONS_USAGE);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  return await withAcpCommandErrorBoundary({
    run: async () => {
      const permissionProfile = validateRuntimePermissionProfileInput(parsed.value.value);
      const acpManager = getAcpSessionManager();
      try {
        const options = await acpManager.setSessionConfigOption({
          cfg: params.cfg,
          sessionKey: target.sessionKey,
          key: "approval_policy",
          value: permissionProfile,
        });
        return {
          permissionProfile,
          options,
          mappedMode: null as string | null,
        };
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "Could not update ACP permissions profile.",
        });
        if (acpError.code !== "ACP_BACKEND_UNSUPPORTED_CONTROL") {
          throw error;
        }
        const mappedMode = mapPermissionProfileToMode(permissionProfile);
        if (!mappedMode) {
          throw error;
        }
        const options = await acpManager.setSessionConfigOption({
          cfg: params.cfg,
          sessionKey: target.sessionKey,
          key: "mode",
          value: mappedMode,
        });
        return {
          permissionProfile,
          options,
          mappedMode,
        };
      }
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP permissions profile.",
    onSuccess: ({ permissionProfile, options, mappedMode }) => {
      if (mappedMode) {
        return stopWithText(
          `✅ Updated ACP permissions for ${target.sessionKey}: ${permissionProfile} (mapped to mode=${mappedMode}). Effective options: ${formatRuntimeOptionsText(options)}`,
        );
      }
      return stopWithText(
        `✅ Updated ACP permissions profile for ${target.sessionKey}: ${permissionProfile}. Effective options: ${formatRuntimeOptionsText(options)}`,
      );
    },
  });
}

export async function handleAcpTimeoutAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(restTokens, ACP_TIMEOUT_USAGE);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const timeoutSeconds = parseRuntimeTimeoutSecondsInput(parsed.value.value);
      const options = await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        key: "timeout",
        value: String(timeoutSeconds),
      });
      return {
        timeoutSeconds,
        options,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP timeout.",
    onSuccess: ({ timeoutSeconds, options }) =>
      stopWithText(
        `✅ Updated ACP timeout for ${target.sessionKey}: ${timeoutSeconds}s. Effective options: ${formatRuntimeOptionsText(options)}`,
      ),
  });
}

export async function handleAcpModelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(restTokens, ACP_MODEL_USAGE);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  return await withAcpCommandErrorBoundary({
    run: async () => {
      const model = validateRuntimeModelInput(parsed.value.value);
      const options = await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        key: "model",
        value: model,
      });
      return {
        model,
        options,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP model.",
    onSuccess: ({ model, options }) =>
      stopWithText(
        `✅ Updated ACP model for ${target.sessionKey}: ${model}. Effective options: ${formatRuntimeOptionsText(options)}`,
      ),
  });
}

export async function handleAcpResetOptionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseOptionalSingleTarget(restTokens, ACP_RESET_OPTIONS_USAGE);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().resetSessionRuntimeOptions({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not reset ACP runtime options.",
    onSuccess: () => stopWithText(`✅ Reset ACP runtime options for ${target.sessionKey}.`),
  });
}

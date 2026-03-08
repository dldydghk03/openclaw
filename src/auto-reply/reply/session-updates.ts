import crypto from "node:crypto";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { ensureSkillsWatcher, getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import {
  resolveTimezone,
  formatUtcTimestamp,
  formatZonedTimestamp,
} from "../../infra/format-time/format-datetime.ts";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { drainSystemEventEntries } from "../../infra/system-events.js";

function hasSkillSnapshotChanged(params: {
  current?: SessionEntry["skillsSnapshot"];
  next?: SessionEntry["skillsSnapshot"];
}): boolean {
  const current = params.current;
  const next = params.next;
  if (!current) {
    return Boolean(next);
  }
  if (!next) {
    return false;
  }
  if ((current.version ?? 0) !== (next.version ?? 0)) {
    return true;
  }
  const currentFilter = current.skillFilter ?? [];
  const nextFilter = next.skillFilter ?? [];
  if (currentFilter.length !== nextFilter.length) {
    return true;
  }
  for (let index = 0; index < currentFilter.length; index += 1) {
    if (currentFilter[index] !== nextFilter[index]) {
      return true;
    }
  }
  const currentSkills = current.skills.map((skill) => skill.name);
  const nextSkills = next.skills.map((skill) => skill.name);
  if (currentSkills.length !== nextSkills.length) {
    return true;
  }
  for (let index = 0; index < currentSkills.length; index += 1) {
    if (currentSkills[index] !== nextSkills[index]) {
      return true;
    }
  }
  const currentResolved = (current.resolvedSkills ?? []).map((skill) => skill.name);
  const nextResolved = (next.resolvedSkills ?? []).map((skill) => skill.name);
  if (currentResolved.length !== nextResolved.length) {
    return true;
  }
  for (let index = 0; index < currentResolved.length; index += 1) {
    if (currentResolved[index] !== nextResolved[index]) {
      return true;
    }
  }
  return false;
}

export async function prependSystemEvents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
  prefixedBodyBase: string;
}): Promise<string> {
  const compactSystemEvent = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    const lower = trimmed.toLowerCase();
    if (lower.includes("reason periodic")) {
      return null;
    }
    // Filter out the actual heartbeat prompt, but not cron jobs that mention "heartbeat"
    // The heartbeat prompt starts with "Read HEARTBEAT.md" - cron payloads won't match this
    if (lower.startsWith("read heartbeat.md")) {
      return null;
    }
    // Also filter heartbeat poll/wake noise
    if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
      return null;
    }
    if (trimmed.startsWith("Node:")) {
      return trimmed.replace(/ · last input [^·]+/i, "").trim();
    }
    return trimmed;
  };

  const resolveSystemEventTimezone = (cfg: OpenClawConfig) => {
    const raw = cfg.agents?.defaults?.envelopeTimezone?.trim();
    if (!raw) {
      return { mode: "local" as const };
    }
    const lowered = raw.toLowerCase();
    if (lowered === "utc" || lowered === "gmt") {
      return { mode: "utc" as const };
    }
    if (lowered === "local" || lowered === "host") {
      return { mode: "local" as const };
    }
    if (lowered === "user") {
      return {
        mode: "iana" as const,
        timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
      };
    }
    const explicit = resolveTimezone(raw);
    return explicit ? { mode: "iana" as const, timeZone: explicit } : { mode: "local" as const };
  };

  const formatSystemEventTimestamp = (ts: number, cfg: OpenClawConfig) => {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return "unknown-time";
    }
    const zone = resolveSystemEventTimezone(cfg);
    if (zone.mode === "utc") {
      return formatUtcTimestamp(date, { displaySeconds: true });
    }
    if (zone.mode === "local") {
      return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
    }
    return (
      formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ??
      "unknown-time"
    );
  };

  const systemLines: string[] = [];
  const queued = drainSystemEventEntries(params.sessionKey);
  systemLines.push(
    ...queued
      .map((event) => {
        const compacted = compactSystemEvent(event.text);
        if (!compacted) {
          return null;
        }
        return `[${formatSystemEventTimestamp(event.ts, params.cfg)}] ${compacted}`;
      })
      .filter((v): v is string => Boolean(v)),
  );
  if (params.isMainSession && params.isNewSession) {
    const summary = await buildChannelSummary(params.cfg);
    if (summary.length > 0) {
      systemLines.unshift(...summary);
    }
  }
  if (systemLines.length === 0) {
    return params.prefixedBodyBase;
  }

  const block = systemLines.map((l) => `System: ${l}`).join("\n");
  return `${block}\n\n${params.prefixedBodyBase}`;
}

export async function ensureSkillSnapshot(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  isFirstTurnInSession: boolean;
  workspaceDir: string;
  cfg: OpenClawConfig;
  /** If provided, only load skills with these names (for per-channel skill filtering) */
  skillFilter?: string[];
}): Promise<{
  sessionEntry?: SessionEntry;
  skillsSnapshot?: SessionEntry["skillsSnapshot"];
  systemSent: boolean;
}> {
  if (process.env.OPENCLAW_TEST_FAST === "1") {
    // In fast unit-test runs we skip filesystem scanning, watchers, and session-store writes.
    // Dedicated skills tests cover snapshot generation behavior.
    return {
      sessionEntry: params.sessionEntry,
      skillsSnapshot: params.sessionEntry?.skillsSnapshot,
      systemSent: params.sessionEntry?.systemSent ?? false,
    };
  }

  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter,
  } = params;

  let nextEntry = sessionEntry;
  let systemSent = sessionEntry?.systemSent ?? false;
  const remoteEligibility = getRemoteSkillEligibility();
  const snapshotVersion = getSkillsSnapshotVersion(workspaceDir);
  ensureSkillsWatcher({ workspaceDir, config: cfg });
  const shouldRefreshSnapshot =
    snapshotVersion > 0
      ? (nextEntry?.skillsSnapshot?.version ?? 0) < snapshotVersion
      : !isFirstTurnInSession;

  if (isFirstTurnInSession && sessionStore && sessionKey) {
    const current = nextEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      isFirstTurnInSession || !current.skillsSnapshot || shouldRefreshSnapshot
        ? buildWorkspaceSkillSnapshot(workspaceDir, {
            config: cfg,
            skillFilter,
            eligibility: { remote: remoteEligibility },
            snapshotVersion,
          })
        : current.skillsSnapshot;
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: skillSnapshot,
    };
    sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...nextEntry };
    if (storePath) {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = { ...store[sessionKey], ...nextEntry };
      });
    }
    systemSent = true;
  }

  const refreshedSkillsSnapshot = shouldRefreshSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfg,
        skillFilter,
        eligibility: { remote: remoteEligibility },
        snapshotVersion,
      })
    : undefined;
  const snapshotChanged = hasSkillSnapshotChanged({
    current: nextEntry?.skillsSnapshot,
    next: refreshedSkillsSnapshot,
  });
  const skillsSnapshot = refreshedSkillsSnapshot
    ? snapshotChanged
      ? refreshedSkillsSnapshot
      : (nextEntry?.skillsSnapshot ?? refreshedSkillsSnapshot)
    : (nextEntry?.skillsSnapshot ??
      (isFirstTurnInSession
        ? undefined
        : buildWorkspaceSkillSnapshot(workspaceDir, {
            config: cfg,
            skillFilter,
            eligibility: { remote: remoteEligibility },
            snapshotVersion,
          })));
  if (
    skillsSnapshot &&
    sessionStore &&
    sessionKey &&
    !isFirstTurnInSession &&
    (!nextEntry?.skillsSnapshot || snapshotChanged)
  ) {
    const current = nextEntry ?? {
      sessionId: sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...nextEntry };
    if (storePath) {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = { ...store[sessionKey], ...nextEntry };
      });
    }
  }

  return { sessionEntry: nextEntry, skillsSnapshot, systemSent };
}

export async function incrementCompactionCount(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  now?: number;
  /** Token count after compaction - if provided, updates session token counts */
  tokensAfter?: number;
}): Promise<number | undefined> {
  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    now = Date.now(),
    tokensAfter,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }
  const nextCount = (entry.compactionCount ?? 0) + 1;
  // Build update payload with compaction count and optionally updated token counts
  const updates: Partial<SessionEntry> = {
    compactionCount: nextCount,
    updatedAt: now,
  };
  // If tokensAfter is provided, update the cached token counts to reflect post-compaction state
  if (tokensAfter != null && tokensAfter > 0) {
    updates.totalTokens = tokensAfter;
    updates.totalTokensFresh = true;
    // Clear input/output breakdown since we only have the total estimate after compaction
    updates.inputTokens = undefined;
    updates.outputTokens = undefined;
    updates.cacheRead = undefined;
    updates.cacheWrite = undefined;
  }
  sessionStore[sessionKey] = {
    ...entry,
    ...updates,
  };
  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        ...store[sessionKey],
        ...updates,
      };
    });
  }
  return nextCount;
}

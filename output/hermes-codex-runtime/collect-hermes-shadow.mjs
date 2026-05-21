#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = new Map();
const flags = new Set();

for (const rawArg of process.argv.slice(2)) {
  if (rawArg.startsWith("--") && rawArg.includes("=")) {
    const [key, ...rest] = rawArg.slice(2).split("=");
    args.set(key, rest.join("="));
  } else if (rawArg.startsWith("--")) {
    flags.add(rawArg.slice(2));
  }
}

const stateDir = path.resolve(
  args.get("state-dir") || process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"),
);
const profile = args.get("profile") || "hermes-research";
const days = Number(args.get("days") || 7);
const apply = flags.has("apply");
const vaultRoot = path.resolve(
  args.get("vault-root") || process.env.HERMES_VAULT_ROOT || path.join(process.cwd(), "Vault"),
);
const outputDir = path.resolve(
  args.get("output-dir") || path.join(vaultRoot, "03_Master_Note", "50-Outputs", "Hermes-Shadow"),
);
const now = new Date();
const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
const sessionsDir = path.join(stateDir, "agents", profile, "sessions");
const jobsPath = path.join(stateDir, "cron", "jobs.json");

function toLocalDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseTextParts(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part?.text === "string") {
        return part.text;
      }
      if (typeof part?.thinking === "string") {
        return "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractCronName(text) {
  const match = text.match(/^\[cron:[^\]\s]+ ([^\]]+)\]/);
  return match?.[1] || "";
}

function classifyRun(prompt, assistantText) {
  const haystack = `${prompt}\n${assistantText}`.toLowerCase();
  if (haystack.includes("codex shadow")) {
    return "codex_shadow";
  }
  if (haystack.includes("heartbeat_ok")) {
    return "heartbeat";
  }
  if (haystack.includes("approval sweep")) {
    return "approval_sweep";
  }
  if (haystack.includes("distill")) {
    return "distill";
  }
  if (haystack.includes("backlog plan")) {
    return "planner";
  }
  if (haystack.includes("orchestrator_ready")) {
    return "readiness";
  }
  return "other";
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function parseSessionFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\n/).filter(Boolean);
  const stat = await fs.stat(filePath);
  const parsed = {
    session_id: path.basename(filePath, ".jsonl"),
    file: filePath,
    mtime: stat.mtime.toISOString(),
    bytes: stat.size,
    cwd: "",
    started_at: "",
    provider: "",
    model: "",
    cron_name: "",
    run_type: "other",
    user_prompt_excerpt: "",
    assistant_excerpt: "",
    assistant_status: "empty",
    usage: null,
  };

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "session") {
      parsed.started_at = event.timestamp || parsed.started_at;
      parsed.cwd = event.cwd || parsed.cwd;
    }

    if (event.type === "model_change") {
      parsed.provider = event.provider || parsed.provider;
      parsed.model = event.modelId || parsed.model;
    }

    if (event.type === "message" && event.message?.role === "user") {
      const prompt = parseTextParts(event.message.content);
      parsed.user_prompt_excerpt = prompt.slice(0, 800);
      parsed.cron_name = extractCronName(prompt);
    }

    if (event.type === "message" && event.message?.role === "assistant") {
      const text = parseTextParts(event.message.content);
      if (text) {
        parsed.assistant_excerpt = text.slice(0, 1600);
        parsed.assistant_status = text.includes("HEARTBEAT_OK") ? "heartbeat_ok" : "non_empty";
      }
      parsed.usage = event.message.usage || parsed.usage;
    }
  }

  parsed.run_type = classifyRun(parsed.user_prompt_excerpt, parsed.assistant_excerpt);
  return parsed;
}

function summarizeCron(jobsConfig) {
  const jobs = Array.isArray(jobsConfig?.jobs) ? jobsConfig.jobs : [];
  return jobs
    .filter((job) => {
      const name = String(job?.name || "");
      const agentId = String(job?.agentId || job?.agent || "");
      return agentId.includes("hermes") || name.includes("Hermes") || name.includes("Codex shadow");
    })
    .map((job) => ({
      id: job.id || "",
      name: job.name || "",
      enabled: Boolean(job.enabled),
      agent_id: job.agentId || job.agent || "",
      schedule: job.schedule || null,
      last_status: job.state?.lastStatus || job.lastStatus || "",
      consecutive_errors: job.state?.consecutiveErrors || job.consecutiveErrors || 0,
    }));
}

function makeMarkdown(report) {
  const lines = [
    `# Hermes Shadow Collector - ${report.generated_date}`,
    "",
    "## Summary",
    `- profile: ${report.profile}`,
    `- window: ${report.window.start} to ${report.window.end}`,
    `- sessions reviewed: ${report.source_sessions.length}`,
    `- codex shadow runs: ${report.signals.codex_shadow_runs}`,
    `- shadow days: ${report.signals.shadow_days}`,
    `- enabled cron error jobs: ${report.signals.cron_enabled_error_jobs}`,
    `- disabled stale error jobs: ${report.signals.cron_disabled_stale_error_jobs}`,
    `- ready for promotion: ${report.promotion_window.ready}`,
    `- external writes performed: ${report.external_writes_performed}`,
    "",
    "## Promotion Window",
    report.promotion_window.reason,
    "",
    "## Runs",
  ];

  for (const session of report.source_sessions) {
    lines.push(
      `- ${session.started_at || session.mtime} | ${session.run_type} | ${session.cron_name || "manual"} | ${session.assistant_status} | ${path.basename(session.file)}`,
    );
  }

  lines.push(
    "",
    "## Notes",
    "- This collector is read-only except for writing this report.",
    "- Promotion remains blocked until at least 7 calendar days of evidence are present.",
    "- Apple Calendar, finance ledger, file move/delete, migration, and external upload apply still require approval gates.",
  );

  return `${lines.join("\n")}\n`;
}

const sessionFiles = (await fs.readdir(sessionsDir).catch(() => []))
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => path.join(sessionsDir, name));

const sessions = [];
for (const filePath of sessionFiles) {
  const session = await parseSessionFile(filePath);
  const timestamp = new Date(session.started_at || session.mtime);
  if (Number.isNaN(timestamp.getTime()) || timestamp < windowStart || timestamp > now) {
    continue;
  }
  sessions.push(session);
}

sessions.sort((a, b) =>
  String(a.started_at || a.mtime).localeCompare(String(b.started_at || b.mtime)),
);

const codexShadowSessions = sessions.filter((session) => session.run_type === "codex_shadow");
const shadowDates = new Set(
  codexShadowSessions.map((session) =>
    toLocalDateKey(new Date(session.started_at || session.mtime)),
  ),
);
const cronSnapshot = summarizeCron(await readJsonIfExists(jobsPath));
const generatedDate = toLocalDateKey(now);
const runId = `hermes-shadow-collector-${generatedDate}-${crypto.randomUUID().slice(0, 8)}`;

const report = {
  run_id: runId,
  generated_at: now.toISOString(),
  generated_date: generatedDate,
  profile,
  window: {
    start: windowStart.toISOString(),
    end: now.toISOString(),
    days,
  },
  external_writes_performed: false,
  source_sessions: sessions,
  cron_snapshot: cronSnapshot,
  signals: {
    total_sessions: sessions.length,
    codex_shadow_runs: codexShadowSessions.length,
    shadow_days: shadowDates.size,
    heartbeat_ok_runs: sessions.filter((session) => session.assistant_status === "heartbeat_ok")
      .length,
    non_empty_runs: sessions.filter((session) => session.assistant_status === "non_empty").length,
    cron_enabled_hermes_jobs: cronSnapshot.filter((job) => job.enabled).length,
    cron_enabled_error_jobs: cronSnapshot.filter(
      (job) => job.enabled && Number(job.consecutive_errors) > 0,
    ).length,
    cron_disabled_stale_error_jobs: cronSnapshot.filter(
      (job) => !job.enabled && Number(job.consecutive_errors) > 0,
    ).length,
  },
  promotion_window: {
    ready: shadowDates.size >= 7 && codexShadowSessions.length >= 2,
    reason:
      shadowDates.size >= 7 && codexShadowSessions.length >= 2
        ? "At least 7 calendar days of Codex shadow evidence are present."
        : "Promotion is blocked until at least 7 calendar days of Codex shadow evidence are present.",
    shadow_dates: Array.from(shadowDates).toSorted(),
  },
};

const jsonPath = path.join(outputDir, `${generatedDate} hermes-shadow-collector.json`);
const mdPath = path.join(outputDir, `${generatedDate} hermes-shadow-collector.md`);

if (apply) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, makeMarkdown(report), "utf8");
}

process.stdout.write(
  `${JSON.stringify(
    {
      apply,
      jsonPath,
      mdPath,
      signals: report.signals,
      promotion_window: report.promotion_window,
    },
    null,
    2,
  )}\n`,
);

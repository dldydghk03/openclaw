#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const now = new Date();
const nowMs = now.getTime();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultJobsFile = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
const jobsFile = getArg("--jobs-file", defaultJobsFile);
const outputFile = getArg(
  "--output",
  path.join(repoRoot, "output/hermes-codex-runtime/openclaw-cron-freeze-plan.json"),
);

function getArg(flag, fallback = "") {
  const idx = argv.indexOf(flag);
  if (idx === -1) {
    return fallback;
  }
  return argv[idx + 1] || fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fieldText(job) {
  return [
    job.name,
    job.agentId,
    job.sessionTarget,
    job.wakeMode,
    job.payload?.text,
    job.payload?.message,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function isHermesShadow(job, text) {
  const agent = String(job.agentId || "").toLowerCase();
  return (agent.startsWith("hermes") || text.includes("hermes")) && text.includes("shadow");
}

function isSimpleReminder(text) {
  return (
    text.includes("reminder") ||
    text.includes("알림") ||
    text.includes("시간표") ||
    text.includes("복약") ||
    text.includes("수업")
  );
}

function freezeReason(job) {
  const text = fieldText(job);
  const agent = String(job.agentId || "").toLowerCase();
  if (!job.enabled) {
    return "";
  }
  if (isHermesShadow(job, text)) {
    return "";
  }
  if (agent === "study-orchestrator") {
    return "study orchestrator job";
  }
  if (isSimpleReminder(text) && !text.includes("agenda") && !text.includes("planner")) {
    return "";
  }

  const markers = [
    ["agenda", "agenda/planner job"],
    ["planner", "planner job"],
    ["backlog plan", "planner backlog job"],
    ["distill", "memory distill job"],
    ["study-orchestrator", "study orchestrator job"],
    ["orchestrator", "orchestrator job"],
    ["radar", "radar/planner job"],
    ["radar sweep", "radar/planner sweep"],
    ["approval sweep", "approval planner sweep"],
    ["quick qa", "planner qa job"],
    ["intake review", "intake review job"],
    ["report-only", "report-only planner job"],
  ];
  const hit = markers.find(([marker]) => text.includes(marker));
  return hit?.[1] || "";
}

const before = readJson(jobsFile);
const freeze = [];
const keep = [];
const alreadyDisabled = [];

for (const job of before.jobs || []) {
  const reason = freezeReason(job);
  const summary = {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    enabled: Boolean(job.enabled),
    reason,
    lastRunStatus: job.state?.lastRunStatus || "",
    consecutiveErrors: job.state?.consecutiveErrors || 0,
  };
  if (!job.enabled) {
    alreadyDisabled.push(summary);
  } else if (reason) {
    freeze.push(summary);
  } else {
    keep.push(summary);
  }
}

const plan = {
  generated_at: now.toISOString(),
  mode: apply ? "apply" : "dry-run",
  jobs_file: jobsFile,
  output_file: outputFile,
  freeze_count: freeze.length,
  keep_count: keep.length,
  already_disabled_count: alreadyDisabled.length,
  policy: {
    freeze: "enabled OpenClaw-native planner/orchestrator jobs",
    keep: "Hermes shadow jobs, simple reminders, bridge/runtime jobs",
    deletion: "never in this step",
  },
  freeze,
  keep,
  already_disabled: alreadyDisabled,
};

writeJson(outputFile, plan);

if (apply && freeze.length > 0) {
  const backupFile = path.join(
    repoRoot,
    "output/hermes-codex-runtime/backups",
    `openclaw-cron-jobs.${now.toISOString().replaceAll(/[:.]/g, "-")}.json`,
  );
  writeJson(backupFile, before);
  const freezeIds = new Set(freeze.map((job) => job.id));
  const after = {
    ...before,
    jobs: before.jobs.map((job) =>
      freezeIds.has(job.id)
        ? {
            ...job,
            enabled: false,
            updatedAtMs: nowMs,
          }
        : job,
    ),
  };
  writeJson(jobsFile, after);
  plan.backup_file = backupFile;
  writeJson(outputFile, plan);
}

console.log(JSON.stringify(plan, null, 2));

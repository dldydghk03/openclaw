#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const jobsPath = path.join(stateDir, "cron", "jobs.json");
const backupDir = path.join(process.cwd(), "output", "hermes-codex-runtime", "backups");
const planPath = path.join(
  process.cwd(),
  "output",
  "hermes-codex-runtime",
  apply
    ? "hermes-shadow-cron-hardening-apply-result.json"
    : "hermes-shadow-cron-hardening-plan.json",
);

function isStudyShadowJob(job) {
  const name = String(job?.name || "");
  const agentId = String(job?.agentId || job?.agent || "");
  return agentId === "hermes-research" && name.startsWith("Codex shadow ");
}

function normalizeState(state) {
  if (!state || typeof state !== "object") {
    return state || {};
  }
  const next = { ...state };
  const deliveryOnlyError = String(next.lastError || "").includes("cron announce delivery failed");

  if (deliveryOnlyError) {
    next.lastRunStatus = "ok";
    next.lastStatus = "ok";
    next.lastDeliveryStatus = "not-delivered";
    next.lastDelivered = false;
    next.consecutiveErrors = 0;
    delete next.lastError;
  }

  return next;
}

const raw = await fs.readFile(jobsPath, "utf8");
const parsed = JSON.parse(raw);

if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
  throw new Error(`Unexpected cron jobs format at ${jobsPath}`);
}

const changes = [];
const nextJobs = parsed.jobs.map((job) => {
  if (!isStudyShadowJob(job)) {
    return job;
  }

  const before = {
    name: job.name,
    enabled: job.enabled,
    delivery: job.delivery || null,
    state: job.state || {},
  };
  const after = {
    ...job,
    delivery: { mode: "none" },
    state: normalizeState(job.state),
  };

  changes.push({
    name: job.name,
    before,
    after: {
      name: after.name,
      enabled: after.enabled,
      delivery: after.delivery,
      state: after.state,
    },
  });

  return after;
});

const result = {
  generated_at: new Date().toISOString(),
  jobsPath,
  apply,
  target: "Codex shadow jobs for hermes-research",
  expected_changes: changes.map((change) => ({
    name: change.name,
    delivery_before: change.before.delivery,
    delivery_after: change.after.delivery,
    last_status_before: change.before.state?.lastStatus || "",
    last_status_after: change.after.state?.lastStatus || "",
    consecutive_errors_before: change.before.state?.consecutiveErrors || 0,
    consecutive_errors_after: change.after.state?.consecutiveErrors || 0,
  })),
  changed_count: changes.length,
  external_writes: ["OpenClaw cron jobs.json"],
  safety: {
    preview_file: planPath,
    approval_id: "operator-requested-shadow-stabilization",
    read_back_required: true,
    calendar_or_finance_write: false,
    file_move_or_delete: false,
  },
};

await fs.writeFile(planPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

if (apply) {
  const backupPath = path.join(
    backupDir,
    `openclaw-cron-jobs.before-shadow-hardening.${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(backupPath, `${raw.trimEnd()}\n`, "utf8");
  parsed.jobs = nextJobs;
  await fs.writeFile(jobsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  result.backupPath = backupPath;
  result.read_back = JSON.parse(await fs.readFile(jobsPath, "utf8"))
    .jobs.filter(isStudyShadowJob)
    .map((job) => ({
      name: job.name,
      enabled: job.enabled,
      delivery: job.delivery,
      lastStatus: job.state?.lastStatus || "",
      consecutiveErrors: job.state?.consecutiveErrors || 0,
    }));
  await fs.writeFile(planPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

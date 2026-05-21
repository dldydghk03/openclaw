#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const jobsPath = path.join(stateDir, "cron", "jobs.json");

const jobsToInstall = [
  {
    name: "Codex shadow Morning Study Brief",
    legacyNames: ["Hermes shadow Morning Study Brief"],
    description:
      "Shadow Dr.Hibbert's weekday morning planning loop with the Codex-backed orchestrator, report-only.",
    schedule: {
      kind: "cron",
      expr: "45 7 * * 1-5",
      tz: "Asia/Seoul",
      staggerMs: 300000,
    },
    payload: {
      kind: "agentTurn",
      thinking: "medium",
      message:
        "Run a Codex-backed shadow Morning Study Brief using ../workspaces/study-orchestrator/brain/reference/job-catalog.md as the contract. Read the exam schedule, timetable, reminders when available, and recent backlog signals. Return HEARTBEAT_OK if there is no meaningful pressure change. Otherwise return only: priorities, collisions, recommended Quick vs review vs Deep mix, and one short line prefixed SHADOW_NOTE describing any likely divergence from Dr.Hibbert. Report-only. Do not write files, do not message the study Telegram account, and do not mutate schedules.",
    },
  },
  {
    name: "Codex shadow Post-Lecture Intake Review",
    legacyNames: ["Hermes shadow Post-Lecture Intake Review"],
    description:
      "Shadow study intake triage after lecture hours with the Codex-backed orchestrator, report-only.",
    schedule: {
      kind: "cron",
      expr: "30 18 * * 1-5",
      tz: "Asia/Seoul",
      staggerMs: 0,
    },
    payload: {
      kind: "agentTurn",
      thinking: "medium",
      message:
        "Run a Codex-backed shadow Post-Lecture Intake Review using ../workspaces/study-orchestrator/brain/reference/job-catalog.md as the contract. Inspect ../workspaces/study-orchestrator/brain/01_Inbox, ../workspaces/study-orchestrator/brain/.staging, and recent intake warnings. Return HEARTBEAT_OK if nothing new is blocked. Otherwise return only: new material summary, blocked intake items, whether Quick preparation is ready or blocked, and one short line prefixed SHADOW_NOTE if the Codex-backed orchestrator would prioritize differently from Dr.Hibbert. Report-only. Do not write files or message the study Telegram account.",
    },
  },
  {
    name: "Codex shadow Weekly Study Reset",
    legacyNames: ["Hermes shadow Weekly Study Reset"],
    description:
      "Shadow the weekly study reset on Sunday evening with the Codex-backed orchestrator, report-only.",
    schedule: {
      kind: "cron",
      expr: "0 20 * * 0",
      tz: "Asia/Seoul",
      staggerMs: 0,
    },
    payload: {
      kind: "agentTurn",
      thinking: "medium",
      message:
        "Run a Codex-backed shadow Weekly Study Reset using ../workspaces/study-orchestrator/brain/reference/job-catalog.md as the contract. Rebalance the next week using the exam schedule, timetable, reminders, subject priority, backlog, and recent QA signals. Return HEARTBEAT_OK if no plan change is needed. Otherwise return only: next week focus, overloaded days, subjects to compress or expand, and one short line prefixed SHADOW_NOTE describing any likely divergence from Dr.Hibbert. Report-only. Do not write files, do not launch long jobs, and do not message the study Telegram account.",
    },
  },
];

const raw = await fs.readFile(jobsPath, "utf8");
const parsed = JSON.parse(raw);

if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
  throw new Error(`Unexpected cron jobs format at ${jobsPath}`);
}

const namesToRemove = new Set(jobsToInstall.flatMap((job) => [job.name, ...job.legacyNames]));

const filteredJobs = parsed.jobs.filter((job) => !namesToRemove.has(job?.name));

const newJobs = jobsToInstall.map((job) => ({
  id: crypto.randomUUID(),
  agentId: "hermes-research",
  name: job.name,
  description: job.description,
  enabled: true,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  schedule: job.schedule,
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: job.payload,
  delivery: { mode: "none" },
  state: {},
}));

parsed.jobs = [...filteredJobs, ...newJobs];

await fs.writeFile(jobsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

const summary = {
  jobsPath,
  added: newJobs.map((job) => ({
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    schedule: job.schedule,
  })),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

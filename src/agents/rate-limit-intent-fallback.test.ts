import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  resolveRateLimitIntentFallback,
  resolveRateLimitIntentFallbackPayload,
} from "./rate-limit-intent-fallback.js";

const ORIGINAL_DRY_RUN = process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN;
const ORIGINAL_FINANCE_WRITE = process.env.OPENCLAW_INTENT_FINANCE_WRITE;

afterEach(() => {
  if (ORIGINAL_DRY_RUN === undefined) {
    delete process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN;
  } else {
    process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN = ORIGINAL_DRY_RUN;
  }
  if (ORIGINAL_FINANCE_WRITE === undefined) {
    delete process.env.OPENCLAW_INTENT_FINANCE_WRITE;
  } else {
    process.env.OPENCLAW_INTENT_FINANCE_WRITE = ORIGINAL_FINANCE_WRITE;
  }
});

describe("resolveRateLimitIntentFallbackPayload", () => {
  it("returns screenshot dry-run payload for screenshot intent", () => {
    process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN = "1";
    const payload = resolveRateLimitIntentFallbackPayload({
      workspaceDir: "/tmp",
      rawText: "지금 화면 캡처해서 텔레그램으로 보내줘",
    });

    expect(payload?.text).toContain("테스트 모드");
    expect(payload?.mediaUrl).toBeUndefined();
  });

  it("keeps legacy text fallback wrapper compatible", () => {
    process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN = "1";
    const text = resolveRateLimitIntentFallback({
      workspaceDir: "/tmp",
      rawText: "네이버 열어줘",
    });
    expect(text).toContain("네이버");
  });

  it("returns null for unrelated text", () => {
    process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN = "1";
    const payload = resolveRateLimitIntentFallbackPayload({
      workspaceDir: "/tmp",
      rawText: "안녕",
    });
    expect(payload).toBeNull();
  });

  it("does not write finance fallback by default", () => {
    process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN = "1";
    delete process.env.OPENCLAW_INTENT_FINANCE_WRITE;
    const payload = resolveRateLimitIntentFallbackPayload({
      workspaceDir: "/tmp",
      rawText: "점심 8500원 썼어",
    });
    expect(payload).toBeNull();
  });

  it("appends execution policy summary when router policy probe is available", () => {
    process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN = "1";
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-intent-fallback-"));
    try {
      const scriptsDir = path.join(workspaceDir, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      const scriptPath = path.join(scriptsDir, "assistant-intent-router.mjs");
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({",
          "  ok: true,",
          '  route: "site_open",',
          "  execution_policy: {",
          '    route: "site_open",',
          '    mode: "locked_script",',
          '    primary_executor: "browser-open-smart",',
          "    blocked_skill_fallback: true",
          "  }",
          "}));",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const payload = resolveRateLimitIntentFallbackPayload({
        workspaceDir,
        rawText: "네이버 열어줘",
      });

      expect(payload?.text).toContain("execution_policy:");
      expect(payload?.text).toContain("route=site_open");
      expect(payload?.text).toContain("mode=locked_script");
      expect(payload?.text).toContain("executor=browser-open-smart");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("metadata-aware youtube query normalization", () => {
  it("strips leading fenced untrusted metadata before extracting query", () => {
    const text = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "timestamp": "Wed 2026-03-04 15:19 PST" }',
      "```",
      "",
      "유튜브로 키키의 404 틀어줘",
    ].join("\n");

    expect(__testing.normalizeIncomingRawText(text)).toBe("유튜브로 키키의 404 틀어줘");
    expect(__testing.extractYoutubeQuery(text)).toBe("키키의 404");
  });

  it("strips inline untrusted metadata payload before extracting query", () => {
    const text =
      'Conversation info (untrusted metadata): json { "timestamp": "Wed 2026-03-04 15:19 PST", "nested": { "a": 1 } } 유튜브로 키키의 404 틀어줘';
    expect(__testing.normalizeIncomingRawText(text)).toBe("유튜브로 키키의 404 틀어줘");
    expect(__testing.extractYoutubeQuery(text)).toBe("키키의 404");
  });
});

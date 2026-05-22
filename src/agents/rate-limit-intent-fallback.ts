import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripLeadingInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

type JsonLike = Record<string, unknown>;

const recentOpenedUrlAt = new Map<string, number>();
const recentScreenshotAt = new Map<string, { ts: number; path: string }>();

export type IntentFallbackPayload = {
  text: string;
  mediaUrl?: string;
};

type ScriptRunResult = {
  ok: boolean;
  json?: JsonLike;
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut?: boolean;
  workspaceDirUsed?: string;
  scriptPath?: string;
};

const OPEN_INTENT_WORDS = /(열어|접속|켜|띄워)/i;
const OPEN_INTENT_BLOCK_WORDS =
  /(멈춰|일시정지|재생|틀어|노래|음악|플레이리스트|추천|검색|찾아|광고|건너뛰|스킵)/i;
const YOUTUBE_CONTEXT_WORDS =
  /(유튜브|youtube|플레이리스트|재즈|로파이|클래식|피아노|팝|노래|음악|브금|곡명)/i;
const YOUTUBE_ACTION_WORDS =
  /(열어|재생|틀어|켜|멈춰|일시정지|중지|추천|찾아|검색|광고|건너뛰|스킵|다른\s*노래)/i;
const YOUTUBE_CONTROL_HINT_WORDS = /(광고|건너뛰|스킵|멈춰|일시정지|중지|pause|stop|skip\s*ad)/i;
const FINANCE_AMOUNT_WORDS = /(-?\d[\d,]*)\s*원/;
const FINANCE_CONTEXT_WORDS =
  /(수입|입금|월급|용돈|환급|정산|받았|들어왔|지출|썼|사용|결제|샀|구매|지불|소비|가계부|식비|교통|카페|점심|저녁|아침)/i;
const SCREENSHOT_KEYWORDS =
  /(스크린\s*샷|스크린샷|화면\s*캡처|화면\s*캡쳐|캡처|캡쳐|screenshot|screen\s*shot|capture\s*screen)/i;
const SCREENSHOT_CONTEXT_WORDS = /(화면|모니터|데스크탑|desktop|screen)/i;
const SCREENSHOT_ACTION_WORDS = /(캡처|캡쳐|찍|보여|전송|보내|공유|screenshot|capture|send|share)/i;
const SCREENSHOT_FULL_SCREEN_WORDS =
  /(전체\s*화면|전체\s*모니터|full\s*screen|whole\s*screen|all\s*screens?)/i;
const INBOUND_METADATA_INLINE_HEADERS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

export function isRateLimitErrorText(text: string): boolean {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("quota") ||
    lower.includes("429") ||
    lower.includes("모델 호출 한도") ||
    lower.includes("호출 한도") ||
    lower.includes("요청 한도")
  );
}

function extractJsonObject(text: string): JsonLike | undefined {
  const raw = String(text || "").trim();
  if (!raw) {
    return undefined;
  }
  const start = raw.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  for (let i = raw.length - 1; i > start; i -= 1) {
    if (raw[i] !== "}") {
      continue;
    }
    const candidate = raw.slice(start, i + 1).trim();
    try {
      const parsed = JSON.parse(candidate) as JsonLike;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function parseJsonLoose(text: string): JsonLike | undefined {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as JsonLike;
  } catch {
    return extractJsonObject(trimmed);
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function resolveScriptLocation(params: { workspaceDir: string; scriptName: string }): {
  scriptPath?: string;
  workspaceDirUsed?: string;
} {
  const home = os.homedir();
  const cwd = process.cwd();
  const workspaceCandidates = dedupe([
    params.workspaceDir,
    path.join(params.workspaceDir, "Vault"),
    cwd,
    path.join(cwd, "Vault"),
    path.join(home, "OpenClaw", "Vault"),
    path.join(home, ".openclaw", "workspace"),
  ]);

  for (const candidate of workspaceCandidates) {
    const scriptPath = path.join(candidate, "scripts", params.scriptName);
    if (fs.existsSync(scriptPath)) {
      return {
        scriptPath,
        workspaceDirUsed: candidate,
      };
    }
  }

  return {};
}

function resolveOpenClawBinCandidates(): string[] {
  const home = os.homedir();
  const envBin = String(process.env.OPENCLAW_BIN || "").trim();
  const candidates = dedupe([
    envBin,
    path.join(home, "Library", "pnpm", "openclaw"),
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
    "openclaw",
  ]);
  return candidates;
}

function resolveOpenCooldownMs(): number {
  const raw = Number.parseInt(String(process.env.OPENCLAW_INTENT_OPEN_COOLDOWN_MS || ""), 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 30_000;
  }
  return raw;
}

function resolveScreenshotCooldownMs(): number {
  const raw = Number.parseInt(String(process.env.OPENCLAW_INTENT_SCREENSHOT_COOLDOWN_MS || ""), 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 5_000;
  }
  return raw;
}

function resolveScriptTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.OPENCLAW_INTENT_SCRIPT_TIMEOUT_MS || ""), 10);
  if (!Number.isFinite(raw) || raw < 1_000) {
    return 12_000;
  }
  return raw;
}

function resolveYoutubeScriptTimeoutMs(): number {
  const raw = Number.parseInt(
    String(process.env.OPENCLAW_INTENT_YOUTUBE_SCRIPT_TIMEOUT_MS || ""),
    10,
  );
  if (!Number.isFinite(raw) || raw < 5_000) {
    return 45_000;
  }
  return raw;
}

function resolveScreenshotTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.OPENCLAW_INTENT_SCREENSHOT_TIMEOUT_MS || ""), 10);
  if (!Number.isFinite(raw) || raw < 2_000) {
    return 15_000;
  }
  return raw;
}

function isIntentDryRunEnabled(): boolean {
  return String(process.env.OPENCLAW_INTENT_FALLBACK_DRY_RUN || "").trim() === "1";
}

function isFinanceFallbackWriteEnabled(): boolean {
  return String(process.env.OPENCLAW_INTENT_FINANCE_WRITE || "").trim() === "1";
}

function markUrlOpened(url: string): void {
  recentOpenedUrlAt.set(url, Date.now());
}

function wasUrlOpenedRecently(url: string): boolean {
  const cooldownMs = resolveOpenCooldownMs();
  if (cooldownMs <= 0) {
    return false;
  }
  const lastOpenedAt = recentOpenedUrlAt.get(url);
  if (!lastOpenedAt) {
    return false;
  }
  return Date.now() - lastOpenedAt < cooldownMs;
}

function runSystemUrlOpen(url: string): boolean {
  if (!url) {
    return false;
  }
  if (isIntentDryRunEnabled()) {
    markUrlOpened(url);
    return true;
  }
  if (wasUrlOpenedRecently(url)) {
    return true;
  }
  const platform = process.platform;
  if (platform === "darwin") {
    const res = spawnSync("open", [url], { encoding: "utf8" });
    if (res.status === 0) {
      markUrlOpened(url);
      return true;
    }
    return false;
  }
  if (platform === "win32") {
    const res = spawnSync("cmd", ["/c", "start", "", url], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status === 0) {
      markUrlOpened(url);
      return true;
    }
    return false;
  }
  const res = spawnSync("xdg-open", [url], { encoding: "utf8" });
  if (res.status === 0) {
    markUrlOpened(url);
    return true;
  }
  return false;
}

function runNodeJson(params: {
  workspaceDir: string;
  scriptName: string;
  args: string[];
  timeoutMs?: number;
}): ScriptRunResult {
  const location = resolveScriptLocation({
    workspaceDir: params.workspaceDir,
    scriptName: params.scriptName,
  });
  if (!location.scriptPath || !location.workspaceDirUsed) {
    return {
      ok: false,
      stdout: "",
      stderr: `missing script: ${params.scriptName}`,
      status: 1,
    };
  }
  const scriptPath = location.scriptPath;
  const workspaceDirUsed = location.workspaceDirUsed;

  const openclawBinCandidates = resolveOpenClawBinCandidates();
  const selectedOpenClawBin = openclawBinCandidates[0] || "openclaw";
  const openclawBinDirs = openclawBinCandidates
    .filter((candidate) => candidate.includes("/"))
    .map((candidate) => path.dirname(candidate));
  const mergedPath = dedupe([
    ...(process.env.PATH || "").split(":"),
    ...openclawBinDirs,
    path.join(os.homedir(), "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]).join(":");
  const timeoutMs = params.timeoutMs ?? resolveScriptTimeoutMs();

  const runScriptOnce = (openclawBin: string) =>
    spawnSync(process.execPath, [scriptPath, ...params.args], {
      cwd: workspaceDirUsed,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        PATH: mergedPath,
        OPENCLAW_BIN: openclawBin,
      },
    });

  const isTimeout = (error: unknown): boolean => {
    if (!error || typeof error !== "object") {
      return false;
    }
    const maybeError = error as { code?: string; message?: string };
    return (
      maybeError.code === "ETIMEDOUT" || String(maybeError.message || "").includes("ETIMEDOUT")
    );
  };

  let result = runScriptOnce(selectedOpenClawBin);
  let timedOut = isTimeout(result.error);

  // If script failed and OPENCLAW_BIN points to an unavailable absolute path,
  // retry once with plain command name so script-side fallback can resolve PATH.
  if (result.status !== 0 && selectedOpenClawBin.includes("/") && !timedOut) {
    result = runScriptOnce("openclaw");
    timedOut = isTimeout(result.error);
  }

  const stdout = (result.stdout || "").trim();
  const timeoutMessage = timedOut ? `script timeout after ${timeoutMs}ms` : "";
  const stderr = [String(result.stderr || "").trim(), timeoutMessage].filter(Boolean).join("\n");
  const json = parseJsonLoose(stdout) ?? parseJsonLoose(stderr);

  return {
    ok: result.status === 0,
    json,
    stdout,
    stderr,
    status: result.status,
    timedOut,
    workspaceDirUsed: location.workspaceDirUsed,
    scriptPath,
  };
}

function resolveOpenSiteIntent(rawText: string): { siteLabel: string; url: string } | null {
  const text = String(rawText || "").trim();
  if (!text || !OPEN_INTENT_WORDS.test(text) || OPEN_INTENT_BLOCK_WORDS.test(text)) {
    return null;
  }
  if (/(유튜브|youtube)/i.test(text)) {
    return { siteLabel: "유튜브", url: "https://www.youtube.com/" };
  }
  if (/(네이버|naver)/i.test(text)) {
    return { siteLabel: "네이버", url: "https://www.naver.com/" };
  }
  if (/(구글|google)/i.test(text)) {
    return { siteLabel: "구글", url: "https://www.google.com/" };
  }
  return null;
}

function isLikelyYoutubeIntent(rawText: string): boolean {
  const text = String(rawText || "");
  if (YOUTUBE_CONTROL_HINT_WORDS.test(text)) {
    return true;
  }
  const hasYoutube = /(유튜브|youtube)/i.test(text);
  const hasContext = YOUTUBE_CONTEXT_WORDS.test(text);
  const hasAction = YOUTUBE_ACTION_WORDS.test(text);
  return (hasYoutube && hasAction) || (hasAction && hasContext);
}

function isLikelyFinanceIntent(rawText: string): boolean {
  const text = String(rawText || "");
  if (isLikelyYoutubeIntent(text)) {
    return false;
  }
  return FINANCE_AMOUNT_WORDS.test(text) && FINANCE_CONTEXT_WORDS.test(text);
}

function isLikelyScreenshotIntent(rawText: string): boolean {
  const text = String(rawText || "");
  if (SCREENSHOT_KEYWORDS.test(text)) {
    return true;
  }
  return SCREENSHOT_CONTEXT_WORDS.test(text) && SCREENSHOT_ACTION_WORDS.test(text);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findJsonObjectEnd(text: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (ch === "\\") {
        isEscaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return i;
    }
    if (depth < 0) {
      return -1;
    }
  }

  return -1;
}

function stripInlineInboundMetadataPrefix(rawText: string): string {
  let text = String(rawText || "");
  if (!text) {
    return text;
  }

  for (let iteration = 0; iteration < INBOUND_METADATA_INLINE_HEADERS.length; iteration += 1) {
    let stripped = false;
    for (const header of INBOUND_METADATA_INLINE_HEADERS) {
      const prefix = new RegExp(`^\\s*${escapeRegExpLiteral(header)}\\s*(?:json\\s*)?`, "i");
      const match = text.match(prefix);
      if (!match) {
        continue;
      }
      let cursor = match[0].length;
      while (cursor < text.length && /\s/.test(text[cursor] || "")) {
        cursor += 1;
      }
      if (text.slice(cursor, cursor + 7).toLowerCase() === "```json") {
        cursor += 7;
        while (cursor < text.length && /\s/.test(text[cursor] || "")) {
          cursor += 1;
        }
      }
      if (text[cursor] !== "{") {
        continue;
      }
      const jsonEnd = findJsonObjectEnd(text, cursor);
      if (jsonEnd < 0) {
        continue;
      }
      cursor = jsonEnd + 1;
      while (cursor < text.length && /\s/.test(text[cursor] || "")) {
        cursor += 1;
      }
      if (text.slice(cursor, cursor + 3) === "```") {
        cursor += 3;
      }
      text = text.slice(cursor).trimStart();
      stripped = true;
      break;
    }
    if (!stripped) {
      break;
    }
  }

  return text;
}

function normalizeIncomingRawText(rawText: string): string {
  let normalized = String(rawText || "");
  normalized = stripLeadingInboundMetadata(normalized);
  normalized = stripInlineInboundMetadataPrefix(normalized);
  normalized = normalized.replace(/\r/g, " ").replace(/\n+/g, " ").trim();
  normalized = normalized.replace(/^\[[^\]]{3,120}\]\s*/, "");
  normalized = normalized.replace(/^\.?\s*,?\s*\[[^\]]{3,120}\]\s*/, "");
  normalized = normalized.replace(/^\.?\s*,?\s*/, "");
  return normalized.trim();
}

function cleanupOldIntentScreenshots(dirPath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith("intent-screenshot-") || !entry.name.endsWith(".png")) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > 24 * 60 * 60 * 1_000) {
        fs.rmSync(fullPath, { force: true });
      }
    } catch {
      continue;
    }
  }
}

function detectCapturePermissionError(stderr: string): boolean {
  const text = String(stderr || "").toLowerCase();
  return (
    text.includes("not authorized") ||
    text.includes("not permitted") ||
    text.includes("permission denied") ||
    text.includes("screen recording") ||
    text.includes("screen_capture_permission_denied")
  );
}

function detectAccessibilityPermissionError(stderr: string): boolean {
  const text = String(stderr || "").toLowerCase();
  return (
    text.includes("assistive access") ||
    text.includes("accessibility") ||
    text.includes("not authorized to send apple events") ||
    text.includes("system events got an error")
  );
}

function buildCaptureFailureText(stderr: string): string {
  if (detectCapturePermissionError(stderr)) {
    return "화면 캡처 권한이 없어 실패했습니다. macOS 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹음에서 OpenClaw(또는 실행 앱) 권한을 허용한 뒤 다시 요청해 주세요.";
  }
  if (detectAccessibilityPermissionError(stderr)) {
    return "활성 창 캡처 권한이 없어 실패했습니다. macOS 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 OpenClaw(또는 실행 앱) 권한을 허용한 뒤 다시 요청해 주세요.";
  }
  return "화면 캡처에 실패했습니다. 잠시 후 다시 요청해 주세요.";
}

function resolveIntentScreenshotDir(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "intent-screenshots");
}

function resolveRecentScreenshot(rawText: string): string | undefined {
  const cooldownMs = resolveScreenshotCooldownMs();
  if (cooldownMs <= 0) {
    return undefined;
  }
  const cached = recentScreenshotAt.get(rawText);
  if (!cached) {
    return undefined;
  }
  if (Date.now() - cached.ts > cooldownMs) {
    return undefined;
  }
  if (!fs.existsSync(cached.path)) {
    return undefined;
  }
  return cached.path;
}

function shouldPreferFullScreenCapture(rawText: string): boolean {
  return SCREENSHOT_FULL_SCREEN_WORDS.test(rawText);
}

type ScreenshotCaptureResult = {
  ok: boolean;
  stderr: string;
  mode: "window" | "screen";
};

type MacSwiftCapturePayload = {
  ok?: boolean;
  mode?: "window" | "screen";
  warning?: string;
  error?: string;
};

const MAC_CAPTURE_SCREEN_SWIFT = [
  "import AppKit",
  "import CoreGraphics",
  "import ImageIO",
  "import UniformTypeIdentifiers",
  "import Foundation",
  "",
  "func arg(_ flag: String, _ fallback: String) -> String {",
  "    let args = CommandLine.arguments",
  "    if let idx = args.firstIndex(of: flag), idx + 1 < args.count {",
  "        return args[idx + 1]",
  "    }",
  "    return fallback",
  "}",
  "",
  'let outputPath = arg("--out", "")',
  'let requestedMode = arg("--mode", "window")',
  "if outputPath.isEmpty {",
  '    let err: [String: Any] = ["ok": false, "error": "missing_out"]',
  "    if let data = try? JSONSerialization.data(withJSONObject: err), let text = String(data: data, encoding: .utf8) {",
  '        fputs(text + "\\n", stderr)',
  "    }",
  "    exit(1)",
  "}",
  "",
  "if !CGPreflightScreenCaptureAccess() {",
  "    _ = CGRequestScreenCaptureAccess()",
  "    if !CGPreflightScreenCaptureAccess() {",
  '        let err: [String: Any] = ["ok": false, "error": "screen_capture_permission_denied"]',
  "        if let data = try? JSONSerialization.data(withJSONObject: err), let text = String(data: data, encoding: .utf8) {",
  '            fputs(text + "\\n", stderr)',
  "        }",
  "        exit(5)",
  "    }",
  "}",
  "",
  "let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)",
  "let windows = (info as NSArray?) as? [NSDictionary] ?? []",
  "let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0",
  "",
  "func ownerName(_ w: NSDictionary) -> String {",
  '    return (w[kCGWindowOwnerName] as? String) ?? ""',
  "}",
  "",
  "func isUsableTopWindow(_ w: NSDictionary) -> Bool {",
  "    let layer = w[kCGWindowLayer] as? Int ?? -1",
  "    if layer != 0 { return false }",
  "    let owner = ownerName(w)",
  '    if owner == "Window Server" || owner == "Dock" { return false }',
  "    return true",
  "}",
  "",
  "func windowRect(_ w: NSDictionary) -> CGRect? {",
  "    guard let bounds = w[kCGWindowBounds] as? NSDictionary else { return nil }",
  '    guard let x = bounds["X"] as? CGFloat,',
  '          let y = bounds["Y"] as? CGFloat,',
  '          let width = bounds["Width"] as? CGFloat,',
  '          let height = bounds["Height"] as? CGFloat else { return nil }',
  "    if width <= 1 || height <= 1 { return nil }",
  "    return CGRect(x: x, y: y, width: width, height: height)",
  "}",
  "",
  "var targetWindow: NSDictionary? = nil",
  "for w in windows {",
  "    let ownerPid = w[kCGWindowOwnerPID] as? Int32 ?? -1",
  "    if ownerPid == frontPid && isUsableTopWindow(w) {",
  "        targetWindow = w",
  "        break",
  "    }",
  "}",
  "if targetWindow == nil {",
  "    for w in windows where isUsableTopWindow(w) {",
  "        targetWindow = w",
  "        break",
  "    }",
  "}",
  "",
  "var displayCount: UInt32 = 0",
  "CGGetActiveDisplayList(0, nil, &displayCount)",
  "var displays = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))",
  "CGGetActiveDisplayList(displayCount, &displays, &displayCount)",
  "",
  "func pickDisplay(for rect: CGRect?) -> CGDirectDisplayID {",
  "    if let r = rect {",
  "        for displayId in displays {",
  "            if CGDisplayBounds(displayId).intersects(r) {",
  "                return displayId",
  "            }",
  "        }",
  "    }",
  "    return CGMainDisplayID()",
  "}",
  "",
  "let selectedWindowRect = targetWindow.flatMap(windowRect)",
  "let selectedDisplay = pickDisplay(for: selectedWindowRect)",
  "let displayBounds = CGDisplayBounds(selectedDisplay)",
  "",
  "guard let displayImage = CGDisplayCreateImage(selectedDisplay) else {",
  '    let err: [String: Any] = ["ok": false, "error": "display_capture_failed"]',
  "    if let data = try? JSONSerialization.data(withJSONObject: err), let text = String(data: data, encoding: .utf8) {",
  '        fputs(text + "\\n", stderr)',
  "    }",
  "    exit(2)",
  "}",
  "",
  "let outputImage: CGImage",
  'var actualMode = "screen"',
  "var warning: String? = nil",
  "",
  'if requestedMode == "window", let r = selectedWindowRect {',
  "    let sx = CGFloat(displayImage.width) / displayBounds.width",
  "    let sy = CGFloat(displayImage.height) / displayBounds.height",
  "    let cx = max(0, Int((r.minX - displayBounds.minX) * sx))",
  "    let cyTop = max(0, Int((r.minY - displayBounds.minY) * sy))",
  "    let cw = max(1, Int(r.width * sx))",
  "    let ch = max(1, Int(r.height * sy))",
  "    let cy = max(0, Int(CGFloat(displayImage.height) - CGFloat(cyTop + ch)))",
  "    let cropRect = CGRect(",
  "        x: cx,",
  "        y: cy,",
  "        width: min(cw, max(1, displayImage.width - cx)),",
  "        height: min(ch, max(1, displayImage.height - cy))",
  "    )",
  "    if let cropped = displayImage.cropping(to: cropRect) {",
  "        outputImage = cropped",
  '        actualMode = "window"',
  "    } else {",
  "        outputImage = displayImage",
  '        warning = "window_crop_failed_fallback_to_screen"',
  "    }",
  "} else {",
  "    outputImage = displayImage",
  '    if requestedMode == "window" {',
  '        warning = "window_not_found_fallback_to_screen"',
  "    }",
  "}",
  "",
  "let outUrl = URL(fileURLWithPath: outputPath)",
  "guard let dest = CGImageDestinationCreateWithURL(outUrl as CFURL, UTType.png.identifier as CFString, 1, nil) else {",
  '    let err: [String: Any] = ["ok": false, "error": "destination_create_failed"]',
  "    if let data = try? JSONSerialization.data(withJSONObject: err), let text = String(data: data, encoding: .utf8) {",
  '        fputs(text + "\\n", stderr)',
  "    }",
  "    exit(3)",
  "}",
  "CGImageDestinationAddImage(dest, outputImage, nil)",
  "if !CGImageDestinationFinalize(dest) {",
  '    let err: [String: Any] = ["ok": false, "error": "write_failed"]',
  "    if let data = try? JSONSerialization.data(withJSONObject: err), let text = String(data: data, encoding: .utf8) {",
  '        fputs(text + "\\n", stderr)',
  "    }",
  "    exit(4)",
  "}",
  "",
  "var result: [String: Any] = [",
  '    "ok": true,',
  '    "mode": actualMode,',
  '    "width": outputImage.width,',
  '    "height": outputImage.height,',
  "]",
  'if let w = warning { result["warning"] = w }',
  "if let data = try? JSONSerialization.data(withJSONObject: result), let text = String(data: data, encoding: .utf8) {",
  "    print(text)",
  "}",
].join("\n");

function resolveMacCaptureScriptPath(): string | undefined {
  const scriptDir = path.join(resolvePreferredOpenClawTmpDir(), "intent-screenshots");
  try {
    fs.mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  const scriptPath = path.join(scriptDir, "mac-capture-screen.swift");
  try {
    const current = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
    if (current !== MAC_CAPTURE_SCREEN_SWIFT) {
      fs.writeFileSync(scriptPath, MAC_CAPTURE_SCREEN_SWIFT, { mode: 0o600 });
    }
    return scriptPath;
  } catch {
    return undefined;
  }
}

function runMacSwiftCapture(params: {
  outputPath: string;
  timeout: number;
  mode: "window" | "screen";
}): ScreenshotCaptureResult {
  const scriptPath = resolveMacCaptureScriptPath();
  if (!scriptPath) {
    return {
      ok: false,
      stderr: "swift capture script unavailable",
      mode: "screen",
    };
  }
  const res = spawnSync("swift", [scriptPath, "--out", params.outputPath, "--mode", params.mode], {
    encoding: "utf8",
    timeout: params.timeout,
    killSignal: "SIGKILL",
  });
  const stdout = String(res.stdout || "").trim();
  const stderr = String(res.stderr || "").trim();
  const payload =
    (parseJsonLoose(stdout) as MacSwiftCapturePayload | undefined) ??
    (parseJsonLoose(stderr) as MacSwiftCapturePayload | undefined);
  const mode = payload?.mode === "window" ? "window" : "screen";
  const ok = res.status === 0 && Boolean(payload?.ok) && fs.existsSync(params.outputPath);
  if (ok) {
    const warning = String(payload?.warning || "").trim();
    return {
      ok: true,
      stderr: warning,
      mode,
    };
  }
  const errorText = String(payload?.error || "").trim();
  return {
    ok: false,
    stderr: [stderr, errorText, stdout && res.status !== 0 ? `swift stdout: ${stdout}` : ""]
      .filter(Boolean)
      .join("\n"),
    mode,
  };
}

function runMacWindowCapture(outputPath: string, timeout: number): ScreenshotCaptureResult {
  return runMacSwiftCapture({
    outputPath,
    timeout,
    mode: "window",
  });
}

function runMacScreenCapture(outputPath: string, timeout: number): ScreenshotCaptureResult {
  const swiftCapture = runMacSwiftCapture({
    outputPath,
    timeout,
    mode: "screen",
  });
  if (swiftCapture.ok) {
    return {
      ok: true,
      stderr: swiftCapture.stderr,
      mode: "screen",
    };
  }
  if (detectCapturePermissionError(swiftCapture.stderr)) {
    return {
      ok: false,
      stderr: swiftCapture.stderr,
      mode: "screen",
    };
  }

  const fallback = spawnSync("screencapture", ["-x", "-t", "png", outputPath], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  const errors = [swiftCapture.stderr, String(fallback.stderr || "").trim()].filter(Boolean);
  const candidates: Array<{ path: string; size: number }> = [];
  try {
    const stat = fs.statSync(outputPath);
    if (stat.isFile() && stat.size > 100) {
      candidates.push({ path: outputPath, size: stat.size });
    }
  } catch {
    // Ignore fallback file stat failures and keep probing display targets.
  }

  // Probe per-display captures and pick the richest image (usually the monitor
  // with active windows). This helps when the default capture targets a mostly empty display.
  for (let display = 1; display <= 8; display += 1) {
    const candidatePath = `${outputPath}.d${display}.png`;
    const res = spawnSync(
      "screencapture",
      ["-x", "-D", String(display), "-t", "png", candidatePath],
      {
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
      },
    );
    if (res.status !== 0) {
      const stderr = String(res.stderr || "").trim();
      if (stderr) {
        errors.push(stderr);
      }
      fs.rmSync(candidatePath, { force: true });
      continue;
    }
    try {
      const stat = fs.statSync(candidatePath);
      if (stat.isFile() && stat.size > 100) {
        candidates.push({ path: candidatePath, size: stat.size });
      } else {
        fs.rmSync(candidatePath, { force: true });
      }
    } catch {
      fs.rmSync(candidatePath, { force: true });
    }
  }

  if (candidates.length === 0) {
    return {
      ok: fallback.status === 0,
      stderr: errors.join("\n"),
      mode: "screen",
    };
  }

  const best = candidates.reduce((prev, current) => (current.size > prev.size ? current : prev));
  if (best.path !== outputPath) {
    try {
      fs.copyFileSync(best.path, outputPath);
    } catch (error) {
      return {
        ok: false,
        stderr: [errors.join("\n"), String(error)].filter(Boolean).join("\n"),
        mode: "screen",
      };
    }
  }

  for (const candidate of candidates) {
    if (candidate.path === outputPath) {
      continue;
    }
    fs.rmSync(candidate.path, { force: true });
  }

  return {
    ok: true,
    stderr: errors.join("\n"),
    mode: "screen",
  };
}

function runScreenshotCapture(rawText: string, outputPath: string): ScreenshotCaptureResult {
  const timeout = resolveScreenshotTimeoutMs();
  const platform = process.platform;

  if (platform === "darwin") {
    const preferFullScreen = shouldPreferFullScreenCapture(rawText);
    if (!preferFullScreen) {
      const windowCapture = runMacWindowCapture(outputPath, timeout);
      if (windowCapture.ok) {
        return windowCapture;
      }
      const fullScreenCapture = runMacScreenCapture(outputPath, timeout);
      if (fullScreenCapture.ok) {
        return fullScreenCapture;
      }
      return {
        ok: false,
        stderr: [windowCapture.stderr, fullScreenCapture.stderr].filter(Boolean).join("\n"),
        mode: "screen",
      };
    }
    const fullScreenCapture = runMacScreenCapture(outputPath, timeout);
    if (fullScreenCapture.ok) {
      return fullScreenCapture;
    }
    const windowCapture = runMacWindowCapture(outputPath, timeout);
    if (windowCapture.ok) {
      return windowCapture;
    }
    return {
      ok: false,
      stderr: [fullScreenCapture.stderr, windowCapture.stderr].filter(Boolean).join("\n"),
      mode: "screen",
    };
  }

  if (platform === "win32") {
    const psScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
      `$bmp.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "$g.Dispose()",
      "$bmp.Dispose()",
    ].join(";");
    const res = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    return {
      ok: res.status === 0,
      stderr: String(res.stderr || ""),
      mode: "screen",
    };
  }

  // Linux/Unix fallback chain.
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: "grim", args: [outputPath] },
    { cmd: "gnome-screenshot", args: ["-f", outputPath] },
    { cmd: "import", args: ["-window", "root", outputPath] },
    { cmd: "scrot", args: [outputPath] },
  ];
  for (const candidate of candidates) {
    const res = spawnSync(candidate.cmd, candidate.args, {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    if (res.status === 0) {
      return {
        ok: true,
        stderr: String(res.stderr || ""),
        mode: "screen",
      };
    }
  }
  return {
    ok: false,
    stderr: "no screenshot backend available",
    mode: "screen",
  };
}

function captureScreenshotIntent(rawText: string): IntentFallbackPayload {
  const cachedPath = resolveRecentScreenshot(rawText);
  if (cachedPath) {
    return {
      text: "최근에 캡처한 화면을 다시 전송합니다.",
      mediaUrl: cachedPath,
    };
  }

  if (isIntentDryRunEnabled()) {
    return {
      text: "화면 캡처 요청을 테스트 모드로 시뮬레이션했습니다. 실제 캡처/전송은 생략했습니다.",
    };
  }

  const screenshotDir = resolveIntentScreenshotDir();
  try {
    fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
  } catch {
    return {
      text: "화면 캡처를 위한 임시 폴더를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    };
  }
  cleanupOldIntentScreenshots(screenshotDir);
  const stamp = Date.now();
  const filePath = path.join(screenshotDir, `intent-screenshot-${stamp}.png`);
  const capture = runScreenshotCapture(rawText, filePath);
  if (!capture.ok) {
    return {
      text: buildCaptureFailureText(capture.stderr),
    };
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 100) {
      return {
        text: "화면 캡처 파일이 비어 있어 전송하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      };
    }
  } catch {
    return {
      text: "화면 캡처 파일을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    };
  }
  recentScreenshotAt.set(rawText, {
    ts: stamp,
    path: filePath,
  });
  const text =
    capture.mode === "window"
      ? "현재 활성 창을 캡처했습니다. 전체 화면이 필요하면 '전체 화면 캡처'라고 요청해 주세요."
      : "현재 화면을 캡처했습니다.";
  return {
    text,
    mediaUrl: filePath,
  };
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toObject(value: unknown): JsonLike | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonLike;
}

function formatExecutionPolicySummary(params: {
  policy?: JsonLike;
  fallbackRoute?: string;
}): string | null {
  const route = toText(params.policy?.route) || params.fallbackRoute || "";
  const mode = toText(params.policy?.mode);
  const executor = toText(params.policy?.primary_executor);
  const blockedSkillFallback = params.policy?.blocked_skill_fallback === true;
  if (!route && !mode && !executor) {
    return null;
  }
  const segments = [
    `route=${route || "unmatched"}`,
    `mode=${mode || "skill_first"}`,
    `executor=${executor || "general_agent"}`,
  ];
  if (blockedSkillFallback) {
    segments.push("skill_fallback=blocked");
  }
  return segments.join(", ");
}

function resolveExecutionPolicySummary(params: {
  workspaceDir: string;
  rawText: string;
}): string | undefined {
  // TODO(intent-router): route mode-switch utterances to ACP commands.
  // - "코덱스 모드로 전환" -> /acp on
  // - "일반 모드로 돌아가" -> /acp off
  // - "현재 모드 보여줘" -> /acp status
  const routeProbe = runNodeJson({
    workspaceDir: params.workspaceDir,
    scriptName: "assistant-intent-router.mjs",
    args: ["--text", params.rawText, "--plan-only"],
  });
  const json = routeProbe.json;
  if (!json) {
    return undefined;
  }
  const route = toText(json.route);
  const policy = toObject(json.execution_policy);
  const summary = formatExecutionPolicySummary({
    policy,
    fallbackRoute: route,
  });
  return summary ?? undefined;
}

function appendExecutionPolicySummary(text: string, policySummary: string | undefined): string {
  const base = String(text || "").trim();
  if (!base) {
    return base;
  }
  const summary = String(policySummary || "").trim();
  if (!summary) {
    return base;
  }
  if (/execution_policy\s*:/i.test(base)) {
    return base;
  }
  return `${base}\nexecution_policy: ${summary}`;
}

function summarizeBrowserOpen(params: {
  siteLabel: string;
  siteUrl: string;
  openResult: ScriptRunResult;
}): string | null {
  const json = params.openResult.json;
  if (!params.openResult.ok || !json) {
    const opened = runSystemUrlOpen(params.siteUrl);
    if (!opened) {
      return null;
    }
    return `${params.siteLabel}를 열었습니다. 시스템 브라우저로 바로 실행했습니다.\n링크: ${params.siteUrl}`;
  }
  const profile = toText(json.profile) || "openclaw";
  const opened = toObject(json.opened);
  const openedUrl = toText(opened?.url);
  const fallbackUsed = Boolean(json.fallbackUsed);
  const profileSummary = fallbackUsed
    ? "Chrome 연결 탭이 없어 openclaw 관리 브라우저로 열었습니다."
    : profile === "chrome"
      ? "연결된 Chrome 탭에서 열었습니다."
      : `${profile} 프로필에서 열었습니다.`;
  if (openedUrl) {
    markUrlOpened(openedUrl);
  }

  return `${params.siteLabel}를 열었습니다. ${profileSummary}${openedUrl ? `\n링크: ${openedUrl}` : ""}`;
}

function summarizeYoutubeRoute(routeResult: ScriptRunResult): string | null {
  const json = routeResult.json;
  if (!routeResult.ok || !json) {
    return null;
  }
  const route = toText(json.route) || "unknown";
  const result = toObject(json.result) ?? {};

  if (route === "control") {
    const selectedTab = toObject(result.selectedTab);
    const directResult = toObject(result.result);
    const url = toText(selectedTab?.url) || toText(directResult?.url);
    const paused = directResult?.paused;
    const pausedSummary =
      typeof paused === "boolean"
        ? paused
          ? "일시정지 상태입니다."
          : "재생 상태입니다."
        : "재생 상태를 확인했습니다.";
    return `유튜브 제어를 실행했습니다. ${pausedSummary}${url ? `\n대상: ${url}` : ""}`;
  }

  return summarizeYoutubeMusicResult(result);
}

function summarizeYoutubeMusicResult(result: JsonLike): string {
  const normalizedQuery = toText(result.normalized_query);
  const playback = toObject(result.playback);
  const playbackRaw = toObject(playback?.raw);
  const playbackResult = toObject(playbackRaw?.result);
  const playbackOk = Boolean(playback?.ok) || Boolean(playbackRaw?.ok);
  const target = toObject(result.target);
  const open = toObject(result.open);
  const openOpened = toObject(open?.opened);
  const targetUrl = toText(playbackResult?.url) || toText(openOpened?.url) || toText(target?.url);
  const base = `유튜브 재생 요청을 실행했습니다.${normalizedQuery ? `\n쿼리: ${normalizedQuery}` : ""}\n재생: ${
    playbackOk ? "성공" : "시도 완료(상태 확인 필요)"
  }${targetUrl ? `\n대상: ${targetUrl}` : ""}`;

  const recommendations = Array.isArray(result.recommendations)
    ? result.recommendations.slice(0, 3).map((entry, index) => {
        const rec = toObject(entry);
        const title = toText(rec?.title) || `추천 ${index + 1}`;
        const url = toText(rec?.url);
        return url ? `${index + 1}. ${title}: ${url}` : `${index + 1}. ${title}`;
      })
    : [];

  if (recommendations.length === 0) {
    return base;
  }
  return `${base}\n추천:\n${recommendations.join("\n")}`;
}

function summarizeYoutubeMusicAssistantResult(result: ScriptRunResult): string | null {
  const json = result.json;
  if (!result.ok || !json) {
    return null;
  }
  return summarizeYoutubeMusicResult(json);
}

function resolveYoutubeWatchUrlFromSearch(query: string): string | null {
  const nodeScript = [
    "const query = String(process.argv[1] || '').trim();",
    "if (!query) { process.exit(1); }",
    "(async () => {",
    "  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;",
    "  const controller = new AbortController();",
    "  const timer = setTimeout(() => controller.abort(), 8000);",
    "  try {",
    "    const res = await fetch(searchUrl, {",
    "      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },",
    "      signal: controller.signal,",
    "    });",
    "    if (!res.ok) { throw new Error(`search_fetch_failed_${res.status}`); }",
    "    const html = await res.text();",
    "    const pairPatterns = [",
    '      /\\"playlistId\\":\\"([A-Za-z0-9_-]{10,})\\"[\\s\\S]{0,240}?\\"videoId\\":\\"([A-Za-z0-9_-]{11})\\"/,',
    '      /\\"videoId\\":\\"([A-Za-z0-9_-]{11})\\"[\\s\\S]{0,240}?\\"playlistId\\":\\"([A-Za-z0-9_-]{10,})\\"/,',
    "    ];",
    "    for (const pattern of pairPatterns) {",
    "      const match = html.match(pattern);",
    "      if (!match) { continue; }",
    "      const first = match[1] || '';",
    "      const second = match[2] || '';",
    "      const firstLooksPlaylist = first.length >= 10 && first.length !== 11;",
    "      const playlistId = firstLooksPlaylist ? first : second;",
    "      const videoId = firstLooksPlaylist ? second : first;",
    "      if (videoId && playlistId) {",
    "        console.log(JSON.stringify({ ok: true, watchUrl: `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}` }));",
    "        return;",
    "      }",
    "    }",
    '    const videoMatch = html.match(/\\"videoId\\":\\"([A-Za-z0-9_-]{11})\\"/);',
    "    if (videoMatch && videoMatch[1]) {",
    "      console.log(JSON.stringify({ ok: true, watchUrl: `https://www.youtube.com/watch?v=${videoMatch[1]}` }));",
    "      return;",
    "    }",
    "    console.log(JSON.stringify({ ok: false, error: 'no_video_id' }));",
    "  } finally {",
    "    clearTimeout(timer);",
    "  }",
    "})().catch((error) => {",
    "  console.error(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));",
    "  process.exit(1);",
    "});",
  ].join("\n");

  const res = spawnSync(process.execPath, ["-e", nodeScript, query], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const json =
    parseJsonLoose(String(res.stdout || "").trim()) ??
    parseJsonLoose(String(res.stderr || "").trim());
  const watchUrl = toText(json?.watchUrl);
  if (!watchUrl) {
    return null;
  }
  return watchUrl;
}

function summarizeYoutubeForcedPlaybackFallback(params: {
  workspaceDir: string;
  query: string;
  rawText: string;
}): string | null {
  const watchUrl = resolveYoutubeWatchUrlFromSearch(params.query);
  if (!watchUrl) {
    return null;
  }
  const openResult = runNodeJson({
    workspaceDir: params.workspaceDir,
    scriptName: "browser-open-smart.mjs",
    timeoutMs: resolveYoutubeScriptTimeoutMs(),
    args: [
      "--url",
      watchUrl,
      "--prefer-profile",
      "chrome",
      "--fallback-profile",
      "openclaw",
      "--title",
      params.rawText,
    ],
  });
  if (!openResult.ok) {
    const opened = runSystemUrlOpen(watchUrl);
    if (!opened) {
      return null;
    }
    return `유튜브 재생 링크를 열어 자동 재생을 시도했습니다.\n쿼리: ${params.query}\n링크: ${watchUrl}`;
  }

  const openJson = openResult.json;
  const profile = toText(openJson?.profile) || "openclaw";
  const openedInfo = toObject(openJson?.opened);
  const openedUrl = toText(openedInfo?.url) || watchUrl;
  const targetId = toText(openedInfo?.targetId);
  const playArgs = [
    "--profile",
    profile,
    "--fallback-profile",
    "openclaw",
    "--action",
    "play",
    "--no-music-reroute",
    "--title",
    params.query,
  ];
  if (targetId) {
    playArgs.push("--target-id", targetId);
  }
  const playResult = runNodeJson({
    workspaceDir: params.workspaceDir,
    scriptName: "youtube-control.mjs",
    timeoutMs: resolveYoutubeScriptTimeoutMs(),
    args: playArgs,
  });
  const playJson = playResult.json;
  const selectedTab = toObject(playJson?.selectedTab);
  const resultInfo = toObject(playJson?.result);
  const targetUrl = toText(resultInfo?.url) || toText(selectedTab?.url) || openedUrl;
  const playbackOk = playResult.ok && Boolean(playJson?.ok);
  return `유튜브 재생을 강제 실행했습니다.\n쿼리: ${params.query}\n재생: ${
    playbackOk ? "성공" : "시도 완료(상태 확인 필요)"
  }\n대상: ${targetUrl}`;
}

function extractYoutubeQuery(rawText: string): string {
  const original = normalizeIncomingRawText(rawText);
  const genreDefaults: Array<{ pattern: RegExp; query: string }> = [
    { pattern: /재즈|jazz/i, query: "재즈 플레이리스트" },
    { pattern: /로파이|lofi/i, query: "로파이 플레이리스트" },
    { pattern: /클래식|classical/i, query: "클래식 플레이리스트" },
    { pattern: /피아노|piano/i, query: "피아노 연주곡 플레이리스트" },
    { pattern: /팝|pop/i, query: "인기 팝 플레이리스트" },
  ];
  for (const genre of genreDefaults) {
    if (genre.pattern.test(original)) {
      return genre.query;
    }
  }

  const cleaned = original
    .replace(/유튜브|youtube/gi, " ")
    .replace(/찾아서|검색해서|추천해서/gi, " ")
    .replace(/광고.*(건너뛰|스킵|넘겨)/gi, " ")
    .replace(/(멈춰|일시정지|중지|pause|stop)/gi, " ")
    .replace(/(틀어|재생|켜|찾아|검색|추천|플레이리스트|노래|음악|영상|비디오|곡명|play)/gi, " ")
    .replace(/(해줘|해주세요|줘|부탁해|가능해|할 수 있어|해줄래|지금|현재|다른)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stopwords = new Set([
    "에",
    "에서",
    "로",
    "으로",
    "를",
    "을",
    "의",
    "한",
    "번",
    "좀",
    "지금",
    "현재",
    "서",
  ]);
  const tokens = cleaned
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token && !stopwords.has(token));
  const joined = tokens.join(" ").trim();
  return joined || "인기 음악 플레이리스트";
}

function summarizeYoutubeRouteFallback(params: {
  workspaceDir: string;
  rawText: string;
}): string | null {
  const rawText = params.rawText;
  if (/(멈춰|일시정지|중지|광고.*(건너뛰|스킵|넘겨))/i.test(rawText)) {
    return "유튜브 제어 요청을 처리하려 했지만 브라우저 제어 세션이 준비되지 않았습니다. OpenClaw Browser Relay를 켠 뒤 다시 요청해 주세요.";
  }

  const assistantResult = runNodeJson({
    workspaceDir: params.workspaceDir,
    scriptName: "youtube-music-assistant.mjs",
    timeoutMs: resolveYoutubeScriptTimeoutMs(),
    args: ["--text", rawText, "--prefer-profile", "chrome", "--fallback-profile", "openclaw"],
  });
  const assistantSummary = summarizeYoutubeMusicAssistantResult(assistantResult);
  if (assistantSummary) {
    return assistantSummary;
  }

  const query = extractYoutubeQuery(rawText);
  const forcedSummary = summarizeYoutubeForcedPlaybackFallback({
    workspaceDir: params.workspaceDir,
    query,
    rawText,
  });
  if (forcedSummary) {
    return forcedSummary;
  }

  const watchUrl = resolveYoutubeWatchUrlFromSearch(query);
  if (watchUrl) {
    const openedWatch = runSystemUrlOpen(watchUrl);
    if (openedWatch) {
      return `유튜브 재생 링크를 열어 자동 재생을 시도했습니다.\n쿼리: ${query}\n링크: ${watchUrl}`;
    }
  }

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const opened = runSystemUrlOpen(searchUrl);
  if (!opened) {
    return null;
  }
  return `유튜브 검색 결과를 열었습니다.\n쿼리: ${query}\n링크: ${searchUrl}`;
}

function isYoutubeControlIntent(rawText: string): boolean {
  return /(멈춰|일시정지|중지|pause|stop|광고.*(건너뛰|스킵|넘겨)|skip\s*ad|재개|resume|다시\s*(재생|틀어)|이어\s*(서)?\s*(재생|틀어))/i.test(
    rawText,
  );
}

function summarizeFinance(result: ScriptRunResult): string | null {
  const json = result.json;
  if (!result.ok || !json) {
    return null;
  }
  const entry = toText(json.entry);
  const summary = toText(json.summary);
  const file = toText(json.file);
  const lines = ["가계부에 기록했습니다."];
  if (entry) {
    lines.push(`항목: ${entry}`);
  }
  if (summary) {
    lines.push(`요약: ${summary}`);
  }
  if (file) {
    lines.push(`파일: ${file}`);
  }
  return lines.join("\n");
}

export function resolveRateLimitIntentFallbackPayload(params: {
  workspaceDir: string;
  rawText: string;
}): IntentFallbackPayload | null {
  const workspaceDir = String(params.workspaceDir || "").trim();
  const rawText = normalizeIncomingRawText(String(params.rawText || ""));
  if (!workspaceDir || !rawText) {
    return null;
  }
  let cachedPolicySummary: string | undefined;
  const withExecutionPolicy = (text: string): string => {
    if (cachedPolicySummary === undefined) {
      cachedPolicySummary = resolveExecutionPolicySummary({
        workspaceDir,
        rawText,
      });
    }
    return appendExecutionPolicySummary(text, cachedPolicySummary);
  };

  if (isLikelyScreenshotIntent(rawText)) {
    const payload = captureScreenshotIntent(rawText);
    return {
      ...payload,
      text: withExecutionPolicy(payload.text),
    };
  }

  const openIntent = resolveOpenSiteIntent(rawText);
  if (openIntent) {
    if (isIntentDryRunEnabled()) {
      return {
        text: withExecutionPolicy(
          `${openIntent.siteLabel}를 열었습니다. 테스트 모드로 실제 브라우저 실행은 생략했습니다.\n링크: ${openIntent.url}`,
        ),
      };
    }
    if (wasUrlOpenedRecently(openIntent.url)) {
      return {
        text: withExecutionPolicy(
          `${openIntent.siteLabel}를 열었습니다. 최근에 같은 주소를 이미 열어 새 탭 생성은 생략했습니다.\n링크: ${openIntent.url}`,
        ),
      };
    }
    const openResult = runNodeJson({
      workspaceDir,
      scriptName: "browser-open-smart.mjs",
      args: [
        "--url",
        openIntent.url,
        "--prefer-profile",
        "chrome",
        "--fallback-profile",
        "openclaw",
        "--title",
        rawText,
      ],
    });
    const summary = summarizeBrowserOpen({
      siteLabel: openIntent.siteLabel,
      siteUrl: openIntent.url,
      openResult,
    });
    return summary ? { text: withExecutionPolicy(summary) } : null;
  }

  if (isLikelyYoutubeIntent(rawText)) {
    if (isIntentDryRunEnabled()) {
      return {
        text: withExecutionPolicy(
          isYoutubeControlIntent(rawText)
            ? "유튜브 제어 요청을 테스트 모드로 시뮬레이션했습니다. 실제 클릭/제어는 생략했습니다."
            : "유튜브 재생 요청을 테스트 모드로 시뮬레이션했습니다. 실제 재생/탐색은 생략했습니다.",
        ),
      };
    }
    const routed = runNodeJson({
      workspaceDir,
      scriptName: "youtube-intent-router.mjs",
      timeoutMs: resolveYoutubeScriptTimeoutMs(),
      args: ["--text", rawText, "--prefer-profile", "chrome", "--fallback-profile", "openclaw"],
    });
    const summary =
      summarizeYoutubeRoute(routed) ??
      summarizeYoutubeRouteFallback({
        workspaceDir,
        rawText,
      });
    return summary ? { text: withExecutionPolicy(summary) } : null;
  }

  if (isLikelyFinanceIntent(rawText)) {
    // Finance writes are disabled by default here because this fallback path can
    // be reached in eager/duplicate execution contexts. Use dedicated router flow.
    if (!isFinanceFallbackWriteEnabled()) {
      return null;
    }
    const finance = runNodeJson({
      workspaceDir,
      scriptName: "finance-ledger.mjs",
      args: [
        "add",
        "--text",
        rawText,
        "--at",
        new Date().toISOString(),
        "--source",
        "telegram",
        "--source-id",
        `ratelimit-fallback:${Date.now().toString(36)}`,
        "--json",
      ],
    });
    const summary = summarizeFinance(finance);
    return summary ? { text: withExecutionPolicy(summary) } : null;
  }

  return null;
}

export function resolveRateLimitIntentFallback(params: {
  workspaceDir: string;
  rawText: string;
}): string | null {
  return resolveRateLimitIntentFallbackPayload(params)?.text ?? null;
}

export const __testing = {
  normalizeIncomingRawText,
  extractYoutubeQuery,
};

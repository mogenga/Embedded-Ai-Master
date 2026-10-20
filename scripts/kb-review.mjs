#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INBOX_MODULE = path.join(ROOT, "dist-mcp", "kb", "inbox.js");
const GATE_MODULE = path.join(ROOT, "dist-mcp", "kb", "regression-gate.js");
const YAML_MODULE = path.join(ROOT, "dist-mcp", "kb", "yaml.js");
const REGRESSION_SCRIPT = path.join(ROOT, "scripts", "kb-regression.mjs");
const BASELINE_PATH = path.join(ROOT, "mcp-servers", "kb", "tests", "regression-baseline.json");
const DEFAULT_KB_ROOT = path.join(ROOT, "mcp-servers", "kb", "kb");
const INBOX_FILE = "_inbox.md";

function fail(message, code = 1) {
  console.error(`kb review: ${message}`);
  process.exitCode = code;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function kbRoot() {
  const configured = process.env.KB_ROOT?.trim();
  return path.resolve(ROOT, configured === undefined || configured === "" ? DEFAULT_KB_ROOT : configured);
}

function statSignature(file) {
  const info = statSync(file);
  return `${info.mtimeMs}:${info.size}`;
}

function requireModules() {
  for (const [label, file] of [
    ["inbox", INBOX_MODULE],
    ["regression-gate", GATE_MODULE],
    ["yaml", YAML_MODULE],
  ]) {
    if (!existsSync(file)) {
      fail(`未找到构建产物 ${label}（${file}）；请先运行 npm run build:mcp`, 2);
      return false;
    }
  }
  if (!existsSync(BASELINE_PATH)) {
    fail(`未找到回归基线 ${BASELINE_PATH}`, 2);
    return false;
  }
  return true;
}

function parseArgs(argv) {
  const options = {};
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      mode = "list";
      continue;
    }
    if (arg === "--accept" || arg === "--reject") {
      mode = arg.slice(2);
      options.id = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--target" || arg === "--note" || arg === "--reason") {
      const key = arg.slice(2);
      options[key] = argv[index + 1];
      index += 1;
      continue;
    }
    fail(`未知参数 ${arg}`, 2);
    return undefined;
  }
  if (mode === undefined) {
    fail("用法: --list | --accept <id> --target <path> [--note ...] | --reject <id> --reason ...", 2);
    return undefined;
  }
  return { mode, ...options };
}

function readProposals(inboxModule, file) {
  return inboxModule.parseInbox(readFileSync(file, "utf8"));
}

function summarize(content) {
  const line = content.split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function validateTarget(root, target) {
  if (typeof target !== "string" || target.trim() === "") {
    fail("--target 必须是非空路径", 2);
    return undefined;
  }
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`--target 必须位于 KB 根内: ${target}`, 2);
    return undefined;
  }
  if (!absolute.endsWith(".md")) {
    fail(`--target 必须是 .md 文件: ${target}`, 2);
    return undefined;
  }
  if (!existsSync(absolute)) {
    fail(`--target 不存在: ${target}`, 2);
    return undefined;
  }
  const base = path.basename(absolute);
  if (base === "_inbox.md" || base === "_reviewed.md") {
    fail(`--target 不能是审核文件: ${target}`, 2);
    return undefined;
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

function runRegression(root) {
  if (!existsSync(REGRESSION_SCRIPT)) {
    fail(`未找到回归脚本 ${REGRESSION_SCRIPT}`, 2);
    return undefined;
  }
  const result = spawnSync(process.execPath, [REGRESSION_SCRIPT, "--json"], {
    cwd: ROOT,
    env: { ...process.env, KB_ROOT: root },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    fail(`回归脚本启动失败: ${errorMessage(result.error)}`, 2);
    return undefined;
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || `退出码 ${result.status}`;
    fail(`回归脚本失败: ${detail}`, 2);
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`回归报告不是合法 JSON: ${errorMessage(error)}`, 2);
    return undefined;
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === undefined) return;
  if (!requireModules()) return;

  const inboxModule = await import(pathToFileURL(INBOX_MODULE).href);
  const gateModule = await import(pathToFileURL(GATE_MODULE).href);
  const yamlModule = await import(pathToFileURL(YAML_MODULE).href);
  const root = kbRoot();
  const inboxFile = path.join(root, INBOX_FILE);

  if (!existsSync(root)) {
    fail(`KB 根不存在: ${root}`, 2);
    return;
  }
  if (!existsSync(inboxFile)) {
    fail(`inbox 不存在: ${inboxFile}`, 2);
    return;
  }

  const proposals = readProposals(inboxModule, inboxFile);

  if (parsed.mode === "list") {
    if (proposals.length === 0) {
      console.log("inbox 为空");
      return;
    }
    for (const proposal of proposals) {
      console.log(
        [
          proposal.id,
          proposal.date,
          proposal.kind,
          proposal.domain,
          proposal.source.replace(/\t/g, " "),
          summarize(proposal.content),
        ].join("\t"),
      );
    }
    return;
  }

  if (typeof parsed.id !== "string" || parsed.id.trim() === "") {
    fail("--accept/--reject 需要提案 id", 2);
    return;
  }
  const proposal = proposals.find((candidate) => candidate.id === parsed.id);
  if (proposal === undefined) {
    fail(`未找到提案 ${parsed.id}`, 1);
    return;
  }

  if (parsed.mode === "reject") {
    if (typeof parsed.reason !== "string" || parsed.reason.trim() === "") {
      fail("--reject 需要 --reason", 2);
      return;
    }
    const before = statSignature(inboxFile);
    const removed = inboxModule.removeProposal(root, parsed.id);
    if (removed === undefined) {
      fail(`移除提案失败: ${parsed.id}`, 1);
      return;
    }
    if (statSignature(inboxFile) === before) {
      // removeProposal 已重写文件；此分支只用于提示实现异常，不改变退出码。
      console.error("kb review: inbox 未发生预期变化");
    }
    const reviewedPath = (() => {
      try {
        return inboxModule.appendReviewed(root, {
          id: parsed.id,
          status: "rejected",
          reviewedAt: new Date().toISOString(),
          reason: parsed.reason.trim(),
        });
      } catch (error) {
        inboxModule.appendProposal(root, removed);
        fail(`写入审核记录失败，已回滚 inbox: ${errorMessage(error)}`, 2);
        return undefined;
      }
    })();
    if (reviewedPath === undefined) return;
    console.log(JSON.stringify({ id: parsed.id, status: "rejected", reviewedPath }));
    return;
  }

  if (parsed.mode !== "accept") {
    fail(`未知模式 ${parsed.mode}`, 2);
    return;
  }

  const target = validateTarget(root, parsed.target);
  if (target === undefined) return;

  const before = statSignature(inboxFile);
  const report = runRegression(root);
  if (report === undefined) return;
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const gate = gateModule.compareRegression(report, baseline);
  if (!gate.ok) {
    console.error("kb review: 回归低于基线，拒绝接受提案");
    for (const failure of gate.failures) {
      const expected = failure.expected === undefined ? "-" : failure.expected;
      const actual = failure.actual === undefined ? "-" : failure.actual;
      console.error(`- ${failure.metric}: expected >= ${expected}, actual ${actual}`);
    }
    process.exitCode = 1;
    return;
  }
  if (statSignature(inboxFile) !== before) {
    fail("inbox 在审核期间发生变化，请重试", 1);
    return;
  }

  const removed = inboxModule.removeProposal(root, parsed.id);
  if (removed === undefined) {
    fail(`移除提案失败: ${parsed.id}`, 1);
    return;
  }
  const reviewedPath = (() => {
    try {
      return inboxModule.appendReviewed(root, {
        id: parsed.id,
        status: "accepted",
        reviewedAt: new Date().toISOString(),
        target: target.relative,
        ...(typeof parsed.note === "string" && parsed.note.trim() !== ""
          ? { reason: parsed.note.trim() }
          : {}),
      });
    } catch (error) {
      inboxModule.appendProposal(root, removed);
      fail(`写入审核记录失败，已回滚 inbox: ${errorMessage(error)}`, 2);
      return undefined;
    }
  })();
  if (reviewedPath === undefined) return;

  try {
    const indexed = yamlModule
      .parseIndexYaml(readFileSync(path.join(root, "index.yaml"), "utf8"))
      .some((entry) => entry.path === target.relative);
    if (!indexed) {
      console.error(`kb review: warning: ${target.relative} 不在 index.yaml 中`);
    }
  } catch (error) {
    console.error(`kb review: warning: 无法校验 index.yaml: ${errorMessage(error)}`);
  }

  console.log(
    JSON.stringify({
      id: parsed.id,
      status: "accepted",
      target: target.relative,
      reviewedPath,
      regression: "ok",
    }),
  );
}

await main();
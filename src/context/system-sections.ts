import { createHash } from "node:crypto";

/**
 * 系统提示词分节（设计稿 `docs/specs/system-prompt-design.md` §2）。
 *
 * 六节按**稳定性降序**排列：越不常变的越靠前，prompt cache 才能以稳定前缀命中
 * （§0「顺序」、§7.3 A2）。空节整节省略，不留空标题（§4.3）。
 *
 * 这些内容全部是**投影期注入**：由调用方在组装请求时传入 `buildMessages`，
 * **不写会话日志**。理由与压缩摘要一致（§3.1）：写日志会让全部历史会话在续聊
 * 时触发 `system_prompt_mismatch`，且「改提示词 = 改历史事实」。
 *
 * 本模块的渲染函数是纯函数：只依赖入参，不读 `Date.now()`、不读环境变量，
 * 保证同一会话内逐字节稳定（§2.2「会话内恒定」）。
 */

export interface SystemSections {
  base?: string;
  environment?: string;
  tools?: string;
  instructions?: string;
  memory?: string;
  summary?: string;
}

/** 稳定性降序（设计稿 §0 / §2）。输出顺序是契约的一部分。 */
export const SYSTEM_SECTION_ORDER = [
  "base",
  "environment",
  "tools",
  "instructions",
  "memory",
  "summary",
] as const;

export type SystemSectionKey = (typeof SYSTEM_SECTION_ORDER)[number];

/** 每节的稳定标题。逐字节固定，不随调用次数变化。 */
const SECTION_TITLES: Record<SystemSectionKey, string> = {
  base: "# Base",
  environment: "# Environment",
  tools: "# Tools",
  instructions: "# Instructions",
  memory: "# Memory",
  summary: "# Summary",
};

export interface EnvironmentFacts {
  workdir: string;
  platform: NodeJS.Platform;
  /** 取不到时为 undefined——整行省略，不写 "unknown"（未知不等于事实）。 */
  shell: string | undefined;
  /** 会话创建日期；允许 ISO 时间戳，输出只保留 `YYYY-MM-DD`。 */
  createdDate: string;
}

/**
 * 日期只到日，不写时刻。
 *
 * 时刻每轮都变，写进前缀会让 prompt cache 全部失效（设计稿 §2.2）。入参若是
 * 完整 ISO 时间戳（`header.createdAt` 的形态），这里切掉时刻；形态对不上时
 * 原样保留——不猜、不伪造一个日期。
 */
function toDateOnly(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  return match === null ? trimmed : match[1]!;
}

/**
 * 渲染 `environment` 节正文（**不带标题**，标题由调用方或 `renderSections` 决定）。
 *
 * 只写事实，不写措辞性建议（§2.2）。`workdir` 出口转 POSIX 风格，与
 * AGENTS.md「内部路径按 POSIX 风格统一表示」一致。
 */
export function renderEnvironmentSection(facts: EnvironmentFacts): string {
  const lines = [
    `Working directory: ${facts.workdir.replace(/\\/g, "/")}`,
    `Platform: ${facts.platform}`,
  ];
  // shell 取不到时整行省略：留一个空值或 "unknown" 会让模型据此猜环境。
  if (facts.shell !== undefined && facts.shell.trim() !== "") {
    lines.push(`Shell: ${facts.shell}`);
  }
  lines.push(`Date: ${toDateOnly(facts.createdDate)}`);
  return lines.join("\n");
}

/**
 * 按固定顺序渲染非空节，每项 `content` 是最终拼给模型的字符串（标题 + 正文）。
 *
 * 空串 / 全空白整节省略：空标题既费 token，又会让模型去猜「这里本该有什么」
 * （§4.3）。
 */
export function renderSections(
  sections: SystemSections,
): { key: SystemSectionKey; content: string }[] {
  const rendered: { key: SystemSectionKey; content: string }[] = [];
  for (const key of SYSTEM_SECTION_ORDER) {
    const body = sections[key];
    // 只检查是否为空，不改写正文：调用方给的内容原样进入消息。
    if (typeof body !== "string" || body.trim() === "") continue;
    rendered.push({ key, content: `${SECTION_TITLES[key]}\n${body}` });
  }
  return rendered;
}

/**
 * 计算各节的哈希与字符数，用于 `meta.json` 的 `promptSections`（§3.1）。
 *
 * `hash` 是 sha256 十六进制；`chars` 是内容长度，供界面判断这一节占了多少。
 */
export function hashSections(
  entries: readonly { key: string; content: string }[],
): Record<string, { hash: string; chars: number }> {
  const hashes: Record<string, { hash: string; chars: number }> = {};
  for (const entry of entries) {
    hashes[entry.key] = {
      hash: createHash("sha256").update(entry.content, "utf8").digest("hex"),
      chars: entry.content.length,
    };
  }
  return hashes;
}

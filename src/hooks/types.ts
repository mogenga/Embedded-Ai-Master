/**
 * 外部命令钩子（`hooks.json`）的类型。
 *
 * 钩子是**配置里的一条命令**：工具调用的 JSON 走它的 stdin，退出码决定语义。
 * 它只在权限层放行之后运行，因此永远只能收紧、不能放行（见
 * `src/tools/pipeline.ts` 的 `executeAuthorized`）。
 */

export type HookEvent = "preToolUse" | "postToolUse";

export interface HookDef {
  event: HookEvent;
  /** 工具名模式，语法与权限规则一致（`*` / `?`）。缺省匹配全部工具。 */
  matcher?: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  /** 来源，用于错误信息里说清是哪份文件配的。 */
  source: "user" | "project";
  /** 配置里这条规则的序号 + 文件，错误信息要能指回去。 */
  index: number;
}

/** `postToolUse` 看到的工具结果快照（只取四个必填字段，不含 detail）。 */
export interface HookResultSnapshot {
  isError: boolean;
  code: string;
  message: string;
  text: string;
}

/**
 * 写进钩子 stdin 的文档（`tool` 由 `HookRunner.run` 的参数补上）。
 *
 * `detail` / `evidence` / `artifactPath` 刻意不在里面：钩子不该看到一份
 * 与模型不同的、更完整的结果，那会让"钩子看到的就是模型看到的"不再成立。
 */
export interface HookPayload {
  callId: string;
  sessionId: string;
  cwd: string;
  input: unknown;
  result?: HookResultSnapshot;
}

export interface HookOutcome {
  event: HookEvent;
  command: string;
  /** 与 `HookDef` 同源：`detail.hooks` 要能指回是哪份配置的哪一条。 */
  source: "user" | "project";
  index: number;
  /** 进程退出码；起不来或超时是 undefined。 */
  exitCode?: number;
  /** preToolUse 的 exit 2 是「阻断」，这是唯一会被当成决定的退出码。 */
  blocked: boolean;
  /** stdout / stderr，各截到 8000 字符（见 MAX_HOOK_OUTPUT_CHARS）。 */
  stdout: string;
  stderr: string;
  /** 钩子本身没跑成（spawn 失败 / 超时 / 非 0 非 2 退出）。 */
  failure?: string;
  /**
   * 管线在「这段 stdout 被追加进正文」且原结果主张过 evidence 时置 true。
   *
   * 由 `executeAuthorized` 设置，不是执行器：执行器不知道结果长什么样。
   */
  evidenceDropped?: true;
  durationMs: number;
}

export interface HookRunner {
  /** 返回本次调用的全部钩子结果；空数组表示没有配钩子。 */
  run(
    event: HookEvent,
    tool: string,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<HookOutcome[]>;
}

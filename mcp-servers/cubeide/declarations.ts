/**
 * 写前声明（Declaration）：与 keil/declarations.ts 同一契约，内容对应
 * cubeide-porting-spec.md 的安全模型。没有声明的破坏性动作视为缺陷。
 */

export interface Declaration {
  operation: string;
  effect: string;
  address?: number;
  length?: number;
}

const RUN_CONTROL = new Set([
  "run", "continue", "reset", "run_to",
  "step", "step_into", "step_instruction", "step_out",
]);

const BUILD_ACTIONS = new Set(["build", "rebuild", "clean"]);

const WIDTH_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4 };

export function declarationFor(tool: string, action: string, input: Record<string, unknown>): Declaration | undefined {
  if (action === "close") {
    return { operation: "session_close", effect: "结束 gdb 会话并关闭 gdbserver,释放探针" };
  }
  if (action === "write") {
    const width = typeof input.width === "string" ? input.width : "u32";
    const count = typeof input.count === "number" ? input.count : 1;
    return {
      operation: "memory_write",
      effect: "改写目标内存内容",
      ...(typeof input.address === "number" ? { address: input.address } : {}),
      length: (WIDTH_BYTES[width] ?? 4) * count,
    };
  }
  if (action === "breakpoint_add" || action === "breakpoint_delete") {
    return { operation: "debug_state", effect: "增删断点(不改变目标执行状态)" };
  }
  if (RUN_CONTROL.has(action)) {
    return { operation: "run_control", effect: "改变目标执行状态" };
  }
  if (action === "flash") {
    return {
      operation: "flash_download",
      effect: "擦除并烧写镜像扇区(STM32_Programmer_CLI -w),随后回读校验;执行前会结束打开的调试会话",
    };
  }
  if (action === "erase") {
    return {
      operation: "chip_erase",
      effect: "整片擦除目标 Flash(STM32_Programmer_CLI -e all);芯片上全部内容会丢失,执行前会结束打开的调试会话",
    };
  }
  if (BUILD_ACTIONS.has(action) && tool === "cubeide_build") {
    return { operation: "project_build", effect: "调用 CubeIDE headless 构建工程,产物覆盖输出目录" };
  }
  return undefined;
}

/**
 * 写前声明：与 keil/cubeide 的 declarationFor 同一契约。
 */

export interface Declaration {
  operation: string;
  effect: string;
  address?: number;
  length?: number;
}

const RUN_CONTROL = new Set([
  "run", "continue", "reset", "step", "step_into", "step_instruction", "step_out",
]);

const BUILD_ACTIONS = new Set(["build", "rebuild", "clean"]);

const WIDTH_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4 };

export function declarationFor(tool: string, action: string, input: Record<string, unknown>): Declaration | undefined {
  if (action === "close") {
    return { operation: "session_close", effect: "结束 esp-gdb 会话并关闭 openocd,释放调试口" };
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
      effect: "按 build/flasher_args.json 烧写全部镜像(bootloader+分区表+app,esptool write-flash),随后校验;执行前会结束打开的调试会话",
    };
  }
  if (action === "erase") {
    return {
      operation: "chip_erase",
      effect: "整片擦除 Flash(esptool erase-flash);芯片上全部内容会丢失,执行前会结束打开的调试会话",
    };
  }
  if (BUILD_ACTIONS.has(action) && tool === "esp_build") {
    return { operation: "project_build", effect: "调用 idf.py 构建/清理工程,产物写入 build/" };
  }
  return undefined;
}

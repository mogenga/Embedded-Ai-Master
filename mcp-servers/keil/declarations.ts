/**
 * 写前声明（Declaration）：每个破坏性动作在真正执行前，把"会发生什么"结构化地说清楚。
 *
 * 形状照 probe 的声明契约（operation / effect / address? / length?），内容逐条对应
 * keil-porting-spec.md §7.2。审批层据此显示影响面；没有声明的破坏性动作视为缺陷。
 */

export interface Declaration {
  operation: string;
  effect: string;
  address?: number;
  length?: number;
}

const RUN_CONTROL = new Set([
  "run", "continue", "reset", "run_to",
  "step", "step_into", "step_instruction", "step_out", "step_many",
]);

const BUILD_ACTIONS = new Set([
  "build", "rebuild", "clean", "clean_rebuild", "convert", "export_cprj", "export_cprjs",
]);

const DEBUG_STATE = new Set(["breakpoint_add", "breakpoint_delete", "watch_add", "watch_remove"]);

const PROJECT_EDIT = new Set(["add_group", "add_file", "remove_file", "remove_group", "set_option", "set_target", "set_output_name"]);

const WIDTH_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4 };

export function declarationFor(tool: string, action: string, input: Record<string, unknown>): Declaration | undefined {
  if (action === "close" || action === "close_project") {
    return { operation: "session_close", effect: "结束 uVision 会话;关闭时把工程编辑写回 .uvprojx" };
  }

  if (tool === "keil_project") {
    if (PROJECT_EDIT.has(action)) {
      return { operation: "project_edit", effect: "经 uVision 改写 .uvprojx/.uvoptx(编辑前自动备份)" };
    }
    return undefined;
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
  if (action === "register_set") {
    const name = typeof input.name === "string" ? input.name : "寄存器";
    return { operation: "state_write", effect: `改写 ${name} 的值` };
  }
  if (action === "variable_set") {
    const name = typeof input.expression === "string" ? input.expression : "变量";
    return { operation: "state_write", effect: `改写 ${name} 的值` };
  }
  if (DEBUG_STATE.has(action)) {
    return { operation: "debug_state", effect: "增删断点/观察点(不改变目标执行状态)" };
  }
  if (RUN_CONTROL.has(action)) {
    return { operation: "run_control", effect: "改变目标执行状态" };
  }
  if (action === "flash") {
    return {
      operation: "flash_download",
      effect: "擦除并烧写镜像扇区;仅擦除镜像自身扇区,不是整片(A 实测);随后回读校验",
    };
  }
  if (action === "erase") {
    return {
      operation: "chip_erase",
      effect: "整片擦除(A 实测走 STM32_Programmer_CLI -e all,UVSOCK 的 PRJ_FLASH_ERASE 在 5.43a 无响应)",
    };
  }
  if (BUILD_ACTIONS.has(action)) {
    return { operation: "project_build", effect: "调用 UV4 CLI 重译/清理工程,产物覆盖输出目录" };
  }
  if (action === "command") {
    return { operation: "uvision_command", effect: "执行 uVision 命令窗口命令,效果由命令决定" };
  }
  if (action === "menu_exec") {
    return { operation: "debug_state", effect: "执行 uVision 菜单命令,效果由菜单项决定" };
  }
  return undefined;
}
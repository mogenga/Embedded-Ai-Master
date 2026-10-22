import { terminalBgCheckTool, terminalBgTool } from "./background.js";
import { echoTool } from "./echo.js";
import { editTool, multieditTool, readTool, writeTool } from "./fs.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { shellTool } from "./shell.js";
import { todoWriteTool } from "./todos.js";
import type { ToolDef } from "./types.js";

// 顺序固定:先只读的 echo/read/ls,再按「改动范围从小到大」排 write/edit/multiedit,
// 最后才是 shell 与检索。模型侧按顺序选工具,读类排前面能减少误选写工具。
//
// `ls` 排在 `read` 之后:`read` 一个目录只会得到 not_a_file,而「这个目录里有什么」
// 是读文件之前更常问的问题;两者相邻,模型不必跳过写工具去找它。
//
// `todo_write` 排在 `ls` 之后、`write` 之前:它是计划类而不是文件类,对工作区零副作用,
// 紧挨写工具放,是为了让「先列计划再动手」在模型的选择顺序里贴在一起。
//
// `terminal_bg` / `terminal_bg_check` 紧跟在 `shell` 之后:它们回答的是同一个问题
// (「跑一条命令」),区别只在要不要等。放远了,模型会在该用后台的时候仍然选 `shell`,
// 然后被十分钟的构建卡住整轮。check 排在 bg 后面,因为先有作业才谈得上查。
export function createBuiltinTools(): ToolDef<unknown>[] {
  return [
    echoTool,
    readTool,
    lsTool,
    todoWriteTool,
    writeTool,
    editTool,
    multieditTool,
    shellTool,
    terminalBgTool,
    terminalBgCheckTool,
    globTool,
    grepTool,
  ];
}

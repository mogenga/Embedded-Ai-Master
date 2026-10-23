# M2 阶段 3 — CubeIDE 接入与工程路由门面

## 2026-10-23

- 用户原话：「开始调研cubeide如何像keil一样接入」→「我想做的就是 遇到什么工程调用哪个mcp 懂我意思了吧」→「选A吧 开始」。
- 关键产出：`docs/cubeide-porting-spec.md`（路由表、模块划分、安全模型）；`mcp-servers/cubeide/` 12 个文件；`embed_project` 门面（`route.ts` + `route-cubeide.ts`）挂进 keil/cubeide 两个 server；`docs/cubeide-headless.md`。
- 实测驱动的设计点：
  - CubeIDE 在 G:\software（非默认路径）→ 发现逻辑 = `CUBEIDE_HOME` 环境变量 → 默认路径 glob；注册表路线写了但 Uninstall 键名不确定，环境变量是主通道。
  - `newestPlugin` 第一版字符串排序会选中 `.jar` 而不是 `.win32_*` 目录（jar 排在后面），实测发现后改为 `withFileTypes` 只取目录。
  - GDB/MI 的 result-class 边界实测是空格**或逗号**（`*stopped,reason=...` 合法），第一版只按空格切导致解析为空。
  - 本机无 ST-Link 接入：烧录/调试的真机验证没做，`probe` 动作实测输出与 STM32_Programmer_CLI 直跑一致（No ST-Link detected）。
- 被拒绝/纠偏：无（方案 A 之前给过 A/B 两个选项，用户选 A）。
- 翻车与返工：一次端到端冒烟误把 keil `info` 转发跑了（会拉起 uVision），300s 超时进后台后 taskkill 停掉——真机动作不该在冒烟里顺手跑，identify-only 验证就够了。
- 测试：20 个离线单测全过；`npm test` 3 处失败（skills-store ×2、kb-review ×1）在干净树上同样失败，与本轮无关。`npm run build:mcp` 通过，dist-mcp/cubeide/ 产出验证。

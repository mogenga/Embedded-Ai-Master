<!--
  提交前：标题用 `type(scope): 中文描述`（≤50 字）；破坏性变更在 type 后加 `!`。
  「How Has This Been Tested?」必须写**实际跑过**的命令与结果，没跑的写「未跑」。
  涉及已知缺陷时写 D-xxx / T-xxx，并在 docs/deferred-issues.md 同步状态。
-->

## Description

<!-- 这个 PR 做了什么、为什么做。若修复某个缺陷，写 D-xxx。 -->

Closes #

## Type of change

- [ ] Bug fix（不兼容性修复）
- [ ] New feature（不改变既有行为的增量）
- [ ] Breaking change（会使既有功能行为改变）
- [ ] Refactor / Docs / Chore
- [ ] 需要同步更新文档

## How Has This Been Tested?

<!-- 实际跑过的命令与结果。CI 会跑 typecheck + build + test，但那不替代本机验证。 -->

```
npm run typecheck   →
npm run build       →
npm run build:mcp   →
npm test            →
```

- 手工验证（界面 / 真机 / 网关）：

## Checklist

- [ ] 提交信息符合 `type(scope): 中文描述`，scope 用真实模块名
- [ ] 新增或改变的行为有测试；错误路径有对应的失败用例
- [ ] 工具失败时显式报错，没有静默吞掉或把失败伪装成成功（R3）
- [ ] 领域逻辑没有进 `src/`（嵌入式能力一律走 MCP）
- [ ] 触及已知缺陷时，`docs/deferred-issues.md` 状态已同步
- [ ] 文档（README / 子目录 README / MATRIX）与实际行为一致
- [ ] 测试未触网；需要出网的验收脚本已单独说明

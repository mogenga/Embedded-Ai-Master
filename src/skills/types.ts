/**
 * 技能（可复用的提示词模板）的公共类型。
 *
 * 边界：内核只负责「存储、解析、校验」。斜杠命令的展开（`$ARGUMENTS` 替换）由渲染层
 * 完成，展开后的文本作为普通 user 消息发给模型——内核不认识 `$ARGUMENTS`，也不执行
 * 技能里的任何内容。把展开放进内核会让「保存一段提示词」变成「运行一段脚本」。
 */
export type SkillScope = "user" | "project";

export interface Skill {
  /** 文件名主干，须匹配 SKILL_NAME_PATTERN。 */
  name: string;
  /** frontmatter 的 description；文件里没写就是空串，不编造。 */
  description: string;
  /** frontmatter 的 argument-hint；文件里没写就是空串。 */
  argumentHint: string;
  scope: SkillScope;
  /** 去掉 frontmatter 后的提示词正文（首尾空白已裁剪，换行统一为 LF）。 */
  body: string;
}

export interface SkillProblem {
  /** Absolute path of the file that could not be used. */
  file: string;
  /** Human-readable reason, in Chinese (the app's UI language). */
  message: string;
}

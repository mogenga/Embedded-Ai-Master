/**
 * `keil_debug` / `keil_project` 失败结果里的 `structuredContent.code` 词表。
 *
 * 只有这一处定义：工具层按码给结果，调用方按码分支。此前只有抛异常那条路带
 * `code: "keil_error"`，其余 `isError: true` 的结果没有码，调用方只能解析文案
 * ——而文案是给人看的，已经被测试和文档逐字引用，不能为了配码去改（OPT-43）。
 *
 * 词表刻意小：每条都对应一个调用方真正会分开处理的情形。`keil_action_failed`
 * 是其余失败路径的兜底，不是「随便什么错」——它意味着「调用提出了合法请求，
 * 但调试器/目标没做到」，具体原因在 `message` 与正文里。
 */

export const KEIL_ERROR_CODES = {
  /** 工具内部抛了异常（未预期的错误，不是调试器的拒绝）。 */
  internal: "keil_error",
  /** 这台机器上没有 UV4.exe：MDK 未安装，无头调试无从谈起。 */
  notInstalled: "keil_not_installed",
  /**
   * 请求的动作本工具不提供（未知 action）。
   *
   * 注意 `UNSUPPORTED_ON_MDK_5_43` 里的条目是底层 UVSOCK 操作名，不是工具 action：
   * 被它命中的两条路径各有更具体的码——`erase` 派发 `PRJ_FLASH_ERASE` 得到
   * `keil_erase_unavailable`，`trace_get` 派发 `DBG_VTR_GET` 得到
   * `keil_action_failed`（拒绝的是变量名，不是动作本身）。`capabilities` 只是把
   * 表列出来，不产生错误。
   */
  unsupportedAction: "keil_unsupported_action",
  /** 会话存在，但没有进入调试态；此后的读数会退化成空结果，所以直接拒绝。 */
  notDebugging: "keil_not_debugging",
  /** 整片擦除在 MDK 5.43 上无响应（见 UNSUPPORTED_ON_MDK_5_43 的 PRJ_FLASH_ERASE）。 */
  eraseUnavailable: "keil_erase_unavailable",
  /** 烧录后的回读比对没通过，或根本没能比（打不开调试器/读不回芯片）。 */
  verifyFailed: "keil_verify_failed",
  /** build / rebuild 失败（uVision 的构建码不是 1 或 2）。 */
  buildFailed: "keil_build_failed",
  /** 其余失败：请求合法但调试器或目标没做到。 */
  actionFailed: "keil_action_failed",
} as const;

export type KeilErrorCode = (typeof KEIL_ERROR_CODES)[keyof typeof KEIL_ERROR_CODES];

/** 词表的全部取值，供断言与文档使用（从上面唯一那份定义派生）。 */
export const KEIL_ERROR_CODE_VALUES: readonly KeilErrorCode[] =
  Object.values(KEIL_ERROR_CODES);

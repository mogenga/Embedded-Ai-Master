/**
 * 写前声明：与 keil/cubeide/espidf 的 declarationFor 同一契约。
 * Arduino 只有 upload 一个破坏性动作。
 */

export interface Declaration {
  operation: string;
  effect: string;
}

export function declarationFor(action: string): Declaration | undefined {
  if (action === "upload") {
    return {
      operation: "flash_download",
      effect: "经 avrdude 烧写 sketch 到串口板;烧写后校验;期间串口被占用",
    };
  }
  return undefined;
}

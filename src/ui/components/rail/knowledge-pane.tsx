import type { JSX } from "preact";
import { Icon } from "../../icons.js";

type TreeNode = {
  id: string;
  label: string;
  count?: number;
  active?: boolean;
  children?: ReadonlyArray<TreeNode>;
};

const KB_TREE: ReadonlyArray<TreeNode> = [
  {
    id: "vendor",
    label: "vendor/ 厂商分流",
    count: 18,
    children: [
      { id: "stm32", label: "STM32 系列", count: 6, active: true },
      { id: "esp", label: "ESP32 / ESP8266", count: 4 },
      { id: "gd32", label: "GD32 / CH32", count: 3 },
      { id: "nrf", label: "nRF5x / Kinetis", count: 3 },
    ],
  },
  {
    id: "protocols",
    label: "protocols/ 协议层",
    count: 20,
    children: [
      { id: "uart", label: "UART 乱码与丢字节" },
      { id: "i2c", label: "I2C 总线锁死" },
      { id: "spi", label: "SPI 时序与片选" },
    ],
  },
  {
    id: "system",
    label: "system/ 系统层",
    count: 15,
    children: [
      { id: "clock", label: "时钟树与 PLL" },
      { id: "watchdog", label: "看门狗与低功耗" },
    ],
  },
  { id: "reference", label: "reference/ 寄存器查表", count: 39 },
  { id: "debug", label: "debug/ HardFault 解码" },
  { id: "index", label: "index.yaml 症状索引", count: 85 },
];

const KB_TOTAL = 103;

function toggleRow(event: JSX.TargetedMouseEvent<HTMLButtonElement>): void {
  const row = event.currentTarget;
  row.setAttribute("aria-expanded", String(row.getAttribute("aria-expanded") !== "true"));
}

function TreeItem({ node }: { node: TreeNode }): JSX.Element {
  if (!node.children) {
    return (
      <li>
        <button type="button" class={node.active ? "tree-row is-active" : "tree-row"}>
          <span class="leaf-dot" />
          <span class="label">{node.label}</span>
          {node.count === undefined ? null : <span class="tag">{node.count}</span>}
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        class="tree-row"
        aria-expanded={node.id === "vendor"}
        onClick={toggleRow}
      >
        <Icon name="i-chevron" size={14} className="chev" />
        <span class="label">{node.label}</span>
        {node.count === undefined ? null : <span class="tag">{node.count}</span>}
      </button>
      <ul class="tree-children">
        {node.children.map((child) => (
          <TreeItem key={child.id} node={child} />
        ))}
      </ul>
    </li>
  );
}

export function KnowledgePane(): JSX.Element {
  return (
    <section class="rail-top" aria-label="知识库">
      <div class="pane-head">
        <Icon name="i-book" size={14} />
        <span>知识库</span>
        <span class="count">{KB_TOTAL}</span>
      </div>
      <div class="kb-search">
        <Icon name="i-search" size={14} />
        <input type="search" aria-label="检索知识库" placeholder="kb_lookup · 寄存器名 / 错误码 / 症状" />
      </div>
      <ul class="tree">
        {KB_TREE.map((node) => (
          <TreeItem key={node.id} node={node} />
        ))}
      </ul>
    </section>
  );
}
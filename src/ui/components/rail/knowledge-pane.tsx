import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { KbNode } from "../../api/client.js";
import { Icon } from "../../icons.js";

function countFiles(nodes: readonly KbNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === "file") total += 1;
    else total += countFiles(node.children ?? []);
  }
  return total;
}

function TreeItem({
  node,
  level,
  expanded,
  onToggle,
}: {
  node: KbNode;
  level: number;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void;
}): JSX.Element {
  if (node.kind === "file") {
    return (
      <li>
        <button type="button" class="tree-row" style={`padding-left:${8 + level * 12}px`}>
          <span class="leaf-dot" />
          <span class="label">{node.name}</span>
        </button>
      </li>
    );
  }
  const open = expanded[node.path] === true;
  const children = node.children ?? [];
  return (
    <li>
      <button
        type="button"
        class="tree-row"
        aria-expanded={open}
        style={`padding-left:${8 + level * 12}px`}
        onClick={() => onToggle(node.path)}
      >
        <Icon name="i-chevron" size={14} className="chev" />
        <span class="label">{node.name}</span>
        {children.length === 0 ? null : <span class="tag">{children.length}</span>}
      </button>
      {open && children.length > 0 ? (
        <ul class="tree-children">
          {children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              level={level + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function KnowledgePane({ nodes, root }: { nodes: KbNode[]; root?: string | null }): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const node of nodes) if (node.kind === "dir") initial[node.path] = true;
    return initial;
  });

  function toggle(path: string): void {
    setExpanded((prev) => ({ ...prev, [path]: prev[path] !== true }));
  }

  return (
    <section class="rail-top" aria-label="知识库">
      <div class="pane-head">
        <Icon name="i-book" size={14} />
        <span>知识库</span>
        <span class="count">{countFiles(nodes)}</span>
      </div>
      <div class="kb-search">
        <Icon name="i-search" size={14} />
        <input type="search" aria-label="检索知识库" placeholder="kb_lookup · 寄存器名 / 错误码 / 症状" />
      </div>
      {nodes.length === 0 ? (
        <p class="pane-empty">{root === null ? "未配置知识库" : "知识库为空"}</p>
      ) : (
        <ul class="tree">
          {nodes.map((node) => (
            <TreeItem key={node.path} node={node} level={0} expanded={expanded} onToggle={toggle} />
          ))}
        </ul>
      )}
    </section>
  );
}
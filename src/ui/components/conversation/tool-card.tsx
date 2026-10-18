import type { JSX } from "preact";
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "../../icons.js";
import type { EvidenceRow, HitRow, ReadoutRow, ToolCardModel, ToolKind } from "../../view/transcript.js";

const KIND_ICON: Record<ToolKind, string> = {
  readout: "i-terminal",
  hitlist: "i-book",
  evidence: "i-cpu",
  error: "i-alert",
};

const FOLD_LIMIT: Record<ToolKind, number> = {
  readout: 4,
  hitlist: 3,
  evidence: 3,
  error: Number.POSITIVE_INFINITY,
};

const TEXT_FOLD_LINES = 6;
const TEXT_FOLD_BYTES = 240;
const SUMMARY_LIMIT = 120;

const VERDICT_META = {
  bad: { icon: "i-x", text: "与预期不符" },
  warn: { icon: "i-alert", text: "需关注" },
  ok: { icon: "i-check", text: "读数有效" },
} as const;

function rowCount(tool: ToolCardModel, kind: ToolKind): number {
  switch (kind) {
    case "readout":
      return tool.readout?.length ?? 0;
    case "hitlist":
      return tool.hits?.length ?? 0;
    case "evidence":
      return tool.evidence?.length ?? 0;
    default:
      return 0;
  }
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function flagText(tool: ToolCardModel): string {
  const parts: string[] = [];
  if (tool.kind === "hitlist" && tool.hits !== undefined) parts.push(`命中 ${tool.hits.length}`);
  if (tool.ms !== undefined) parts.push(`${tool.ms}ms`);
  return parts.join(" · ");
}

function summary(tool: ToolCardModel, kind: ToolKind): string {
  if (kind === "readout" && tool.readout === undefined && tool.text !== undefined) {
    const first = tool.text.split("\n")[0] ?? "";
    return first.length > SUMMARY_LIMIT ? `${first.slice(0, SUMMARY_LIMIT)}…` : first;
  }
  switch (kind) {
    case "readout": {
      const first = tool.readout?.[0];
      return first === undefined ? "" : `${first.label} ${first.value}`;
    }
    case "hitlist":
      return tool.hits?.[0]?.path ?? "";
    case "evidence": {
      const first = tool.evidence?.[0];
      return first === undefined ? "" : `${first.name} ${first.value}`;
    }
    default:
      return "";
  }
}

function foldCount(tool: ToolCardModel, count: number): string {
  if (tool.text !== undefined && count === 0) {
    return `${tool.text.split("\n").length} 行 · ${textBytes(tool.text)} B`;
  }
  return `${count} 行`;
}

function Readout({ rows }: { rows: readonly ReadoutRow[] }): JSX.Element {
  return (
    <dl class="readout">
      {rows.map((row, index) => (
        <Fragment key={`${row.label}-${index}`}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
          {row.note === undefined ? null : <dd class="wide">{row.note}</dd>}
        </Fragment>
      ))}
    </dl>
  );
}

function HitList({ rows }: { rows: readonly HitRow[] }): JSX.Element {
  return (
    <div class="hit-list">
      {rows.map((hit, index) => (
        <div class="hit" data-s={String(hit.channel)} key={`${hit.path}-${index}`}>
          <span class="bar" />
          <div>
            <div class="hit-path">{hit.path}</div>
            <div class="hit-desc">{hit.desc}</div>
            <div class="hit-score">{hit.score}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function EvidenceTable({ rows }: { rows: readonly EvidenceRow[] }): JSX.Element {
  return (
    <div class="ev">
      {rows.map((row, index) => {
        const meta = VERDICT_META[row.verdict];
        return (
          <div class="ev-row" key={`${row.name}-${index}`}>
            <div class="ev-name">
              {row.name}
              {row.code.length === 0 ? null : <code>{row.code}</code>}
            </div>
            <div class="ev-val">{row.value}</div>
            <span class="verdict" data-v={row.verdict}>
              <Icon name={meta.icon} size={12} />
              {row.label.length === 0 ? meta.text : row.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolBody({ tool, kind }: { tool: ToolCardModel; kind: ToolKind }): JSX.Element | null {
  switch (kind) {
    case "readout":
      if (tool.readout !== undefined) {
        return (
          <Fragment>
            <Readout rows={tool.readout} />
            {tool.evidence === undefined ? null : <EvidenceTable rows={tool.evidence} />}
          </Fragment>
        );
      }
      if (tool.text !== undefined && tool.text.length > 0) return <pre class="tool-text">{tool.text}</pre>;
      if (tool.artifactPath !== undefined) {
        return <div class="tool-empty">结果已落盘：{tool.artifactPath}</div>;
      }
      return <div class="tool-empty">无读数返回</div>;
    case "hitlist":
      return tool.hits === undefined ? <div class="tool-empty">无命中结果</div> : <HitList rows={tool.hits} />;
    case "evidence":
      return tool.evidence === undefined ? <div class="tool-empty">无证据返回</div> : <EvidenceTable rows={tool.evidence} />;
    default:
      return null;
  }
}

export function ToolCard({ tool }: { tool: ToolCardModel }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const pending = tool.pending === true;
  const failed = !tool.ok || tool.kind === "error";
  const kind: ToolKind = failed ? "error" : tool.kind;
  const count = rowCount(tool, kind);
  const textFoldable =
    tool.text !== undefined &&
    (tool.text.split("\n").length > TEXT_FOLD_LINES || textBytes(tool.text) > TEXT_FOLD_BYTES);
  const collapsible = kind !== "error" && (count > FOLD_LIMIT[kind] || textFoldable);
  const showBody = kind !== "error" && !pending && (!collapsible || expanded);
  const errorText =
    tool.errorText !== undefined && tool.errorText.length > 0 ? tool.errorText : "工具未返回错误说明";

  return (
    <article
      class={tool.destructive === true ? "tool is-destructive" : "tool"}
      data-kind={kind}
      data-ro={tool.readOnly === true ? "true" : undefined}
      data-pending={pending ? "true" : undefined}
    >
      <header class="tool-head">
        <Icon name={KIND_ICON[kind]} size={14} />
        <span class="tool-name">{tool.name}</span>
        <span class="tool-args">{tool.args}</span>
        <span class="spacer" />
        {pending ? (
          <span class="tool-flag tool-flag--pending">执行中</span>
        ) : failed ? (
          <span class="tool-flag tool-flag--error">
            <Icon name="i-alert" size={12} />
            {tool.errorCode ?? "调用失败"}
          </span>
        ) : (
          <span class="tool-flag">
            <Icon name="i-check" size={12} />
            {flagText(tool)}
          </span>
        )}
      </header>
      {pending ? null : kind === "error" ? (
        <div class="tool-body">
          <div class="tool-error" role="alert">
            <code>{tool.errorCode ?? "error"}</code>
            <p>{errorText}</p>
          </div>
        </div>
      ) : (
        <Fragment>
          {collapsible ? (
            <div class="tool-fold">
              <span class="tool-fold-sum">摘要：{summary(tool, kind)}</span>
              <span class="tool-fold-count">{foldCount(tool, count)}</span>
              <button
                type="button"
                class="tool-fold-btn"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                <Icon name={expanded ? "i-chevron-down" : "i-chevron"} size={12} />
                {expanded ? "收起" : "展开"}
              </button>
            </div>
          ) : null}
          {showBody ? (
            <div class="tool-body">
              <ToolBody tool={tool} kind={kind} />
            </div>
          ) : null}
        </Fragment>
      )}
    </article>
  );
}

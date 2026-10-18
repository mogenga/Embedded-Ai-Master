import type { ComponentChildren, JSX } from "preact";
import { Icon } from "../../icons.js";
import type { VerdictModel } from "../../view/transcript.js";
import { EvidenceTable } from "./tool-card.js";

const OWNERSHIP_ICON = {
  agent: "i-spark",
  user: "i-user",
  manual: "i-hand",
} as const;

const HIGHLIGHT = /([A-Z_]+.{0,4}0x[0-9A-F_]+|PCLK1|HSI|HSE)/g;

function renderRootCause(text: string): ComponentChildren {
  const parts = text.split(HIGHLIGHT);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <code class="k" key={index}>
        {part}
      </code>
    ) : (
      part
    ),
  );
}

export function VerdictCard({ verdict }: { verdict: VerdictModel }): JSX.Element {
  return (
    <article class="verdict-card">
      <header class="vc-head">
        <Icon name="i-check" size={15} />
        根因判决
        <span class="tag">置信度 {verdict.confidence}</span>
      </header>
      <div class="vc-body">
        <section class="vc-block">
          <h4>根因</h4>
          <p>{renderRootCause(verdict.rootCause)}</p>
          {verdict.confidence === "低" ? (
            <p class="vc-uncertain">
              低置信度：当前证据尚不足以排除其他假设，结论存在不确定性，需补充取证后再据此动作。
            </p>
          ) : null}
        </section>
        <section class="vc-block">
          <h4>证据链</h4>
          <EvidenceTable rows={verdict.evidence} />
        </section>
        <section class="vc-block">
          <h4>可证伪的修复建议</h4>
          <div class="predict">{verdict.prediction}</div>
        </section>
        <section class="vc-block">
          <h4>动作归属</h4>
          <div class="ownership">
            {verdict.ownership.map((item, index) => (
              <div class="own" data-o={item.t} key={`${item.t}-${index}`}>
                <div class="own-k">
                  <Icon name={OWNERSHIP_ICON[item.t]} size={13} />
                  {item.title}
                </div>
                <p>{item.desc}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </article>
  );
}

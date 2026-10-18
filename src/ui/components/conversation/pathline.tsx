import { Fragment } from "preact";
import type { JSX } from "preact";
import type { TranscriptStep } from "../../view/transcript.js";

export function PathLine({ steps }: { steps: TranscriptStep[] }): JSX.Element {
  return (
    <nav class="pathline" aria-label="诊断路径">
      {steps.map((step, index) => (
        <Fragment key={step.id}>
          {index > 0 ? <span class="pathline-line" aria-hidden="true" /> : null}
          <span
            class="step"
            data-s={step.state}
            aria-current={step.state === "now" ? "step" : undefined}
          >
            <span class="step-num">{index + 1}</span>
            <span class="step-label">{step.label}</span>
          </span>
        </Fragment>
      ))}
    </nav>
  );
}

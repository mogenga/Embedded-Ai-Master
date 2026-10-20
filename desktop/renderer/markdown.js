/** Minimal, dependency-free markdown renderer shared by the transcript and previews. */

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** Minimal, dependency-free markdown renderer (headings, lists, code, inline). */
export function renderMarkdown(source, copyLabel = "copy") {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`);

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, "") || "text";
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        `<pre><div class="code-head"><span>${escapeHtml(lang)}</span>` +
          `<button class="code-copy" data-code>${escapeHtml(copyLabel)}</button></div>` +
          `<code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*])\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && (/^\s*([-*])\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return out.join("");
}

/**
 * Render a growing message one block at a time.
 *
 * Re-rendering the whole reply on every animation frame is O(n) per frame, so
 * a long answer got slower the more of it existed — the scroll stuttered
 * exactly while the user was waiting for it. A block is any run of markdown
 * separated by a blank line (or an open fence); completed blocks are rendered
 * once and cached, and only the block still receiving text is re-rendered.
 *
 * The cache is keyed by the block's source text rather than by index, so a
 * retry that discards the reply simply stops matching and starts over.
 */
export class IncrementalRenderer {
  constructor(copyLabel = "copy") {
    this.copyLabel = copyLabel;
    this.blocks = [];
    this.cachedHtml = "";
  }

  reset() {
    this.blocks = [];
    this.cachedHtml = "";
  }

  /** Split on blank lines, but never inside an unclosed fence. */
  static split(source) {
    const lines = source.replace(/\r?\n/g, "\n").split("\n");
    const blocks = [];
    let current = [];
    let fenced = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (!fenced && line.trim() === "") {
        if (current.length > 0) blocks.push(current.join("\n"));
        current = [];
        continue;
      }
      current.push(line);
    }
    if (current.length > 0) blocks.push(current.join("\n"));
    return blocks;
  }

  /** The full HTML for the source so far. */
  render(source) {
    const blocks = IncrementalRenderer.split(source);
    // Streaming appends to the tail block, so the common case is "same block
    // count, same prefix, different last block". Comparing only the blocks
    // that can have changed — instead of building a signature of the whole
    // reply every frame — keeps a long answer from costing O(n²) in string
    // work alone.
    let shared = 0;
    const limit = Math.min(blocks.length, this.blocks.length);
    while (shared < limit && this.blocks[shared].source === blocks[shared]) shared++;

    // An unterminated code fence is one block that grows with every token, and
    // re-highlighting it is the expensive case: cost grows with the square of
    // the block, so a 3000-line paste pasted in would re-render 3000 lines on
    // every frame. Skip the re-render until ~300 more characters have arrived;
    // the cached source deliberately stays stale so the next call sees the
    // growth and eventually renders. The final call — the one after the fence
    // closes or the turn ends — always renders, because the block then stops
    // being an open fence.
    const tail = blocks[blocks.length - 1] ?? "";
    const fenceMarks = (tail.match(/```/g) ?? []).length;
    const tailIsOpenFence = /^\s*```/.test(tail) && fenceMarks % 2 === 1;
    if (tailIsOpenFence && shared === blocks.length - 1 && this.blocks.length === blocks.length) {
      const rendered = this.tailRenderedLength ?? 0;
      if (tail.length - rendered < 300) return this.cachedHtml ?? this.html();
      this.tailRenderedLength = tail.length;
    }

    const onlyTailChanged = shared === blocks.length - 1 && blocks.length === this.blocks.length;
    if (!onlyTailChanged && shared === blocks.length && blocks.length === this.blocks.length) {
      return this.cachedHtml ?? this.html();
    }
    for (let index = shared; index < blocks.length; index++) {
      this.blocks[index] = { source: blocks[index], html: renderMarkdown(blocks[index], this.copyLabel) };
    }
    this.blocks.length = blocks.length;
    // A fence that just closed is no longer throttled; reset the mark so the
    // next open fence starts its own budget.
    if (!tailIsOpenFence) this.tailRenderedLength = 0;
    // The join is the other half of the cost; it is only redone when a block
    // actually changed, which is exactly the `shared < blocks.length` case.
    this.cachedHtml = this.html();
    return this.cachedHtml;
  }

  html() {
    return this.blocks.map((block) => block.html).join("");
  }
}

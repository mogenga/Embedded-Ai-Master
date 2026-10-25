import { describe, expect, it } from "vitest";
import { IncrementalRenderer, escapeHtml, renderMarkdown } from "../../desktop/renderer/markdown.js";

describe("escapeHtml", () => {
  it("转义 HTML 元字符", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });
});

describe("表格", () => {
  it("表头 + 分隔行 + 数据行渲染为 table/thead/tbody，列数一致", () => {
    const source = ["| Name | Value |", "| --- | --- |", "| a | 1 |", "| b | 2 |"].join("\n");
    const html = renderMarkdown(source);
    expect(html).toBe(
      "<table><thead><tr><th>Name</th><th>Value</th></tr></thead>" +
        "<tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>",
    );
    expect(html.match(/<th>/g)).toHaveLength(2);
    expect(html.match(/<td>/g)).toHaveLength(4);
  });

  it("对齐标记 :--- / :---: / ---: 产出 text-align", () => {
    const source = ["| L | C | R |", "| :--- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n");
    const html = renderMarkdown(source);
    expect(html).toContain('<th style="text-align: left">L</th>');
    expect(html).toContain('<th style="text-align: center">C</th>');
    expect(html).toContain('<th style="text-align: right">R</th>');
    expect(html).toContain('<td style="text-align: left">1</td>');
    expect(html).toContain('<td style="text-align: center">2</td>');
    expect(html).toContain('<td style="text-align: right">3</td>');
  });

  it("无对齐标记的列不加 style", () => {
    const html = renderMarkdown("| a |\n| --- |\n| 1 |");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).not.toContain("text-align");
  });

  it("单元格内容必须转义", () => {
    const html = renderMarkdown("| <b> | x |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<th>&lt;b&gt;</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).not.toContain("<b>");
  });

  it("单元格内的行内语法照常生效", () => {
    const html = renderMarkdown("| **粗** | `code` |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<th><strong>粗</strong></th>");
    expect(html).toContain("<th><code>code</code></th>");
  });

  it("行内代码里的竖线不拆列", () => {
    const html = renderMarkdown("| a | `x|y` |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<th><code>x|y</code></th>");
    expect(html.match(/<th[ >]/g)).toHaveLength(2);
  });

  it("缺分隔行时整体按普通段落处理，不产出半截表格", () => {
    const html = renderMarkdown("| a | b |\n| c | d |");
    expect(html).toBe("<p>| a | b | | c | d |</p>");
    expect(html).not.toContain("<table>");
  });

  it("普通文字里的竖线不构成表格", () => {
    const html = renderMarkdown("cat a | grep b\nnot a table");
    expect(html).toBe("<p>cat a | grep b not a table</p>");
    expect(html).not.toContain("<table>");
  });

  it("反斜杠转义的竖线留在单元格内，反斜杠本身不被吞掉", () => {
    const html = renderMarkdown(String.raw`| a \| b | C:\Users |` + "\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<th>a | b</th>");
    expect(html).toContain(String.raw`<th>C:\Users</th>`);
  });

  it("表头与分隔行列数不一致时按普通段落处理", () => {
    const html = renderMarkdown("| a | b |\n| --- |");
    expect(html).toBe("<p>| a | b | | --- |</p>");
    expect(html).not.toContain("<table>");
  });

  it("数据行列数不齐时补齐/截断，仍是完整表格", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |");
    expect(html).toContain("<tr><td>1</td><td></td></tr>");
    expect(html).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(html).not.toContain("<td>3</td>");
  });

  it("表格在空行处结束，后续文字仍是段落", () => {
    const html = renderMarkdown("| a |\n| --- |\n| 1 |\n\n后面的话");
    expect(html).toBe("<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><p>后面的话</p>");
  });
});

describe("分割线", () => {
  it.each(["---", "***", "___", "- - -", "* * *", "----"])("%s 产出 <hr>", (line) => {
    expect(renderMarkdown(line)).toBe("<hr>");
  });

  it("夹在段落之间时前后段落保留", () => {
    expect(renderMarkdown("上\n\n---\n\n下")).toBe("<p>上</p><hr><p>下</p>");
  });

  it("紧跟文字时按普通文本处理，不吃掉正文", () => {
    expect(renderMarkdown("上面一行\n---")).toBe("<p>上面一行 ---</p>");
    expect(renderMarkdown("上面一行\n* * *")).toBe("<p>上面一行 * * *</p>");
    expect(renderMarkdown("上面一行\n- - -")).toBe("<p>上面一行 - - -</p>");
  });

  it("段落中间出现的分割线标记不会变成单条列表", () => {
    const html = renderMarkdown("上面一行\n* * *");
    expect(html).not.toContain("<ul>");
    expect(html).not.toContain("<hr>");
  });

  it("代码围栏内的 --- 不识别为 hr", () => {
    const html = renderMarkdown(["```", "---", "```"].join("\n"));
    expect(html).not.toContain("<hr>");
    expect(html).toContain("<code>---</code>");
  });

  it("不足三个标记不识别", () => {
    expect(renderMarkdown("--")).toBe("<p>--</p>");
    expect(renderMarkdown("**")).toBe("<p>**</p>");
  });
});

describe("数学公式块", () => {
  it("多行 $$ 块渲染为 div.math，源样保留", () => {
    const html = renderMarkdown("$$\nE = mc^2\n\\int_0^1 x dx\n$$");
    expect(html).toBe('<div class="math">E = mc^2\n\\int_0^1 x dx</div>');
  });

  it("单行 $$...$$ 渲染为 div.math", () => {
    expect(renderMarkdown("$$E=mc^2$$")).toBe('<div class="math">E=mc^2</div>');
  });

  it("$$ 前后的段落各自独立", () => {
    const html = renderMarkdown("上\n\n$$\nE=mc^2\n$$\n\n下");
    expect(html).toBe('<p>上</p><div class="math">E=mc^2</div><p>下</p>');
  });

  it("未闭合的 $$ 块宽容渲染到文件尾", () => {
    expect(renderMarkdown("$$\nE=mc^2")).toBe('<div class="math">E=mc^2</div>');
  });

  it("公式体里的 HTML 元字符必须转义", () => {
    const html = renderMarkdown("$$\na < b & c > d\n$$");
    expect(html).toBe('<div class="math">a &lt; b &amp; c &gt; d</div>');
  });

  it("公式体里的行内语法不生效", () => {
    const html = renderMarkdown("$$\n**x** `y`\n$$");
    expect(html).toContain("**x** `y`");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<code>");
  });

  it("开 $$ 同行与闭 $$ 同行的内容都算公式体", () => {
    const html = renderMarkdown("$$ E=mc^2\nF=ma $$");
    expect(html).toBe('<div class="math">E=mc^2\nF=ma</div>');
  });

  it("公式块中间的空行保留在公式体里", () => {
    const html = renderMarkdown("$$\na=1\n\nb=2\n$$");
    expect(html).toBe('<div class="math">a=1\n\nb=2</div>');
  });

  it("代码围栏内的 $$ 不识别为公式块", () => {
    const html = renderMarkdown("```\n$$\n```");
    expect(html).not.toContain('class="math"');
    expect(html).toContain("<code>$$</code>");
  });

  it("单个 $ 行不构成公式块", () => {
    expect(renderMarkdown("$x$")).toBe("<p>$x$</p>");
  });
});

describe("IncrementalRenderer", () => {
  it("逐字符追加「段落 + 表格 + 段落」的最终 HTML 与一次性渲染一致", () => {
    const source = ["Paragraph one.", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "Paragraph two."].join("\n");
    const renderer = new IncrementalRenderer();
    let accumulated = "";
    let last = "";
    for (const ch of source) {
      accumulated += ch;
      last = renderer.render(accumulated);
    }
    expect(last).toBe(renderMarkdown(source));
    expect(last).toContain("<table>");
    expect(last).toContain("<p>Paragraph two.</p>");
  });

  it("分割线在增量渲染里同样生效", () => {
    const source = "上\n\n---\n\n下";
    const renderer = new IncrementalRenderer();
    let accumulated = "";
    let last = "";
    for (const ch of source) {
      accumulated += ch;
      last = renderer.render(accumulated);
    }
    expect(last).toBe(renderMarkdown(source));
    expect(last).toBe("<p>上</p><hr><p>下</p>");
  });

  it("含空行的 $$ 块在增量渲染里与一次性渲染一致", () => {
    const source = "上\n\n$$\nE=mc^2\n\nF=ma\n$$\n\n下";
    const renderer = new IncrementalRenderer();
    let accumulated = "";
    let last = "";
    for (const ch of source) {
      accumulated += ch;
      last = renderer.render(accumulated);
    }
    expect(last).toBe(renderMarkdown(source));
    expect(last).toBe('<p>上</p><div class="math">E=mc^2\n\nF=ma</div><p>下</p>');
  });
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const {
  updateStreamText,
  segmentLongMarkdown,
  TEXT_SEGMENT_SIZE,
} = require("../out/webview/longText");

test("bounded streaming preserves complete text, Unicode, prefix nodes and replacement output", () => {
  const dom = new JSDOM("<div></div>");
  const element = dom.window.document.querySelector("div");
  let text = "中文🙂\n".repeat(20000);
  updateStreamText(element, text, "");
  assert.equal(element.textContent, text);
  assert(element.children.length > 4);
  const first = element.firstChild;
  for (let i = 0; i < 200; i++) {
    const next = text + "补充🙂";
    updateStreamText(element, next, text);
    text = next;
  }
  assert.equal(element.textContent, text);
  assert.equal(element.firstChild, first);
  for (const part of element.children) {
    assert(part.textContent.length <= TEXT_SEGMENT_SIZE);
    assert(!/[\uD800-\uDBFF]$/.test(part.textContent));
    assert(!/^[\uDC00-\uDFFF]/.test(part.textContent));
  }
  updateStreamText(element, "replacement", text);
  assert.equal(element.textContent, "replacement");
  updateStreamText(element, "replacement appended", "replacement");
  assert.equal(element.textContent, "replacement appended");
  dom.window.close();
});

test("completed Markdown segmentation retains paragraph/code text and leaves inline markup intact", () => {
  const dom = new JSDOM(
    "<main><p></p><pre><code></code></pre><p id='linked'><a href='file:///a.ts'>a.ts</a></p></main>",
  );
  const main = dom.window.document.querySelector("main");
  main.querySelector("p").textContent = "x".repeat(1000000);
  main.querySelector("code").textContent = "const 中文 = '🙂';\n".repeat(20000);
  const before = main.textContent;
  segmentLongMarkdown(main);
  assert.equal(main.textContent, before);
  assert(main.querySelector("p").children.length > 100);
  assert(main.querySelector("code").children.length > 10);
  assert.equal(
    main.querySelector("#linked a").getAttribute("href"),
    "file:///a.ts",
  );
  const mixed = dom.window.document.createElement("p");
  mixed.innerHTML = "<strong>Heading</strong> <a href='file:///b.ts'>b.ts</a> ";
  mixed.appendChild(
    dom.window.document.createTextNode("mixed text ".repeat(20000)),
  );
  main.appendChild(mixed);
  const original = mixed.textContent;
  segmentLongMarkdown(main);
  assert.equal(mixed.textContent, original);
  assert(mixed.querySelectorAll(".text-segment").length > 10);
  assert.equal(mixed.querySelector("strong").textContent, "Heading");
  assert.equal(mixed.querySelector("a").getAttribute("href"), "file:///b.ts");
  dom.window.close();
});

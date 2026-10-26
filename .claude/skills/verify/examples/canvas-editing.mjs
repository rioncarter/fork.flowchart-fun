// Canvas editing: every canvas action rewrites the document text.
// Covers canvas-add, canvas-connect, canvas-drop-to-add, canvas-rename,
// canvas-edge-label, canvas-delete and canvas-undo from features/canvas-editing.md.

const nodeBox = (page, label) =>
  page.evaluate(
    (l) => window.__cy.nodes().filter((n) => n.data("label") === l)[0]?.renderedBoundingBox({ includeLabels: false }),
    label
  );

async function onCanvas(page, ff, p) {
  const box = await ff.canvas().boundingBox();
  return { x: box.x + p.x, y: box.y + p.y };
}

async function nodeCenter(page, ff, label) {
  const b = await nodeBox(page, label);
  if (!b) throw new Error(`no node ${label}`);
  return onCanvas(page, ff, { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
}

async function dragHandle(page, ff, label, side, to) {
  const from = await nodeCenter(page, ff, label);
  await page.mouse.move(from.x, from.y);
  const handle = page.getByTestId("Connector Handle").nth(side);
  await handle.waitFor();
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(h.x + (to.x - h.x) * (i / 10), h.y + (to.y - h.y) * (i / 10));
  }
  await page.mouse.up();
}

const edges = (g) => g.edges.map((e) => `${e.source} -> ${e.target}${e.label ? ` (${e.label})` : ""}`).sort();
const DOUBLE_CLICK_WINDOW_MS = 400;

export default async ({ page, ff, step, expect }) => {
  step("type a chart");
  await ff.open("/");
  await ff.typeDoc("Start\n  Middle\n    End\nOther");
  await ff.waitForGraph((g) => g.nodes.length === 4);

  step("drag Other's right handle onto Start: a (Start) pointer is written under Other");
  await dragHandle(page, ff, "Other", 1, await nodeCenter(page, ff, "Start"));
  await expect.poll(() => ff.editorText()).toBe("Start\n  Middle\n    End\nOther\n  (Start)");
  expect(edges(await ff.waitForGraph((g) => g.edges.length === 3))).toContain("Other -> Start");

  step("double-click empty canvas, type a label, Enter: a root node appears at the click and the layout freezes");
  const box = await ff.canvas().boundingBox();
  await page.mouse.dblclick(box.x + box.width - 120, box.y + 120);
  await page.getByTestId("Canvas Label Editor").waitFor();
  await page.keyboard.type("Fresh idea");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await ff.editorText()).split("\n").at(-1)).toBe("Fresh idea");
  await expect(page.getByLabel("Layout Frozen")).toHaveAttribute("aria-pressed", "true");

  step("drag a handle of Fresh idea to empty canvas: a new child node is written under it");
  const fresh = await nodeCenter(page, ff, "Fresh idea");
  await dragHandle(page, ff, "Fresh idea", 2, { x: fresh.x, y: fresh.y + 140 });
  await page.getByTestId("Canvas Label Editor").waitFor();
  await page.keyboard.type("Child");
  await page.keyboard.press("Enter");
  await expect.poll(() => ff.editorText()).toContain("Fresh idea\n  Child");

  step("double-click Middle and rename it: the line changes, its edges stay");
  await page.waitForTimeout(DOUBLE_CLICK_WINDOW_MS);
  const middle = await nodeCenter(page, ff, "Middle");
  await page.mouse.dblclick(middle.x, middle.y);
  await page.getByTestId("Canvas Label Editor").waitFor();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Review");
  await page.keyboard.press("Enter");
  await expect.poll(() => ff.editorText()).toContain("Start\n  Review\n    End");

  step("select the Start -> Review edge, Enter, type a label: it is written before the child");
  await page.waitForTimeout(DOUBLE_CLICK_WINDOW_MS);
  const mid = await page.evaluate(() => {
    const cy = window.__cy;
    const e = cy.edges().filter((e) => e.target().data("label") === "Review")[0];
    const m = e.midpoint();
    return { x: m.x * cy.zoom() + cy.pan().x, y: m.y * cy.zoom() + cy.pan().y };
  });
  const edgePt = await onCanvas(page, ff, mid);
  await page.mouse.click(edgePt.x, edgePt.y);
  await page.keyboard.press("Enter");
  await page.getByTestId("Canvas Label Editor").waitFor();
  await page.keyboard.type("yes");
  await page.keyboard.press("Enter");
  await expect.poll(() => ff.editorText()).toContain("Start\n  yes: Review");

  step("select Review and press Delete: End stays, unconnected");
  await page.waitForTimeout(DOUBLE_CLICK_WINDOW_MS);
  const review = await nodeCenter(page, ff, "Review");
  await page.mouse.click(review.x, review.y);
  await page.keyboard.press("Delete");
  await expect.poll(() => ff.editorText()).toBe("Start\nEnd\nOther\n  (Start)\nFresh idea\n  Child");
  const g = await ff.waitForGraph((g) => g.nodes.length === 5);
  expect(edges(g)).toEqual(["Fresh idea -> Child", "Other -> Start"]);
  await ff.shot("after-delete", ff.canvas());

  step("Cmd/Ctrl+Z on the graph undoes the delete");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => ff.editorText()).toContain("Start\n  yes: Review\n    End");
};

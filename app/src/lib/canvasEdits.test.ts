import {
  addNode,
  CanvasEdit,
  connectNodes,
  deleteElements,
  escapeLabel,
  renameNode,
  setEdgeLabel,
} from "./canvasEdits";
import { parseGraph } from "./parseGraph";

/** The graph as labels: nodes (with their container) and edges */
function summary(text: string) {
  const { nodes, edges } = parseGraph(text);
  const label = (id: string) =>
    nodes.find((n) => n.data.id === id)?.data.label ?? id;
  return {
    nodes: nodes
      .map((n) =>
        n.data.parent
          ? `${n.data.label} in ${label(n.data.parent as string)}`
          : n.data.label
      )
      .sort(),
    edges: edges
      .map(
        (e) =>
          `${label(e.source)} -> ${label(e.target)}${
            e.data.label ? ` (${e.data.label})` : ""
          }`
      )
      .sort(),
  };
}

const textOf = (edit: CanvasEdit | null) => {
  if (!edit) throw new Error("edit was refused");
  return edit.text;
};

describe("escapeLabel", () => {
  test.each([
    "plain",
    "has: colon",
    "call (555)",
    "Item #1 .x [y]",
    "https://example.com",
    "open {",
    "two\nlines",
    "a // b",
  ])("%j round-trips through the parser", (label) => {
    const { nodes } = parseGraph(escapeLabel(label));
    expect(nodes.map((n) => n.data.label)).toEqual([label]);
  });
});

describe("addNode", () => {
  test("appends a root node before trailing blank lines", () => {
    const edit = addNode("A\n  B\n\n", { label: "C" });
    expect(edit?.text).toBe("A\n  B\nC\n\n");
    expect(edit?.newLine).toBe(3);
    expect(summary(textOf(edit)).edges).toEqual(["A -> B"]);
  });

  test("adds a child at the end of the parent's subtree", () => {
    const edit = addNode("A\n  B\n    C\nD", { label: "E", parentLine: 1 });
    expect(edit?.text).toBe("A\n  B\n    C\n  E\nD");
    expect(edit?.newLine).toBe(4);
    expect(edit?.lineMap(4)).toBe(5);
    expect(summary(textOf(edit)).edges).toEqual(["A -> B", "A -> E", "B -> C"]);
  });

  test("matches the existing child indentation", () => {
    expect(addNode("A\n    B", { label: "C", parentLine: 1 })?.text).toBe(
      "A\n    B\n    C"
    );
    expect(addNode("A\n\tB\nX", { label: "C", parentLine: 3 })?.text).toBe(
      "A\n\tB\nX\n\tC"
    );
  });

  test("a child of a node in a container stays in the container", () => {
    const text = addNode("Box {\n  A\n}", { label: "B", parentLine: 2 });
    expect(text?.text).toBe("Box {\n  A\n    B\n}");
    expect(summary(textOf(text))).toEqual({
      nodes: ["A in Box", "B in Box", "Box"],
      edges: ["A -> B"],
    });
  });

  test("a child of a container is linked with a pointer", () => {
    const edit = addNode("Box {\n  A\n}", { label: "B", parentLine: 1 });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A in Box", "B", "Box"],
      edges: ["Box -> B"],
    });
    expect(edit?.newLine).toBe(4);
  });

  test("adds into a container", () => {
    const edit = addNode("Box {\n  A\n}\nC", { label: "B", containerLine: 1 });
    expect(edit?.text).toBe("Box {\n  A\n  B\n}\nC");
    expect(summary(textOf(edit)).nodes).toEqual([
      "A in Box",
      "B in Box",
      "Box",
      "C",
    ]);
  });

  test("escapes special characters", () => {
    const edit = addNode("A", { label: "yes: no", parentLine: 1 });
    expect(summary(textOf(edit)).edges).toEqual(["A -> yes: no"]);
  });
});

describe("connectNodes", () => {
  test("adds a label pointer under the source", () => {
    const edit = connectNodes("A\n  B\nC", { sourceLine: 3, targetLine: 1 });
    expect(edit?.text).toBe("A\n  B\nC\n  (A)");
    expect(summary(textOf(edit)).edges).toEqual(["A -> B", "C -> A"]);
  });

  test("uses an existing id", () => {
    const edit = connectNodes("A #a\nC", { sourceLine: 2, targetLine: 1 });
    expect(edit?.text).toBe("A #a\nC\n  (#a)");
  });

  test("gives a duplicated label an id", () => {
    const edit = connectNodes("Step\nStep\nC", {
      sourceLine: 3,
      targetLine: 2,
    });
    expect(edit?.text).toBe("Step\nStep #step\nC\n  (#step)");
    expect(summary(textOf(edit)).edges).toEqual(["C -> Step"]);
  });

  test("gives an unsafe label an id", () => {
    const edit = connectNodes("has\\: colon\nd", {
      sourceLine: 2,
      targetLine: 1,
    });
    expect(edit?.text).toBe("has\\: colon #has-colon\nd\n  (#has-colon)");
    expect(summary(textOf(edit)).edges).toEqual(["d -> has: colon"]);
  });

  test("a container source is linked with a root pointer", () => {
    const edit = connectNodes("Box {\n  A\n}\nC", {
      sourceLine: 1,
      targetLine: 4,
    });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A in Box", "Box", "C"],
      edges: ["Box -> C"],
    });
  });

  test("connects inside the subtree, not after it", () => {
    const edit = connectNodes("A\n  B\n    C\nD", {
      sourceLine: 2,
      targetLine: 4,
    });
    expect(edit?.text).toBe("A\n  B\n    C\n    (D)\nD");
    expect(summary(textOf(edit)).edges).toEqual(["A -> B", "B -> C", "B -> D"]);
  });
});

describe("renameNode", () => {
  test("keeps indentation, edge label, features, brace and comment", () => {
    expect(
      renameNode("A\n  yes: B #b.red // note", { line: 2, label: "C" })?.text
    ).toBe("A\n  yes: C #b.red // note");
    expect(renameNode("Box {\n  A\n}", { line: 1, label: "Group" })?.text).toBe(
      "Group {\n  A\n}"
    );
  });

  test("updates label pointers", () => {
    const edit = renameNode("A\nB\n  (A)", { line: 1, label: "Z" });
    expect(edit?.text).toBe("Z\nB\n  (Z)");
    expect(summary(textOf(edit)).edges).toEqual(["B -> Z"]);
  });

  test("switches pointers to an id when the new label would be ambiguous", () => {
    const edit = renameNode("A\nB\n  (A)\nZ", { line: 1, label: "Z" });
    expect(summary(textOf(edit)).edges).toEqual(["B -> Z"]);
    expect(parseGraph(textOf(edit)).edges[0].target).toBe("z");
  });

  test("writes newlines as \\n", () => {
    const edit = renameNode("A", { line: 1, label: "two\nlines" });
    expect(edit?.text).toBe("two\\nlines");
    expect(summary(textOf(edit)).nodes).toEqual(["two\nlines"]);
  });
});

describe("setEdgeLabel", () => {
  test("adds, replaces and removes a label", () => {
    expect(setEdgeLabel("A\n  B", { line: 2, label: "yes" })?.text).toBe(
      "A\n  yes: B"
    );
    expect(setEdgeLabel("A\n  yes: B", { line: 2, label: "no" })?.text).toBe(
      "A\n  no: B"
    );
    expect(setEdgeLabel("A\n  yes: B", { line: 2, label: "" })?.text).toBe(
      "A\n  B"
    );
  });

  test("keeps edge classes", () => {
    const edit = setEdgeLabel("A\n  .red yes: B", { line: 2, label: "no" });
    expect(edit?.text).toBe("A\n  .red no: B");
    expect(parseGraph(textOf(edit)).edges[0].data.classes).toBe(".red");
  });

  test("labels a pointer edge", () => {
    const edit = setEdgeLabel("A\nB\n  (A)", { line: 3, label: "back" });
    expect(summary(textOf(edit)).edges).toEqual(["B -> A (back)"]);
  });

  test("refuses a root line", () => {
    expect(setEdgeLabel("A", { line: 1, label: "x" })).toBeNull();
  });
});

describe("deleteElements", () => {
  test("deleting a leaf removes its line", () => {
    const edit = deleteElements("A\n  B\n  C", { nodeLines: [2] });
    expect(edit?.text).toBe("A\n  C");
    expect(edit?.lineMap(3)).toBe(2);
    expect(edit?.lineMap(2)).toBeUndefined();
  });

  test("children of a deleted node become unconnected roots", () => {
    const edit = deleteElements("A\n  B\n    yes: C\n      D\n  E", {
      nodeLines: [2],
    });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A", "C", "D", "E"],
      edges: ["A -> E", "C -> D"],
    });
  });

  test("children of a deleted root stay in place", () => {
    const edit = deleteElements("A\n  B\n  C\nD", { nodeLines: [1] });
    expect(edit?.text).toBe("B\nC\nD");
  });

  test("removes pointers to the deleted node", () => {
    const edit = deleteElements("A\nB\n  (A)\nC #c\n  (#c)\n  (A)", {
      nodeLines: [1, 4],
    });
    expect(summary(textOf(edit))).toEqual({ nodes: ["B"], edges: [] });
  });

  test("keeps pointers that also reach another node with the label", () => {
    const edit = deleteElements("A\nA\nB\n  (A)", { nodeLines: [1] });
    expect(summary(textOf(edit)).edges).toEqual(["B -> A"]);
  });

  test("deleting a container keeps its contents", () => {
    const edit = deleteElements("X\n  Box {\n    A\n      B\n  }\n  Y", {
      nodeLines: [2],
    });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A", "B", "X", "Y"],
      edges: ["A -> B", "X -> Y"],
    });
  });

  test("deleting an indentation edge detaches the child subtree", () => {
    const edit = deleteElements("A\n  B\n    yes: C\n      D\n  E", {
      edgeLines: [3],
    });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A", "B", "C", "D", "E"],
      edges: ["A -> B", "A -> E", "C -> D"],
    });
  });

  test("deleting an edge inside a container keeps the child in it", () => {
    const edit = deleteElements("Box {\n  A\n    B\n}", { edgeLines: [3] });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A in Box", "B in Box", "Box"],
      edges: [],
    });
  });

  test("deleting a pointer edge removes the pointer line", () => {
    const edit = deleteElements("A\nB\n  (A)\n  C", { edgeLines: [3] });
    expect(edit?.text).toBe("A\nB\n  C");
  });

  test("deleting a pointer edge with children keeps the children's edges", () => {
    const edit = deleteElements("A\nB\n  (A)\n    C", { edgeLines: [3] });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A", "B", "C"],
      edges: ["A -> C"],
    });
  });

  test("deletes several elements at once", () => {
    const edit = deleteElements("A\n  B\n  C\n    D\nE\n  (A)", {
      nodeLines: [2],
      edgeLines: [3, 6],
    });
    expect(summary(textOf(edit))).toEqual({
      nodes: ["A", "C", "D", "E"],
      edges: ["C -> D"],
    });
  });
});

describe("on every template", () => {
  const templates = [
    "blueprint",
    "constellation",
    "decision-tree",
    "default",
    "ink-mindmap",
    "org-chart",
    "process-lanes",
    "sitemap",
    "storyline",
    "timeline",
  ].map((name) => ({
    name,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    content: require(`./templates/${name}-template`).content as string,
  }));

  /** Line-independent identity: explicit ids, else labels */
  function shape(text: string) {
    const { nodes, edges } = parseGraph(text);
    const keyOf = (id: string) => {
      const node = nodes.find((n) => n.data.id === id);
      return /^n\d+$/.test(id) ? `"${node?.data.label}"` : `#${id}`;
    };
    return {
      nodes: nodes
        .map((n) => {
          const parent = n.data.parent as string | undefined;
          return `${keyOf(n.data.id)}${parent ? ` in ${keyOf(parent)}` : ""}`;
        })
        .sort(),
      edges: edges
        .map((e) => `${keyOf(e.source)} -> ${keyOf(e.target)} ${e.data.label}`)
        .sort(),
      keyOf,
      raw: { nodes, edges },
    };
  }
  const without = (list: string[], remove: string[]) => {
    const out = [...list];
    for (const r of remove) {
      const i = out.indexOf(r);
      if (i > -1) out.splice(i, 1);
    }
    return out;
  };

  test.each(templates)(
    "deleting any edge removes only it: $name",
    ({ content }) => {
      const before = shape(content);
      for (const edge of before.raw.edges) {
        const line = edge.parser?.lineNumber as number;
        const after = shape(
          textOf(deleteElements(content, { edgeLines: [line] }))
        );
        const gone = before.raw.edges
          .filter((e) => e.parser?.lineNumber === line)
          .map(
            (e) =>
              `${before.keyOf(e.source)} -> ${before.keyOf(e.target)} ${
                e.data.label
              }`
          );
        expect({ line, edges: after.edges, nodes: after.nodes }).toEqual({
          line,
          edges: without(before.edges, gone),
          nodes: before.nodes,
        });
      }
    }
  );

  test.each(templates)(
    "deleting any node removes it and its edges only: $name",
    ({ content }) => {
      const before = shape(content);
      for (const node of before.raw.nodes) {
        const line = node.parser?.lineNumber as number;
        const key = before.keyOf(node.data.id);
        const after = shape(
          textOf(deleteElements(content, { nodeLines: [line] }))
        );
        const parent = node.data.parent as string | undefined;
        const expectedNodes = before.raw.nodes
          .filter((n) => n !== node)
          .map((n) => {
            let p = n.data.parent as string | undefined;
            if (p === node.data.id) p = parent;
            return `${before.keyOf(n.data.id)}${
              p ? ` in ${before.keyOf(p)}` : ""
            }`;
          })
          .sort();
        expect({ line, nodes: after.nodes }).toEqual({
          line,
          nodes: expectedNodes,
        });
        expect({ line, edges: after.edges }).toEqual({
          line,
          edges: before.edges.filter(
            (e) => !e.startsWith(`${key} ->`) && !e.includes(`-> ${key} `)
          ),
        });
      }
    }
  );

  test.each(templates)(
    "connecting any two nodes adds one edge: $name",
    ({ content }) => {
      const before = shape(content);
      const nodes = before.raw.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const source = nodes[i];
        const target = nodes[(i * 7 + 3) % nodes.length];
        const edit = connectNodes(content, {
          sourceLine: source.parser?.lineNumber as number,
          targetLine: target.parser?.lineNumber as number,
        });
        const after = shape(textOf(edit));
        // A connect may add an #id to the target, which renames its key
        const { edges } = after;
        expect(edges.length).toBe(before.edges.length + 1);
        expect(after.raw.nodes.map((n) => n.data.label).sort()).toEqual(
          nodes.map((n) => n.data.label).sort()
        );
      }
    }
  );

  test.each(templates)(
    "renaming any node keeps its edges: $name",
    ({ content }) => {
      const before = shape(content);
      for (const node of before.raw.nodes) {
        const line = node.parser?.lineNumber as number;
        const after = parseGraph(
          textOf(renameNode(content, { line, label: "Renamed: (x)" }))
        );
        const renamed = after.nodes.find((n) => n.parser?.lineNumber === line);
        expect(renamed?.data.label).toBe("Renamed: (x)");
        const degree = (g: typeof after, id: string) =>
          g.edges.filter((e) => e.source === id || e.target === id).length;
        expect({ line, degree: degree(after, renamed!.data.id) }).toEqual({
          line,
          degree: degree(before.raw, node.data.id),
        });
        expect(after.edges.length).toBe(before.raw.edges.length);
      }
    }
  );
});

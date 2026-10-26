import { parseGraph } from "./parseGraph";
import { stripComments } from "./utils";

/**
 * Text rewrites behind the canvas editor. Each one takes the document text
 * and returns new text that parses into the graph the canvas action asked
 * for, touching as few lines as it can so the user's formatting survives.
 *
 * Lines carry a stable key (their 1-based line number in the input, or a
 * fresh negative key when inserted) so `lineMap` can tell the caller where
 * every original line ended up. Node ids are positional (`n<line>`), so the
 * caller uses it to re-key stored node positions.
 */
export type CanvasEdit = {
  text: string;
  /** Maps an input line number to its line number in `text`, if it survives */
  lineMap: (line: number) => number | undefined;
  /** The line number in `text` of a node this edit created */
  newLine?: number;
};

type Line = { key: number; raw: string };

/** Splits a line the way graph-selector reads it */
type LineParts = {
  indent: string;
  /** Everything before the label, including the `: ` separator, or "" */
  edgePrefix: string;
  label: string;
  /** `#id.class[attr]`, with its leading whitespace, or "" */
  features: string;
  /** "{" when the line opens a container */
  brace: string;
  /** Trailing comment (and whitespace before it), or "" */
  rest: string;
};

const linesAsGraphSelectorReadsThem = (text: string) =>
  stripComments(text.replace(/(https?:)\/\//g, "$1\\/\\/"))
    .split("\n")
    .map((line) => line.replace(/(https?:)\\\/\\\//g, "$1//"));

const indentOf = (code: string) => code.length - code.trimStart().length;
const isBlank = (code: string) => code.trim() === "";
const opensContainer = (code: string) => code[code.length - 1] === "{";
const closesContainer = (code: string) => /^\s*\}/.test(code);
/** Index just past the `: ` that ends an edge label, or -1 */
const edgeBreakEnd = (code: string) => {
  const m = /[^\\](: |：)/.exec(code);
  return m ? m.index + m[0].length : -1;
};
const featuresIndex = (s: string) => {
  const m = /(^|\s)(#|\.|\[)/.exec(s);
  return m?.index ?? s.length;
};
const pointerOf = (label: string) => /^[(（]([^)）]+)[)）]$/.exec(label)?.[1];

const NEW_KEY_START = -1;

class Lines {
  lines: Line[];
  private nextKey = NEW_KEY_START;

  constructor(text: string) {
    this.lines = text.split("\n").map((raw, i) => ({ key: i + 1, raw }));
  }

  get text() {
    return this.lines.map((l) => l.raw).join("\n");
  }

  /** Comment-stripped lines, as the parser sees them */
  code() {
    return linesAsGraphSelectorReadsThem(this.text);
  }

  indexOf(key: number) {
    return this.lines.findIndex((l) => l.key === key);
  }

  insert(index: number, raws: string[]) {
    const created = raws.map((raw) => ({ key: this.nextKey--, raw }));
    this.lines.splice(index, 0, ...created);
    return created.map((l) => l.key);
  }

  remove(index: number, count = 1) {
    return this.lines.splice(index, count);
  }

  parts(index: number): LineParts | null {
    const raw = this.lines[index].raw;
    const code = this.code()[index];
    const codeEnd = code.trimEnd();
    if (!raw.startsWith(codeEnd)) return null;
    const rest = raw.slice(codeEnd.length);
    let body = codeEnd;
    let brace = "";
    if (opensContainer(code)) {
      brace = "{";
      body = body.slice(0, -1);
    }
    const indent = body.slice(0, indentOf(body));
    let edgePrefix = "";
    const breakEnd = edgeBreakEnd(body);
    if (breakEnd > -1) {
      edgePrefix = body.slice(indent.length, breakEnd);
      body = body.slice(breakEnd);
    } else {
      body = body.slice(indent.length);
    }
    const leading = body.slice(0, indentOf(body));
    body = body.slice(leading.length);
    edgePrefix += leading;
    const at = featuresIndex(body);
    const labelEnd = body.slice(0, at).trimEnd().length;
    return {
      indent,
      edgePrefix,
      label: body.slice(0, labelEnd),
      features: body.slice(labelEnd),
      brace,
      rest,
    };
  }

  setParts(index: number, parts: LineParts) {
    const { indent, edgePrefix, label, features, brace, rest } = parts;
    let raw = indent + edgePrefix + label + features;
    if (brace) raw = (raw.trimEnd() ? raw.trimEnd() + " " : raw) + brace;
    this.lines[index].raw = raw + rest;
  }

  /** Exclusive end of the block that line `i` heads: its subtree, or its container */
  blockEnd(i: number, code = this.code()) {
    if (opensContainer(code[i])) {
      let depth = 0;
      for (let j = i; j < code.length; j++) {
        if (closesContainer(code[j])) depth--;
        if (opensContainer(code[j])) depth++;
        if (depth === 0) return j + 1;
      }
      return code.length;
    }
    const own = indentOf(code[i]);
    let depth = 0;
    let last = i;
    for (let j = i + 1; j < code.length; j++) {
      if (isBlank(code[j])) continue;
      if (depth === 0 && (closesContainer(code[j]) || indentOf(code[j]) <= own))
        break;
      if (closesContainer(code[j])) depth--;
      if (opensContainer(code[j])) depth++;
      last = j;
    }
    return last + 1;
  }

  /** The line the parser draws an implicit edge into line `i` from */
  parentOf(i: number, code = this.code()) {
    const own = indentOf(code[i]);
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (isBlank(code[j])) continue;
      if (closesContainer(code[j])) {
        depth++;
        if (!opensContainer(code[j])) continue;
      }
      if (opensContainer(code[j])) {
        if (depth === 0) return undefined; // reached the enclosing container
        depth--;
        if (depth > 0) continue;
      } else if (depth > 0) continue;
      if (indentOf(code[j]) < own) return j;
    }
    return undefined;
  }

  rootOf(i: number, code = this.code()) {
    let root = i;
    let parent: number | undefined;
    while ((parent = this.parentOf(root, code)) !== undefined) root = parent;
    return root;
  }

  indentUnit() {
    const indented = this.code().find((c) => !isBlank(c) && indentOf(c) > 0);
    return indented?.startsWith("\t") ? "\t" : "  ";
  }

  /** Indentation for a new child of line `i` */
  childIndent(i: number) {
    const code = this.code();
    const own = code[i].slice(0, indentOf(code[i]));
    const next = code
      .slice(i + 1, this.blockEnd(i, code))
      .find((c) => !isBlank(c));
    if (next && indentOf(next) > own.length && !opensContainer(code[i]))
      return next.slice(0, indentOf(next));
    return own + this.indentUnit();
  }

  /**
   * Moves line `i` and its subtree out from under its parent, so nothing
   * draws an implicit edge into it. The block lands right after its root
   * ancestor's block, at that root's indentation, in the same container.
   */
  detach(i: number) {
    const code = this.code();
    if (this.parentOf(i, code) === undefined) return;
    const root = this.rootOf(i, code);
    const rootKey = this.lines[root].key;
    const shift = indentOf(code[i]) - indentOf(code[root]);
    const removed = this.remove(i, this.blockEnd(i, code) - i);
    const block = removed.map((line) => ({
      ...line,
      raw: dedent(line.raw, shift),
    }));
    const rootIndex = this.indexOf(rootKey);
    const at = this.blockEnd(rootIndex);
    this.lines.splice(at, 0, ...block);
    this.stripEdgePrefix(at);
  }

  stripEdgePrefix(i: number) {
    const parts = this.parts(i);
    if (parts?.edgePrefix) this.setParts(i, { ...parts, edgePrefix: "" });
  }

  /**
   * Deletes the node (or pointer) on line `i`. Its children are not handed
   * to whatever is above it: they become roots, unconnected.
   */
  deleteLine(i: number) {
    let code = this.code();
    const key = this.lines[i].key;
    // Children declared after a container's closing brace hang off the container too
    const groups: number[][] = [];
    const end = this.blockEnd(i, code);
    if (opensContainer(code[i])) {
      groups.push(keysIn(this.lines, i + 1, end - 1));
      const tailEnd = this.blockEndFrom(end - 1, indentOf(code[i]), code);
      groups.push(keysIn(this.lines, end, tailEnd));
      this.remove(end - 1); // the closing brace
    } else {
      groups.push(keysIn(this.lines, i + 1, end));
    }
    code = this.code();
    const parent = this.parentOf(i, code);
    const rootKey =
      parent === undefined ? undefined : this.lines[this.rootOf(i, code)].key;
    const ownIndent = indentOf(code[i]);
    const targetIndent =
      rootKey === undefined ? ownIndent : indentOf(code[this.indexOf(rootKey)]);
    this.remove(this.indexOf(key));

    for (const keys of groups) {
      if (!keys.length) continue;
      code = this.code();
      const indices = keys.map((k) => this.indexOf(k));
      const base = Math.min(
        ...indices
          .filter((x) => !isBlank(code[x]))
          .map((x) => indentOf(code[x]))
      );
      if (!isFinite(base)) continue;
      const first = indices[0];
      const block = this.remove(first, indices.length).map((line) => ({
        ...line,
        raw: dedent(line.raw, base - targetIndent),
      }));
      const at =
        rootKey === undefined ? first : this.blockEnd(this.indexOf(rootKey));
      this.lines.splice(at, 0, ...block);
      code = this.code();
      for (let x = at; x < at + block.length; x++) {
        if (!isBlank(code[x]) && indentOf(code[x]) === targetIndent)
          this.stripEdgePrefix(x);
      }
    }
  }

  private blockEndFrom(after: number, indent: number, code: string[]) {
    let last = after;
    for (let j = after + 1; j < code.length; j++) {
      if (isBlank(code[j])) continue;
      if (closesContainer(code[j]) || indentOf(code[j]) <= indent) break;
      last = j;
    }
    return last + 1;
  }

  result(newKey?: number): CanvasEdit {
    const byKey = new Map(this.lines.map((l, i) => [l.key, i + 1]));
    return {
      text: this.text,
      lineMap: (line) => byKey.get(line),
      newLine: newKey === undefined ? undefined : byKey.get(newKey),
    };
  }
}

function keysIn(lines: Line[], from: number, to: number) {
  return lines.slice(from, to).map((l) => l.key);
}

function dedent(raw: string, by: number) {
  const ws = raw.length - raw.trimStart().length;
  return raw.slice(Math.min(by, ws));
}

/** Writes a label so the parser reads it back unchanged */
export function escapeLabel(label: string) {
  let out = label
    .trim()
    .replace(/\r?\n/g, "\\n")
    .replace(/([:：])(?= )/g, "\\$1")
    .replace(/[()（）[\]]/g, "\\$&")
    .replace(/\/\//g, "\\/\\/")
    .replace(/(^|\s)([#.])/g, "$1\\$2");
  if (out.endsWith("{")) out = out.slice(0, -1) + "\\{ ";
  return out;
}

/** Labels that can be written as a `(label)` pointer unchanged */
const isPointerSafe = (label: string) =>
  !!label.trim() &&
  label === label.trim() &&
  !/[:：()（）\\/{}[\]\n]/.test(label) &&
  !/(^|\s)[#.]/.test(label);

type GraphInfo = ReturnType<typeof graphInfo>;

function graphInfo(text: string) {
  const graph = parseGraph(text);
  const labelCount = new Map<string, number>();
  for (const { data } of [...graph.nodes, ...graph.edges]) {
    labelCount.set(data.label, (labelCount.get(data.label) ?? 0) + 1);
  }
  return {
    graph,
    labelCount,
    ids: new Set(graph.nodes.map((n) => n.data.id)),
    nodeOnLine: (line: number) =>
      graph.nodes.find((n) => n.parser?.lineNumber === line),
  };
}

/** A pointer that reaches exactly this node, adding an `#id` to it if needed */
function pointerTo(lines: Lines, info: GraphInfo, line: number) {
  const node = info.nodeOnLine(line);
  const index = lines.indexOf(line);
  if (!node || index < 0 || !lines.parts(index)) return null;
  const { label } = node.data;
  if (
    !explicitIdOf(lines, index) &&
    isPointerSafe(label) &&
    info.labelCount.get(label) === 1
  )
    return `(${label})`;
  return `(#${ensureId(lines, info, index)})`;
}

function explicitIdOf(lines: Lines, index: number) {
  const parts = lines.parts(index);
  return parts ? /#([\w-]+)/.exec(parts.features)?.[1] : undefined;
}

/** The node's `#id`, writing a new one onto its line if it has none */
function ensureId(lines: Lines, info: GraphInfo, index: number) {
  const existing = explicitIdOf(lines, index);
  if (existing) return existing;
  const parts = lines.parts(index) as LineParts;
  const id = uniqueId(parts.label || "node", info.ids);
  info.ids.add(id);
  lines.setParts(index, { ...parts, features: ` #${id}${parts.features}` });
  return id;
}

function uniqueId(label: string, ids: Set<string>) {
  const slug =
    label
      .toLowerCase()
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "node";
  let id = /^\d/.test(slug) ? `n-${slug}` : slug;
  for (let i = 2; ids.has(id) || /^n\d+$/.test(id); i++) id = `${slug}-${i}`;
  return id;
}

/**
 * Adds a node. With `parentLine` it is drawn as a child of that node (an
 * edge from it); with `containerLine` it goes inside that container;
 * otherwise it is appended as a new root at the end of the document.
 */
export function addNode(
  text: string,
  {
    label,
    parentLine,
    containerLine,
  }: { label: string; parentLine?: number; containerLine?: number }
): CanvasEdit | null {
  const lines = new Lines(text);
  const written = escapeLabel(label);
  if (!written) return null;

  if (parentLine !== undefined) {
    const p = lines.indexOf(parentLine);
    if (p < 0) return null;
    const code = lines.code();
    if (opensContainer(code[p])) {
      // A line indented inside a container is not its child, so link by pointer
      const added = addNode(text, { label });
      if (!added || added.newLine === undefined) return null;
      const linked = connectNodes(added.text, {
        sourceLine: parentLine,
        targetLine: added.newLine,
      });
      if (!linked) return null;
      return {
        text: linked.text,
        lineMap: (line) => {
          const mid = added.lineMap(line);
          return mid === undefined ? undefined : linked.lineMap(mid);
        },
        newLine: linked.lineMap(added.newLine),
      };
    }
    const indent = lines.childIndent(p);
    const [key] = lines.insert(lines.blockEnd(p, code), [indent + written]);
    return lines.result(key);
  }

  if (containerLine !== undefined) {
    const c = lines.indexOf(containerLine);
    if (c < 0) return null;
    const code = lines.code();
    if (!opensContainer(code[c])) return null;
    const close = lines.blockEnd(c, code) - 1;
    const inner = code.slice(c + 1, close).filter((x) => !isBlank(x));
    const indent = inner.length
      ? inner
          .map((x) => x.slice(0, indentOf(x)))
          .reduce((a, b) => (b.length < a.length ? b : a))
      : lines.childIndent(c);
    const at = closesContainer(code[close]) ? close : close + 1;
    const [key] = lines.insert(at, [indent + written]);
    return lines.result(key);
  }

  // Append, skipping trailing blank lines so the node sits with the rest
  let at = lines.lines.length;
  while (at > 0 && isBlank(lines.lines[at - 1].raw)) at--;
  const [key] = lines.insert(at, [written]);
  return lines.result(key);
}

/** Draws an edge from the node on `sourceLine` to the node on `targetLine` */
export function connectNodes(
  text: string,
  { sourceLine, targetLine }: { sourceLine: number; targetLine: number }
): CanvasEdit | null {
  const lines = new Lines(text);
  const info = graphInfo(text);
  if (!info.nodeOnLine(sourceLine) || !info.nodeOnLine(targetLine)) return null;
  const target = pointerTo(lines, info, targetLine);
  if (!target) return null;
  const s = lines.indexOf(sourceLine);
  const code = lines.code();
  if (opensContainer(code[s])) {
    // Lines indented inside a container are its contents, not its children,
    // so the edge comes from a root pointer appended to the document
    const source = pointerTo(lines, info, sourceLine);
    if (!source) return null;
    let at = lines.lines.length;
    while (at > 0 && isBlank(lines.lines[at - 1].raw)) at--;
    lines.insert(at, [source, lines.indentUnit() + target]);
    return lines.result();
  }
  lines.insert(lines.blockEnd(s, code), [lines.childIndent(s) + target]);
  return lines.result();
}

/** Renames the node on `line`, keeping `(label)` pointers to it working */
export function renameNode(
  text: string,
  { line, label }: { line: number; label: string }
): CanvasEdit | null {
  const lines = new Lines(text);
  const info = graphInfo(text);
  const node = info.nodeOnLine(line);
  const index = lines.indexOf(line);
  const parts = index > -1 ? lines.parts(index) : null;
  if (!node || !parts) return null;
  const written = escapeLabel(label);
  if (!written && !parts.features && !parts.brace) return null;

  const old = node.data.label;
  const code = lines.code();
  const pointerLines = isPointerSafe(old)
    ? lines.lines.flatMap((_, i) => {
        const p = i === index || isBlank(code[i]) ? null : lines.parts(i);
        return p && pointerOf(p.label) === old ? [i] : [];
      })
    : [];
  const sharedOld = (info.labelCount.get(old) ?? 0) > 1;

  lines.setParts(index, { ...parts, label: written });
  if (pointerLines.length && !sharedOld) {
    const newLabel = label.trim();
    const pointer =
      isPointerSafe(newLabel) && !info.labelCount.has(newLabel)
        ? `(${newLabel})`
        : `(#${ensureId(lines, info, index)})`;
    for (const i of pointerLines) {
      const p = lines.parts(i);
      if (p) lines.setParts(i, { ...p, label: pointer });
    }
  }
  return lines.result();
}

/** Sets (or with "" removes) the label of the edge drawn by `line` */
export function setEdgeLabel(
  text: string,
  { line, label }: { line: number; label: string }
): CanvasEdit | null {
  const lines = new Lines(text);
  const index = lines.indexOf(line);
  const parts = index > -1 ? lines.parts(index) : null;
  if (!parts) return null;
  if (lines.parentOf(index) === undefined) return null;
  // Keep any #id.class[attr] on the edge; the parser reads them before its label
  const prefix = parts.edgePrefix.replace(/[:：]\s*$/, "").trim();
  const features =
    /^(#[\w-]+)?(\.[a-zA-Z][\w-]*)*(\[[^\]]*\])*/.exec(prefix)?.[0] ?? "";
  const written = escapeLabel(label);
  const edgePrefix =
    written || features
      ? [features, written].filter(Boolean).join(" ") + ": "
      : "";
  lines.setParts(index, { ...parts, edgePrefix });
  return lines.result();
}

/**
 * Deletes nodes and edges, identified by the line that declares them. A
 * deleted node takes its incoming and outgoing edges with it; its children
 * stay in the chart, unconnected. Pointers that only reached a deleted node
 * are removed.
 */
export function deleteElements(
  text: string,
  {
    nodeLines = [],
    edgeLines = [],
  }: { nodeLines?: number[]; edgeLines?: number[] }
): CanvasEdit | null {
  const lines = new Lines(text);
  const info = graphInfo(text);
  const code = lines.code();

  const pointerKeys = new Set<number>();
  for (const line of nodeLines) {
    const node = info.nodeOnLine(line);
    if (!node) continue;
    const index = lines.indexOf(line);
    const explicitId = explicitIdOf(lines, index);
    const { label } = node.data;
    const uniqueLabel = info.labelCount.get(label) === 1;
    lines.lines.forEach((l, i) => {
      if (i === index || isBlank(code[i])) return;
      const p = lines.parts(i);
      const pointer = p && pointerOf(p.label);
      if (!pointer) return;
      if (pointer === `#${explicitId}` || (uniqueLabel && pointer === label))
        pointerKeys.add(l.key);
    });
  }

  const edgeKeys = new Set(
    edgeLines.filter(
      (line) => !nodeLines.includes(line) && !pointerKeys.has(line)
    )
  );
  for (const key of edgeKeys) {
    const i = lines.indexOf(key);
    if (i < 0) continue;
    const parts = lines.parts(i);
    const isPointerLine = parts && pointerOf(parts.label) && !parts.features;
    const hasChildren = lines.blockEnd(i) > i + 1;
    if (isPointerLine && !hasChildren) lines.remove(i);
    else lines.detach(i);
  }

  for (const key of [...nodeLines, ...pointerKeys]) {
    const i = lines.indexOf(key);
    if (i < 0) continue;
    lines.deleteLine(i);
  }

  return lines.result();
}

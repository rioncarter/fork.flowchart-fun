import { t } from "@lingui/macro";
import { Core, EdgeSingular, NodeSingular } from "cytoscape";
import {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  applyCanvasEdit,
  canEditCanvas,
  startEditingLabel,
  stopEditingLabel,
  useCanvasEditor,
} from "../lib/canvasActions";
import {
  addNode,
  connectNodes,
  deleteElements,
  renameNode,
  setEdgeLabel,
} from "../lib/canvasEdits";
import { useCanEdit } from "../lib/hooks";
import { isTypingTarget } from "../lib/isTypingTarget";
import { useDoc } from "../lib/useDoc";
import { usePromptStore } from "../lib/usePromptStore";

type Point = { x: number; y: number };
type Box = { x1: number; y1: number; x2: number; y2: number };

const HANDLE_OFFSET = 10;
const HIDE_DELAY_MS = 400;
/** A connector dropped closer than this to where it started is a cancel */
const MIN_NEW_NODE_DRAG_PX = 30;

const contains = (b: Box, p: Point) =>
  p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2;
const area = (b: Box) => (b.x2 - b.x1) * (b.y2 - b.y1);

/** The innermost node under a rendered point, leaves before containers */
function nodeAt(cy: Core, p: Point, except?: string) {
  const hits = cy
    .nodes()
    .filter((n) => n.id() !== except && contains(boundsOf(n), p))
    .toArray() as NodeSingular[];
  hits.sort(
    (a, b) =>
      Number(a.isParent()) - Number(b.isParent()) ||
      area(boundsOf(a)) - area(boundsOf(b))
  );
  return hits[0] as NodeSingular | undefined;
}

const boundsOf = (node: NodeSingular): Box =>
  node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });

const toModel = (cy: Core, p: Point): Point => {
  const pan = cy.pan();
  const zoom = cy.zoom();
  return { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
};

/** Adds a node at a model position, inside the innermost container there */
export function addNodeAt(position: Point) {
  const cy = window.__cy;
  if (!cy || !canEditCanvas()) return;
  const container = cy
    .nodes(":parent")
    .filter((n) => contains(n.boundingBox({ includeLabels: false }), position))
    .toArray()
    .sort(
      (a, b) =>
        area(a.boundingBox({ includeLabels: false })) -
        area(b.boundingBox({ includeLabels: false }))
    )[0];
  const id = applyCanvasEdit(
    addNode(useDoc.getState().text, {
      label: t`New node`,
      containerLine: container?.data("lineNumber"),
    }),
    { place: position }
  );
  if (id) startEditingLabel({ type: "node", id });
}

/** Model px from a container's top edge that count as its title */
const CONTAINER_TITLE_BAND = 40;

/**
 * Double-click on a node or edge: edit its label, except in the body of a
 * container, where it adds a node like a double-click on empty canvas
 */
export function editOnCanvas(
  element: NodeSingular | EdgeSingular,
  position: Point
) {
  if (element.isNode() && element.isParent()) {
    const top = element.boundingBox({ includeLabels: false }).y1;
    if (position.y > top + CONTAINER_TITLE_BAND) {
      addNodeAt(position);
      return;
    }
  }
  startEditingLabel({
    type: element.isNode() ? "node" : "edge",
    id: element.id(),
  });
}

/** Adds a node in the middle of the visible canvas */
export function addNodeAtCenter() {
  const cy = window.__cy;
  if (!cy) return;
  addNodeAt(toModel(cy, { x: cy.width() / 2, y: cy.height() / 2 }));
}

function deleteSelection(cy: Core) {
  const selected = cy.$(":selected");
  const nodeLines = selected.nodes().map((n) => n.data("lineNumber"));
  const edgeLines = selected.edges().map((e) => e.data("lineNumber"));
  if (!nodeLines.length && !edgeLines.length) return false;
  // Ids are positional, so a kept selection would land on other elements
  selected.unselect();
  applyCanvasEdit(
    deleteElements(useDoc.getState().text, { nodeLines, edgeLines })
  );
  return true;
}

/**
 * The drag-and-drop layer over the graph: connector handles on the hovered
 * node, inline label editing, double-click to add, and Delete to remove.
 * Every action rewrites the document text, so the editor and the graph
 * stay in step whichever one the user works in.
 */
export function CanvasEditor({ cy }: { cy: Core }) {
  const canEdit = useCanEdit();
  const diff = usePromptStore((s) => s.diff);
  const enabled = canEdit === true && !diff;
  const editing = useCanvasEditor((s) => s.editing);
  const overlay = useRef<HTMLDivElement>(null);

  // Re-render when the picture moves so handles and the editor track it
  const [, setTick] = useState(0);
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    cy.on("viewport position add remove data layoutstop resize", bump);
    return () => {
      cancelAnimationFrame(frame);
      cy.off("viewport position add remove data layoutstop resize", bump);
    };
  }, [cy]);

  useEffect(() => {
    useCanvasEditor.setState({ enabled });
    if (!enabled) stopEditingLabel();
  }, [enabled]);

  // Hovered node, kept briefly so the pointer can travel onto a handle
  const [hovered, setHovered] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const hideTimer = useRef<number>();
  const keepHandles = useCallback(
    () => window.clearTimeout(hideTimer.current),
    []
  );
  const releaseHandles = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(
      () => setHovered(null),
      HIDE_DELAY_MS
    );
  }, []);
  useEffect(() => {
    const over = (e: cytoscape.EventObject) => {
      keepHandles();
      setHovered(e.target.id());
    };
    const grab = () => setGrabbing(true);
    const free = () => setGrabbing(false);
    cy.on("mouseover", "node", over);
    cy.on("mouseout", "node", releaseHandles);
    cy.on("grab", "node", grab);
    cy.on("free", "node", free);
    return () => {
      cy.off("mouseover", "node", over);
      cy.off("mouseout", "node", releaseHandles);
      cy.off("grab", "node", grab);
      cy.off("free", "node", free);
      window.clearTimeout(hideTimer.current);
    };
  }, [cy, keepHandles, releaseHandles]);

  // Double-click empty canvas to add a node there
  useEffect(() => {
    const onDblClick = (e: cytoscape.EventObject) => {
      if (e.target !== cy) return;
      addNodeAt(e.position);
    };
    cy.on("dblclick", onDblClick);
    return () => {
      cy.off("dblclick", onDblClick);
    };
  }, [cy]);

  // Delete removes the selection; Enter or F2 edits the selected label
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || !canEditCanvas()) return;
      if (useCanvasEditor.getState().editing) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (deleteSelection(cy)) event.preventDefault();
      } else if (event.key === "Enter" || event.key === "F2") {
        const selected = cy.$(":selected");
        if (selected.length !== 1) return;
        event.preventDefault();
        startEditingLabel({
          type: selected.isNode() ? "node" : "edge",
          id: selected.id(),
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cy]);

  // Connector drag
  const [connecting, setConnecting] = useState<{
    source: string;
    from: Point;
    to: Point;
    target?: string;
  } | null>(null);

  const offset = useCallback(() => {
    const cyBox = cy.container()?.getBoundingClientRect();
    const own = overlay.current?.getBoundingClientRect();
    return {
      x: (cyBox?.left ?? 0) - (own?.left ?? 0),
      y: (cyBox?.top ?? 0) - (own?.top ?? 0),
      left: cyBox?.left ?? 0,
      top: cyBox?.top ?? 0,
    };
  }, [cy]);

  const startConnecting = (
    event: ReactPointerEvent,
    source: NodeSingular,
    from: Point
  ) => {
    event.preventDefault();
    event.stopPropagation();
    keepHandles();
    setConnecting({ source: source.id(), from, to: from });
    const { left, top } = offset();
    const rendered = (e: PointerEvent) => ({
      x: e.clientX - left,
      y: e.clientY - top,
    });

    const move = (e: PointerEvent) => {
      const to = rendered(e);
      setConnecting(
        (c) => c && { ...c, to, target: nodeAt(cy, to, c.source)?.id() }
      );
    };
    const finish = (e: PointerEvent | null) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", escape, true);
      setConnecting(null);
      setHovered(null);
      if (!e) return;
      const to = rendered(e);
      const sourceLine = source.data("lineNumber");
      const target = nodeAt(cy, to, source.id());
      const text = useDoc.getState().text;
      if (target) {
        applyCanvasEdit(
          connectNodes(text, {
            sourceLine,
            targetLine: target.data("lineNumber"),
          })
        );
      } else if (
        Math.hypot(to.x - from.x, to.y - from.y) > MIN_NEW_NODE_DRAG_PX
      ) {
        const id = applyCanvasEdit(
          addNode(text, { label: t`New node`, parentLine: sourceLine }),
          { place: toModel(cy, to) }
        );
        if (id) startEditingLabel({ type: "node", id });
      }
    };
    const up = (e: PointerEvent) => finish(e);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      finish(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", escape, true);
  };

  if (!enabled) return null;

  const { x: dx, y: dy } = offset();
  const sourceId = connecting?.source ?? hovered;
  const source = sourceId ? cy.getElementById(sourceId) : null;
  const showHandles =
    source && source.nonempty() && source.isNode() && !grabbing && !editing;
  const box = showHandles ? boundsOf(source as NodeSingular) : null;
  const targetNode = connecting?.target
    ? cy.getElementById(connecting.target)
    : null;
  const targetBox =
    targetNode && targetNode.nonempty()
      ? boundsOf(targetNode as NodeSingular)
      : null;

  return (
    <div
      ref={overlay}
      className="absolute inset-0 pointer-events-none overflow-hidden"
      data-testid="Canvas Editor"
    >
      {connecting ? (
        <svg className="absolute inset-0 w-full h-full">
          {targetBox ? (
            <rect
              x={targetBox.x1 + dx - 4}
              y={targetBox.y1 + dy - 4}
              width={targetBox.x2 - targetBox.x1 + 8}
              height={targetBox.y2 - targetBox.y1 + 8}
              rx={6}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={2}
            />
          ) : null}
          <line
            x1={connecting.from.x + dx}
            y1={connecting.from.y + dy}
            x2={connecting.to.x + dx}
            y2={connecting.to.y + dy}
            stroke="#3b82f6"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
          <circle
            cx={connecting.to.x + dx}
            cy={connecting.to.y + dy}
            r={4}
            fill="#3b82f6"
          />
        </svg>
      ) : null}
      {box && source
        ? handlePoints(box).map((point, i) => (
            <button
              key={i}
              type="button"
              aria-label={t`Drag to connect`}
              title={t`Drag to connect, or drop on empty canvas to add a node`}
              data-testid="Connector Handle"
              className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full bg-white border-2 border-blue-500 pointer-events-auto cursor-crosshair hover:scale-150 transition-transform"
              style={{ left: point.x + dx, top: point.y + dy }}
              onPointerEnter={keepHandles}
              onPointerLeave={releaseHandles}
              onPointerDown={(e) =>
                startConnecting(e, source as NodeSingular, point)
              }
            />
          ))
        : null}
      {editing ? (
        <LabelEditor
          key={editing.id}
          cy={cy}
          type={editing.type}
          id={editing.id}
          offset={{ x: dx, y: dy }}
        />
      ) : null}
    </div>
  );
}

function handlePoints(b: Box): Point[] {
  const cx = (b.x1 + b.x2) / 2;
  const cy = (b.y1 + b.y2) / 2;
  return [
    { x: cx, y: b.y1 - HANDLE_OFFSET },
    { x: b.x2 + HANDLE_OFFSET, y: cy },
    { x: cx, y: b.y2 + HANDLE_OFFSET },
    { x: b.x1 - HANDLE_OFFSET, y: cy },
  ];
}

/** A text box over a node or edge that writes the new label into the text */
function LabelEditor({
  cy,
  type,
  id,
  offset,
}: {
  cy: Core;
  type: "node" | "edge";
  id: string;
  offset: Point;
}) {
  const element = cy.getElementById(id) as NodeSingular | EdgeSingular;
  const exists = element.nonempty();
  const opened = useRef<{ line: number; lineText: string; label: string }>();
  if (exists && !opened.current) {
    const line = element.data("lineNumber") as number;
    opened.current = {
      line,
      lineText: useDoc.getState().text.split("\n")[line - 1] ?? "",
      label: String(element.data("label") ?? ""),
    };
  }
  const [value, setValue] = useState(opened.current?.label ?? "");
  const input = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!exists || !input.current) return;
    input.current.focus();
    input.current.select();
    // Seed the value once the element has rendered
    setValue((v) => v || opened.current?.label || "");
  }, [exists]);

  // The element can vanish (text edited elsewhere): give up quietly
  useEffect(() => {
    if (opened.current && !exists) stopEditingLabel();
  }, [exists]);

  if (!exists || !opened.current) return null;

  const commit = () => {
    if (done.current) return;
    done.current = true;
    stopEditingLabel();
    const was = opened.current;
    if (!was || value === was.label) return;
    const text = useDoc.getState().text;
    // Only write if the line is still the one we opened
    if (text.split("\n")[was.line - 1] !== was.lineText) return;
    applyCanvasEdit(
      type === "node"
        ? renameNode(text, { line: was.line, label: value })
        : setEdgeLabel(text, { line: was.line, label: value })
    );
  };
  const cancel = () => {
    done.current = true;
    stopEditingLabel();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") cancel();
    else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    }
  };

  const zoom = cy.zoom();
  const fontSize = Math.max(
    12,
    (parseFloat(String(element.style("font-size"))) || 16) * zoom
  );
  let box: Box;
  if (element.isNode()) {
    box = element.renderedBoundingBox({ includeLabels: false });
  } else {
    const model = element.midpoint();
    const pan = cy.pan();
    const mid = { x: model.x * zoom + pan.x, y: model.y * zoom + pan.y };
    box = { x1: mid.x - 80, x2: mid.x + 80, y1: mid.y - 20, y2: mid.y + 20 };
  }
  const width = Math.max(140, box.x2 - box.x1);
  const height = Math.max(fontSize * 2.2, box.y2 - box.y1);
  const cx = (box.x1 + box.x2) / 2;
  const cyMid = (box.y1 + box.y2) / 2;

  return (
    <textarea
      ref={input}
      aria-label={type === "node" ? t`Node label` : t`Edge label`}
      data-testid="Canvas Label Editor"
      className="absolute pointer-events-auto resize-none rounded-md border-2 border-blue-500 bg-white text-black dark:bg-neutral-800 dark:text-white p-1 text-center leading-tight shadow-lg outline-none"
      style={{
        left: cx - width / 2 + offset.x,
        top: cyMid - height / 2 + offset.y,
        width,
        height,
        fontSize,
      }}
      value={value}
      placeholder={type === "edge" ? t`Edge label` : undefined}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  );
}

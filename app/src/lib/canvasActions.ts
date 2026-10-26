import { create } from "zustand";

import {
  getNodePositionsFromCy,
  NodePositions,
} from "../components/getNodePositionsFromCy";
import { CanvasEdit } from "./canvasEdits";
import { parseGraph } from "./parseGraph";
import { addToUndoStack } from "./undoStack";
import { useDoc } from "./useDoc";
import { useGraphStore } from "./useGraphStore";
import { usePromptStore } from "./usePromptStore";

type Editing = { type: "node" | "edge"; id: string };

type CanvasEditorState = {
  /** False on read-only charts and while an AI result is previewed */
  enabled: boolean;
  /** The element whose label is being edited on the canvas */
  editing: Editing | null;
};

export const useCanvasEditor = create<CanvasEditorState>(() => ({
  enabled: false,
  editing: null,
}));

export function canEditCanvas() {
  const { diff, isRunning } = usePromptStore.getState();
  return useCanvasEditor.getState().enabled && !diff && !isRunning;
}

export function startEditingLabel(editing: Editing) {
  if (!canEditCanvas()) return;
  useCanvasEditor.setState({ editing });
}

export function stopEditingLabel() {
  useCanvasEditor.setState({ editing: null });
}

/**
 * Writes a canvas edit to the document. When the layout is frozen, or the
 * edit places a new node at `place`, every node keeps the spot it has on
 * screen: the drawn positions are saved under the node ids of the new
 * text, the same way a drag saves them. Returns the new node's id.
 */
export function applyCanvasEdit(
  edit: CanvasEdit | null,
  { place }: { place?: cytoscape.Position } = {}
): string | undefined {
  if (!edit || !canEditCanvas()) return;
  const before = useDoc.getState();
  if (edit.text === before.text) return;

  const graph = parseGraph(edit.text);
  const nodeOnLine = new Map(
    graph.nodes.map((node) => [node.parser?.lineNumber, node])
  );
  const newNode =
    edit.newLine === undefined ? undefined : nodeOnLine.get(edit.newLine);

  const stored = before.meta.nodePositions as NodePositions | undefined;
  let nodePositions = stored;
  if (stored || (place && newNode)) {
    nodePositions = {};
    const drawn = getNodePositionsFromCy();
    for (const node of window.__cy?.nodes().toArray() ?? []) {
      const line = node.data("lineNumber") as number | undefined;
      const position = drawn[node.id()];
      if (line === undefined || !position) continue;
      const newLine = edit.lineMap(line);
      const moved = newLine === undefined ? undefined : nodeOnLine.get(newLine);
      if (!moved) continue;
      nodePositions[moved.data.id] = {
        x: position.x,
        y: position.y,
        label: moved.data.label,
      };
    }
    if (place && newNode) {
      nodePositions[newNode.data.id] = {
        x: place.x,
        y: place.y,
        label: newNode.data.label,
      };
    }
  }

  const write = (text: string, positions: NodePositions | undefined) =>
    useDoc.setState(
      (state) => {
        const meta = { ...state.meta, nodePositions: positions };
        if (!positions) delete meta.nodePositions;
        return { text, meta };
      },
      false,
      "canvasActions/applyCanvasEdit"
    );
  // Nodes stay where they are drawn, so keep the view still too rather than
  // refitting around them
  const cy = window.__cy;
  if (nodePositions && cy) {
    useGraphStore.setState({ autoFit: false, zoom: cy.zoom(), pan: cy.pan() });
  }
  write(edit.text, nodePositions);
  addToUndoStack({
    kind: "canvas",
    // Typing since the edit wins: never write over text the edit did not produce
    undo: () => {
      if (useDoc.getState().text === edit.text) write(before.text, stored);
    },
    redo: () => {
      if (useDoc.getState().text === before.text)
        write(edit.text, nodePositions);
    },
  });
  return newNode?.data.id;
}

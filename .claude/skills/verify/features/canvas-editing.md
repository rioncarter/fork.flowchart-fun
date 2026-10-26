# Canvas editing

Where the chart is editable, the graph pane works like a diagramming tool as well as a preview. Double-clicking empty canvas adds a node where you clicked; hovering a node shows four connector handles, and dragging one onto another node draws an edge, while dropping it on empty canvas adds a connected node there. Double-clicking a node or edge (or selecting it and pressing Enter or F2) edits its label in place, and Delete or Backspace removes the selection. Every action is a rewrite of the document text, so the editor shows the change at once, typing in the editor updates the canvas as before, and Cmd/Ctrl+Z from the graph undoes the action in one step.

## Sub-features

- `canvas-add` — double-click empty canvas, or click `Add Node` in the floating menu (adds at the centre of the view), to append a root line and open the label editor on it. Inside a container's body the line goes inside the container. The new node is placed at the click, which freezes the layout. Driven by `examples/canvas-editing.mjs`.
- `canvas-connect` — drag a connector handle onto another node: a pointer line (`(Label)`, or `(#id)` when the label is not unique or not pointer-safe, in which case the target line gets an `#id`) is written at the end of the source's subtree. From a container, a root `(Container)` pointer block is appended instead, since lines indented inside a container are its contents. Driven by `examples/canvas-editing.mjs`.
- `canvas-drop-to-add` — drop a handle on empty canvas (more than 30px from where the drag started) to write a child line under the source and place it at the drop. Driven by `examples/canvas-editing.mjs`.
- `canvas-rename` — the label editor rewrites only the label part of the line, keeping indentation, edge label, `#id.class[attr]`, `{` and a trailing comment, and updates `(Old label)` pointers to the node. Enter commits, Shift+Enter adds a line break (`\n`), Escape cancels, clicking away commits. Driven by `examples/canvas-editing.mjs`.
- `canvas-edge-label` — editing an edge sets, replaces or (when emptied) removes the `label: ` prefix of the line that draws it, keeping edge `#id.class`. Driven by `examples/canvas-editing.mjs`.
- `canvas-delete` — Delete/Backspace removes the selected nodes and edges. A deleted node's children stay in the chart, unconnected (moved out from under it rather than handed to the node above), deleting a container keeps its contents, and pointers that reached only the deleted node are removed. Deleting an edge moves its target's subtree out from under the source, in the same container. Driven by `examples/canvas-editing.mjs`.
- `canvas-undo` — each canvas action is one undo entry restoring the text and the stored positions. It only applies while the text is still what the action wrote, so it never overwrites later typing. Driven by `examples/canvas-editing.mjs`.

## How to get to it (user POV)

- The graph pane on `/` and on `/u/:id` for a pro user. Not on read-only routes (`/r`, `/c`, `/f`, `/p`) or lapsed hosted charts, and not while an AI result is previewed.
- `Add Node` (circle-plus) is the first button of the floating menu.

## Driving it with drive.mjs

Preconditions:

- Healthy instance; client mode is enough for the sandbox.

- **Connect.** Hover the node (`mouse.move` to its rendered centre), take `getByTestId("Connector Handle").nth(i)` (0 top, 1 right, 2 bottom, 3 left), `mouse.down` on it, move in steps onto the target, `mouse.up`. The editor text gains the pointer line.
- **Add.** `mouse.dblclick` on empty canvas, wait for `getByTestId("Canvas Label Editor")`, type, press Enter. The last line is the label; `Layout Frozen` is pressed.
- **Rename / edge label.** Double-click the node, or click the edge then press Enter, select all, type, Enter.
- **Delete.** Click the node or edge, press Delete. Compare `ff.editorText()` and the graph's edges.
- **Undo.** `ControlOrMeta+z` with focus outside the editor.

## Gotchas

- Node ids are positional, so `applyCanvasEdit` (`app/src/lib/canvasActions.ts`) re-keys the drawn positions through the edit's `lineMap` before saving them, and Delete clears the cytoscape selection first so it does not land on whichever element inherits the deleted ids.
- The text rewrites are pure functions in `app/src/lib/canvasEdits.ts` with unit tests, including properties checked against every template (deleting any edge or node removes exactly it, connecting adds one edge, renaming keeps the degree).
- A double-click inside a container's body adds a node; only the top 40 model px (its title band) or select + Enter renames the container.
- The 250ms cytoscape double-click window applies: wait about 400ms between separate clicks on the same element.
- A connect that leaves the layout unfrozen re-runs the theme layout, so nodes may move; add and drop-to-add place the new node and freeze.
- With a frozen layout, a `round-taxi` edge out of a container to a node below it can fail to draw (cytoscape returns no source endpoint) even though the edge exists.

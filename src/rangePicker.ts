/**
 * Shows a note's text with a green selection whose edges can be dragged wider
 * or narrower, with the mouse or a finger.
 */

import { snapToLines, type Span } from "./text";

export class RangePicker {
  private readonly box: HTMLElement;
  private readonly before = document.createTextNode("");
  private readonly selected = document.createTextNode("");
  private readonly after = document.createTextNode("");
  private span: Span;

  constructor(
    parent: HTMLElement,
    private readonly text: string,
    initial: Span,
    /** Snap the selection to whole lines while dragging. */
    public wholeLines: boolean,
    private readonly onChange: (span: Span) => void,
  ) {
    this.span = initial;
    this.box = parent.createDiv({ cls: "cw-excerpt" });
    const startHandle = this.box.createSpan({ cls: "cw-handle cw-handle-start" });
    const mark = this.box.createEl("mark", { cls: "cw-selected" });
    const endHandle = this.box.createSpan({ cls: "cw-handle cw-handle-end" });
    this.box.insertBefore(this.before, startHandle);
    mark.appendChild(this.selected);
    this.box.appendChild(this.after);
    startHandle.setAttr("aria-label", "Drag to move the start of the selection");
    endHandle.setAttr("aria-label", "Drag to move the end of the selection");

    this.dragWith(startHandle, "start");
    this.dragWith(endHandle, "end");
    this.render();
    // Bring the selection into view once the box is laid out.
    window.requestAnimationFrame(() => mark.scrollIntoView({ block: "center" }));
  }

  get current(): Span {
    return this.span;
  }

  /** Sets the selection, for example from the owner's own text selection. */
  set(span: Span): void {
    this.span = this.wholeLines ? snapToLines(this.text, span) : span;
    this.render();
    this.onChange(this.span);
  }

  /** The part of the shown text the owner has selected with the cursor, if any. */
  textSelection(): Span | undefined {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
    const range = selection.getRangeAt(0);
    const start = this.offsetOf(range.startContainer, range.startOffset);
    const end = this.offsetOf(range.endContainer, range.endOffset);
    if (start === undefined || end === undefined) return undefined;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  private dragWith(handle: HTMLElement, edge: "start" | "end"): void {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      // The box captures the pointer, so the drag goes on outside the handle.
      this.box.setPointerCapture(event.pointerId);
      this.box.addClass("is-dragging");

      const move = (moveEvent: PointerEvent) => {
        const offset = this.offsetAtPoint(moveEvent.clientX, moveEvent.clientY);
        if (offset === undefined) return;
        let { start, end } = this.span;
        if (edge === "start") start = Math.min(offset, end);
        else end = Math.max(offset, start);
        const next = this.wholeLines ? snapToLines(this.text, { start, end }) : { start, end };
        if (next.start !== this.span.start || next.end !== this.span.end) {
          this.span = next;
          this.render();
          this.onChange(this.span);
        }
      };
      const stop = () => {
        this.box.removeClass("is-dragging");
        this.box.removeEventListener("pointermove", move);
        this.box.removeEventListener("pointerup", stop);
        this.box.removeEventListener("pointercancel", stop);
      };
      this.box.addEventListener("pointermove", move);
      this.box.addEventListener("pointerup", stop);
      this.box.addEventListener("pointercancel", stop);
    });
  }

  private render(): void {
    this.before.data = this.text.slice(0, this.span.start);
    this.selected.data = this.text.slice(this.span.start, this.span.end);
    this.after.data = this.text.slice(this.span.end);
  }

  /** The character offset in the note under a point on screen. */
  private offsetAtPoint(x: number, y: number): number | undefined {
    const doc = this.box.ownerDocument as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    if (doc.caretPositionFromPoint) {
      const position = doc.caretPositionFromPoint(x, y);
      return position ? this.offsetOf(position.offsetNode, position.offset) : undefined;
    }
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? this.offsetOf(range.startContainer, range.startOffset) : undefined;
  }

  /** Converts a position inside the box to a character offset in the note. */
  private offsetOf(node: Node, offset: number): number | undefined {
    if (node === this.before) return offset;
    if (node === this.selected) return this.span.start + offset;
    if (node === this.after) return this.span.end + offset;
    return undefined;
  }
}

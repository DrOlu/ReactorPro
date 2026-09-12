type VerticalRect = Pick<DOMRectReadOnly, "top" | "bottom" | "height">;
type HorizontalRect = Pick<DOMRectReadOnly, "left" | "width">;

export type ComposerOverlayRect = VerticalRect;
export type ComposerOverlayHorizontalRect = HorizontalRect;

export type ComposerOverlayMetrics = {
  /** The composer's normal occupied height (queue panel already deducted), driving the body's bottom reservation. */
  heightPx: number;
  /**
   * The height above the reservation line additionally occupied by floating elements: the queue
   * panel is deducted from heightPx, and the task progress pill is absolutely positioned outside the
   * card column; neither increases the bottom reservation, yet both can cover controls that also
   * float above the composer (such as the back-to-bottom button). Such controls must additionally
   * yield this distance above heightPx.
   */
  floatingOverhangPx: number;
  /**
   * The horizontal offset of the card column's center relative to the composer layer's center
   * (positive to the right). The card column and the body are both centered, so normally 0; when the
   * offset is non-zero, controls centered above the composer must shift along with it to align with
   * the cards and pills.
   */
  centerOffsetPx: number;
};

export function measureComposerOverlay(input: {
  layer: VerticalRect & HorizontalRect;
  queueHeight: number;
  /** Task progress pill container; height is 0 when no pill is rendered. */
  floating: VerticalRect | null | undefined;
  /** The card column (the common horizontal reference for the queue panel, input card, and pill). */
  column: HorizontalRect | null | undefined;
}): ComposerOverlayMetrics {
  const { layer, queueHeight, floating, column } = input;
  const heightPx = Math.ceil(Math.max(0, layer.height - queueHeight));
  const reserveLine = layer.bottom - heightPx;
  const floatingTop =
    floating && floating.height > 0 ? Math.min(layer.top, floating.top) : layer.top;
  const centerOffsetPx =
    column && column.width > 0
      ? Math.round(column.left + column.width / 2 - (layer.left + layer.width / 2))
      : 0;
  return {
    heightPx,
    floatingOverhangPx: Math.ceil(Math.max(0, reserveLine - floatingTop)),
    centerOffsetPx,
  };
}

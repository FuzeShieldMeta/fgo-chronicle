type ViewportTooltipInput = {
  anchorX: number;
  anchorY: number;
  safeTop: number;
  viewportHeight: number;
  viewportWidth: number;
};

const TOOLTIP_MAX_WIDTH = 280;
const VIEWPORT_GUTTER = 12;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function positionViewportTooltip({
  anchorX,
  anchorY,
  safeTop,
  viewportHeight,
  viewportWidth,
}: ViewportTooltipInput) {
  const availableWidth = Math.max(0, viewportWidth - VIEWPORT_GUTTER * 2);
  const halfWidth = Math.min(TOOLTIP_MAX_WIDTH, availableWidth) / 2;
  const minimumX = VIEWPORT_GUTTER + halfWidth;
  const maximumX = viewportWidth - VIEWPORT_GUTTER - halfWidth;
  const x =
    maximumX < minimumX
      ? viewportWidth / 2
      : clamp(anchorX, minimumX, maximumX);
  const y = clamp(
    anchorY,
    safeTop,
    Math.max(safeTop, viewportHeight - VIEWPORT_GUTTER * 2),
  );

  return {
    x,
    y,
    placement: y > viewportHeight / 2 ? ("above" as const) : ("below" as const),
  };
}

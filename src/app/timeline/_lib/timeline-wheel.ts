type WheelScrollState = {
  deltaX: number;
  deltaY: number;
  isZoomGesture: boolean;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
};

function canScroll(value: number, maximum: number, delta: number) {
  return delta < 0 ? value > 0 : value < maximum;
}

export function horizontalWheelDelta({
  deltaX,
  deltaY,
  isZoomGesture,
  scrollLeft,
  scrollWidth,
  clientWidth,
}: WheelScrollState) {
  if (isZoomGesture || deltaY === 0 || Math.abs(deltaX) >= Math.abs(deltaY)) {
    return 0;
  }

  const maximumHorizontalScroll = Math.max(0, scrollWidth - clientWidth);
  return canScroll(scrollLeft, maximumHorizontalScroll, deltaY) ? deltaY : 0;
}

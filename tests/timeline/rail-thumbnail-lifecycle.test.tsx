// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RailServantThumbnails } from "~/app/timeline/_components/rail-servant-thumbnails";

let height: number;
let intersect: IntersectionObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();
const unobserve = vi.fn();
const servants = [1, 2, 3, 4].map((id) => ({
  id,
  name: `Servant ${id}`,
  rarity: 5,
}));

function Rail() {
  const trackRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  return (
    <div className="timeline-scroll">
      <div className="timeline-rail" data-testid="rail">
        <span ref={trackRef} data-testid="track">
          <span ref={titleRef} data-testid="title">
            Campaign
          </span>
          <RailServantThumbnails
            servants={servants}
            trackRef={trackRef}
            titleRef={titleRef}
          />
        </span>
      </div>
    </div>
  );
}

beforeEach(() => {
  height = 44;
  observe.mockClear();
  disconnect.mockClear();
  unobserve.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  // jsdom does not lay out elements: these fixtures test React lifecycle and
  // observer behaviour, not whether the production CSS fits a real viewport.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => height,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.testid === "title")
        return new DOMRect(6, 0, 160, height);
      return new DOMRect(
        0,
        0,
        this.classList.contains("timeline-scroll") ? 500 : 800,
        height,
      );
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setVisible(isIntersecting: boolean) {
  act(() =>
    intersect(
      [
        {
          target: screen.getByTestId("rail"),
          isIntersecting,
          boundingClientRect: new DOMRect(0, 0, 800, height),
          intersectionRatio: isIntersecting ? 1 : 0,
          intersectionRect: new DOMRect(),
          rootBounds: new DOMRect(0, 0, 500, height),
          time: 0,
        },
      ],
      {} as IntersectionObserver,
    ),
  );
}

it.each([
  { trackHeight: 44, size: 40 },
  { trackHeight: 17, size: 13 },
  { trackHeight: 16, size: 12 },
])(
  "mounts portraits only after the $trackHeight px rail becomes visible",
  ({ trackHeight, size }) => {
    height = trackHeight;
    const page = render(<Rail />);
    const track = screen.getByTestId("track");
    const measure = vi.spyOn(track, "getBoundingClientRect");
    expect(page.container.querySelector(".timeline-rail-servants")).toBeNull();
    setVisible(false);
    expect(measure).not.toHaveBeenCalled();
    setVisible(true);
    const slots = page.container.querySelectorAll(
      ".timeline-rail-servant-slot",
    );
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect((slot as HTMLElement).hidden).toBe(false);
      expect((slot.firstElementChild as HTMLElement).style.width).toBe(
        `${size}px`,
      );
    }
    expect(observe).toHaveBeenCalledWith(track);
    page.unmount();
    expect(unobserve).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(3);
  },
);

it("keeps mounted portrait nodes when the track shrinks below its padded minimum", () => {
  const page = render(<Rail />);
  setVisible(true);
  const strip = page.container.querySelector<HTMLElement>(
    ".timeline-rail-servants",
  )!;
  const firstPortrait = strip.firstElementChild;
  height = 15;
  setVisible(true);
  expect(strip.hidden).toBe(true);
  expect(strip.firstElementChild).toBe(firstPortrait);
  height = 44;
  setVisible(true);
  expect(strip.hidden).toBe(false);
  expect(strip.firstElementChild).toBe(firstPortrait);
});

it("does not mount portraits when the track starts below the padded minimum", () => {
  height = 15;
  const page = render(<Rail />);
  setVisible(true);
  expect(page.container.querySelector(".timeline-rail-servants")).toBeNull();
});

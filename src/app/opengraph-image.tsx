import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

export const alt = "FGO Chronicle: Global schedule and Saint Quartz planner";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const logo = await readFile(
    join(process.cwd(), "public", "chronicle-mark.svg"),
  );

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        background: "#24466f",
        color: "#ffffff",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 48,
          padding: "64px 80px",
        }}
      >
        {/* ImageResponse embeds the SVG directly in the generated PNG. */}
        <img
          src={`data:image/svg+xml;base64,${logo.toString("base64")}`}
          width={192}
          height={192}
          alt=""
        />
        <div
          style={{ display: "flex", flexDirection: "column", gap: 24, flex: 1 }}
        >
          <div
            style={{
              fontSize: 64,
              fontWeight: 700,
            }}
          >
            FGO Chronicle
          </div>
          <div style={{ fontSize: 34, lineHeight: 1.4 }}>
            Global schedule and Saint Quartz planner
          </div>
        </div>
      </div>
    </div>,
    size,
  );
}

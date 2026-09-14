import { handleTimelineWindowRequest } from "~/server/services/timeline-window-route";

export function GET(request: Request) {
  return handleTimelineWindowRequest(request);
}

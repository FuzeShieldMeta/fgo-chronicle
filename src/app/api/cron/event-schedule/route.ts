import { handleEventScheduleCron } from "~/server/services/event-schedule-cron";

export const maxDuration = 300;

export function GET(request: Request) {
  return handleEventScheduleCron(request);
}

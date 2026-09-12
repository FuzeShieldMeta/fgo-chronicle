import { healthRouter } from "~/server/api/routers/health";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { bannerRouter } from "~/server/api/routers/banner";
import { plannerStateRouter } from "~/server/api/routers/planner-state";
import { timelineRouter } from "~/server/api/routers/timeline";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  health: healthRouter,
  banner: bannerRouter,
  plannerState: plannerStateRouter,
  timeline: timelineRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * Add domain routers to `appRouter` above, then use this caller from server code.
 */
export const createCaller = createCallerFactory(appRouter);

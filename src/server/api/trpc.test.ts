import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "./trpc";
import { db } from "~/server/db";

function validationEndpoint() {
  const save = vi.fn(() => ({ saved: true }));
  const router = createTRPCRouter({
    save: publicProcedure
      .input(
        z.object({
          values: z.object({ name: z.string().min(1, "Name is required.") }),
          reason: z.string().min(1, "Reason is required."),
        }),
      )
      .mutation(save),
  });
  return {
    save,
    request: (input: unknown) =>
      fetchRequestHandler({
        endpoint: "/api/trpc",
        router,
        createContext: () => ({ db, session: null, headers: new Headers() }),
        req: new Request("http://localhost/api/trpc/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(superjson.serialize(input)),
        }),
      }),
  };
}

it("returns named validation messages over HTTP, including errors inside curator values", async () => {
  const endpoint = validationEndpoint();
  const response = await endpoint.request({ values: { name: "" }, reason: "" });
  const body: unknown = await response.json();
  expect(response.status).toBe(400);
  expect(body).toMatchObject({
    error: {
      json: {
        data: {
          code: "BAD_REQUEST",
          zodError: {
            formErrors: [],
            fieldErrors: {
              values: ["Name is required."],
              reason: ["Reason is required."],
            },
          },
        },
      },
    },
  });
  expect(endpoint.save).not.toHaveBeenCalled();
});

it("allows valid input through the same HTTP validation boundary", async () => {
  const endpoint = validationEndpoint();
  const response = await endpoint.request({
    values: { name: "Campaign" },
    reason: "Corrected title",
  });
  const body: unknown = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ result: { data: { json: { saved: true } } } });
  expect(endpoint.save).toHaveBeenCalledOnce();
});

import { timingSafeEqual } from "node:crypto";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";
import { createLegacyMcpHandler } from "agents/mcp";
import { z } from "zod";

interface Env {
  LOADER: WorkerLoader;
  MCP_BEARER_TOKEN?: string;
  LOCAL_BROKER_TOKEN?: string;
}

const spec = {
  openapi: "3.0.3",
  info: { title: "Local offline workspace", version: "1.0.0" },
  paths: {
    "/patch": {
      get: {
        operationId: "getPatch",
        summary: "Return a bounded patch for the configured snapshot files.",
        responses: {
          "200": {
            description: "Patch against the pinned source commit",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["commit", "changedFiles", "patch"],
                  properties: {
                    commit: { type: "string" },
                    changedFiles: { type: "array", items: { type: "string" } },
                    patch: { type: "string" },
                  },
                },
              },
            },
          },
          "422": { description: "The patch could not be created" },
        },
      },
    },
    "/command": {
      post: {
        operationId: "runCommand",
        summary: "Run a command in the prepared offline workspace.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["command"],
                properties: { command: { type: "string", maxLength: 4096 } },
              },
            },
          },
        },
        responses: { "200": { description: "Command output and exit status" } },
      },
    },
  },
};

export default {
  async fetch(request, env, ctx) {
    if (!env.MCP_BEARER_TOKEN?.trim() || !env.LOCAL_BROKER_TOKEN?.trim()) {
      return new Response("Server authentication is not configured", { status: 503 });
    }

    const encoder = new TextEncoder();

    const supplied = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(request.headers.get("Authorization") ?? ""),
    );

    const expected = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`Bearer ${env.MCP_BEARER_TOKEN}`),
    );

    if (!timingSafeEqual(new Uint8Array(supplied), new Uint8Array(expected))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const brokerToken = env.LOCAL_BROKER_TOKEN;

    const server = openApiMcpServer({
      spec,
      name: "agent-cloud-local",
      version: "1.0.0",
      executor: new DynamicWorkerExecutor({
        loader: env.LOADER,
        globalOutbound: null,
        timeout: 45_000,
      }),
      request: async (options) => {
        if (options.path === "/patch") {
          if (options.method !== "GET") throw new Error("Unsupported operation");

          if (options.body !== undefined) throw new Error("Patch requests do not accept a body");

          const response = await fetch("http://127.0.0.1:8788/patch", {
            method: "GET",
            headers: { Authorization: `Bearer ${brokerToken}` },
          });

          if (!response.ok) {
            const failure = z.object({ error: z.string() }).safeParse(await response.json());

            throw new Error(
              failure.success ? failure.data.error : `Local broker failed: ${response.status}`,
            );
          }

          const result = z
            .object({ commit: z.string(), changedFiles: z.array(z.string()), patch: z.string() })
            .safeParse(await response.json());

          if (!result.success) throw new Error("Local broker returned an invalid patch");

          return result.data;
        }

        if (options.method !== "POST") throw new Error("Unsupported operation");

        if (options.path !== "/command") throw new Error("Unsupported operation");

        const body = z
          .object({
            command: z
              .string()
              .min(1)
              .max(4096)
              .refine((value) => !value.includes("\0")),
          })
          .safeParse(options.body);

        if (!body.success) throw new Error("Invalid command");

        const response = await fetch("http://127.0.0.1:8788/command", {
          method: "POST",
          headers: { Authorization: `Bearer ${brokerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body.data),
        });

        if (!response.ok) throw new Error(`Local broker failed: ${response.status}`);

        return response.json();
      },
    });

    return createLegacyMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";
import { createLegacyMcpHandler } from "agents/mcp";
import { z } from "zod";
// Wrangler loads fixture TypeScript as text, not as a TypeScript module.
// @ts-expect-error The fixture is loaded through a Wrangler Text rule.
import total from "../fixture/total.ts";
// @ts-expect-error The fixture is loaded through a Wrangler Text rule.
import test from "../fixture/total.test.ts";
import readme from "../fixture/README.md";

interface Env {
  LOADER: WorkerLoader;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  MCP_BEARER_TOKEN?: string;
}

const spec = {
  openapi: "3.0.3",
  info: { title: "Disposable fixture workspace", version: "1.0.0" },
  paths: {
    "/command": {
      post: {
        operationId: "runCommand",
        summary:
          "Run a shell command in the fixture workspace. Maximum 4096 characters and 30 seconds.",
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
        responses: { "200": { description: "Exit status and bounded output" } },
      },
    },
    "/cleanup": {
      post: {
        operationId: "cleanup",
        summary:
          "Destroy the workspace and discard its files. The next command starts a fresh fixture.",
        responses: { "200": { description: "Workspace destroyed" } },
      },
    },
  },
};

const bootstrap = `const fs = require('node:fs');
fs.mkdirSync('/workspace', {recursive:true});
fs.mkdirSync('/baseline', {recursive:true});
const files = JSON.parse(process.argv[1]);
for (const [name, data] of Object.entries(files)) { fs.writeFileSync('/workspace/' + name, data); fs.writeFileSync('/baseline/' + name, data); }
`;

export class Workspace extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);

    return result;
  }

  async command(command: string) {
    return this.serial(async () => {
      const container = this.ctx.container;

      if (!container) throw new Error("No container is configured");

      if (!container.running) {
        container.start({
          image: "cloudflare/debian-trixie",
          entrypoint: ["sleep", "infinity"],
          enableInternet: false,
        });
        await container.setInactivityTimeout(10 * 60_000);

        const init = await container.exec([
          "node",
          "-e",
          bootstrap,
          JSON.stringify({ "total.ts": total, "total.test.ts": test, "README.md": readme }),
        ]);

        const result = await init.output();

        if (result.exitCode !== 0) {
          await container.destroy();
          throw new Error("Fixture bootstrap failed");
        }

        await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
      }

      // Limit captured output in the container before it reaches Worker memory.
      const script =
        'ulimit -f 256; timeout --kill-after=2 30 sh -c "$1" > /tmp/cloud-command.out 2>&1; status=$?; head -c 65536 /tmp/cloud-command.out; rm -f /tmp/cloud-command.out; exit "$status"';

      try {
        const process = await container.exec(["sh", "-c", script, "sh", command], {
          cwd: "/workspace",
        });

        const output = await process.output();

        return {
          output: new TextDecoder().decode(output.stdout),
          exitCode: output.exitCode,
          timedOut: output.exitCode === 124 || output.exitCode === 137,
          outputLimitBytes: 65536,
        };
      } catch {
        throw new Error(
          "Command interrupted or container unavailable; its effects are unknown. Do not replay automatically.",
        );
      }
    });
  }

  async cleanup() {
    return this.serial(async () => {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
      await this.ctx.storage.deleteAlarm();

      return { destroyed: true };
    });
  }

  async alarm() {
    await this.cleanup();
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!env.MCP_BEARER_TOKEN || !env.MCP_BEARER_TOKEN.trim())
      return new Response("Server authentication is not configured", { status: 503 });
    const supplied = request.headers.get("Authorization");
    const expected = `Bearer ${env.MCP_BEARER_TOKEN}`;
    const encoder = new TextEncoder();
    const a = await crypto.subtle.digest("SHA-256", encoder.encode(supplied ?? ""));
    const b = await crypto.subtle.digest("SHA-256", encoder.encode(expected));

    if (!timingSafeEqual(new Uint8Array(a), new Uint8Array(b)))
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    const workspace = env.WORKSPACE.getByName("fixture-task");

    const server = openApiMcpServer({
      spec,
      name: "cloud-coding",
      version: "1.0.0",
      executor: new DynamicWorkerExecutor({
        loader: env.LOADER,
        globalOutbound: null,
        timeout: 45_000,
      }),
      request: async (options) => {
        if (options.method !== "POST") throw new Error("Unsupported operation");

        if (options.path === "/cleanup") return workspace.cleanup();

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

        if (!body.success) throw new Error("Command must be 1 to 4096 characters");

        return workspace.command(body.data.command);
      },
    });

    return createLegacyMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

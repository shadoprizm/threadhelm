import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, extname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import type { Config } from "./types.js";
import { createAccessGuard } from "./auth.js";
import { securityHeaders, ActionBudget } from "./http-security.js";
import { releaseIdentity } from "./version.js";
import { demoConfig, demoRejectsMutation, demoRequested } from "./demo.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
mkdirSync(`${root}/data`, { recursive: true, mode: 0o700 });
const demoMode = demoRequested();
const configPath = process.env.THREADHELM_CONFIG || process.env.ASTRA_CONFIG;
if (demoMode && configPath)
  throw new Error(
    "Demo mode refuses THREADHELM_CONFIG so sample data cannot mix with a configured workspace.",
  );
const demoPort =
  process.env.THREADHELM_DEMO_PORT || process.env.ASTRA_DEMO_PORT;
const config: Config = demoMode
  ? demoConfig(Number(demoPort || 4318))
  : JSON.parse(readFileSync(configPath || `${root}/data/config.json`, "utf8"));
if (config.mode === "demo" && !demoMode)
  throw new Error(
    "Demo mode can only be enabled with --demo or THREADHELM_DEMO=1.",
  );
const authorize = createAccessGuard(config);
const store = new Store(demoMode ? ":memory:" : `${root}/data/control.sqlite`),
  engine = new Engine(config, store, root);
const csrf = randomBytes(32).toString("hex");
const peers = new Set<ServerResponse>();
const publicOrigin = config.publicOrigin;
const actionBudget = new ActionBudget();
const release = releaseIdentity();
const mutationOrigins = new Set(
  config.auth?.mode === "cloudflare-access"
    ? [publicOrigin!]
    : [
        `http://localhost:${config.port}`,
        `http://127.0.0.1:${config.port}`,
        ...(publicOrigin ? [publicOrigin] : []),
      ],
);
function json(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function text(value: any, name: string, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${name}`);
  return value.trim();
}
function optionalText(value: any, name: string, max = 12000): string | null {
  return value == null || value === "" ? null : text(value, name, max);
}
function requestId(x: any) {
  const id = text(x, "request ID", 100);
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) throw new Error("Invalid request ID");
  return id;
}
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function body(req: IncomingMessage) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 50000) throw new Error("Request too large");
  }
  return JSON.parse(data || "{}");
}
let notifyTimer: NodeJS.Timeout | undefined;
engine.on("change", () => {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    for (const res of peers) res.write("event: change\ndata: {}\n\n");
  }, 300);
});
engine.on("invalidation", (data: any) => {
  for (const res of peers)
    res.write(`event: invalidate\ndata: ${JSON.stringify(data)}\n\n`);
});
const server = createServer(
  { requestTimeout: 15000, headersTimeout: 10000 },
  async (req, res) => {
    securityHeaders(res, !!publicOrigin);
    try {
      let identity;
      try {
        identity = await authorize(req);
      } catch (e) {
        return json(res, 403, { error: (e as Error).message });
      }
      const path = new URL(req.url || "/", "http://localhost").pathname;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.origin;
        if (!origin || !mutationOrigins.has(origin))
          return json(res, 403, { error: "Invalid origin" });
        const token =
          req.headers["x-threadhelm"] || req.headers["x-astra-control"];
        if (typeof token !== "string" || !equal(token, csrf))
          return json(res, 403, {
            error: "Reload the dashboard before submitting this action",
          });
        if (!actionBudget.accept(identity.subject)) {
          res.setHeader("Retry-After", "60");
          return json(res, 429, {
            error: "Too many actions. Wait a minute before trying again.",
          });
        }
        if (demoMode && demoRejectsMutation(path))
          return json(res, 409, {
            error:
              "This control is disabled in demo mode. Start a configured workspace to control real agents.",
          });
      }
      if (path === "/api/state" && req.method === "GET")
        return json(res, 200, {
          ...engine.state(),
          csrf,
          version: release.version,
          build: release.commit,
          installedAt: release.installedAt,
        });
      if (path === "/api/work-items" && req.method === "GET") {
        const query = new URL(req.url || "", "http://localhost").searchParams;
        return json(
          res,
          200,
          engine.workItems({
            source:
              optionalText(query.get("source"), "source", 100) || undefined,
            host: optionalText(query.get("host"), "host", 100) || undefined,
            status:
              optionalText(query.get("status"), "status", 40) || undefined,
            kind: optionalText(query.get("kind"), "kind", 40) || undefined,
            provider:
              optionalText(query.get("provider"), "provider", 100) || undefined,
            model: optionalText(query.get("model"), "model", 300) || undefined,
            locality:
              optionalText(query.get("locality"), "locality", 20) || undefined,
            search:
              optionalText(query.get("search"), "search", 300) || undefined,
            watched: query.get("watched") === "true",
            limit: Number(query.get("limit") || 50),
            cursor: query.get("cursor") || undefined,
          }),
        );
      }
      const workMatch = path.match(/^\/api\/work-items\/([^/]+)$/);
      if (workMatch && req.method === "GET")
        return json(
          res,
          200,
          await engine.detail(decodeURIComponent(workMatch[1])),
        );
      const workWatchMatch = path.match(/^\/api\/work-items\/([^/]+)\/watch$/);
      if (path === "/healthz")
        return json(res, 200, {
          ok: true,
          demo: demoMode,
          version: release.version,
          build: release.commit,
          installedAt: release.installedAt,
          hosts: engine.state().hosts.map((host) => ({
            id: host.id,
            online: host.online,
            inventoryCount: host.inventoryCount,
          })),
          sources: engine.state().sources.map((source) => ({
            id: source.id,
            online: source.online,
            stale: source.stale,
            itemCount: source.itemCount,
          })),
        });
      if (path === "/api/events" && req.method === "GET") {
        if (peers.size >= 8)
          return json(res, 429, { error: "Too many open dashboard streams" });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write("event: connected\ndata: {}\n\n");
        peers.add(res);
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 20000);
        const expiry = identity.expiresAt
          ? setTimeout(
              () => res.end(),
              Math.min(
                2147483647,
                Math.max(0, identity.expiresAt - Date.now()),
              ),
            )
          : undefined;
        res.on("close", () => {
          peers.delete(res);
          clearInterval(timer);
          if (expiry) clearTimeout(expiry);
        });
        return;
      }
      if (path === "/api/detail" && req.method === "GET") {
        const key = new URL(req.url || "", "http://localhost").searchParams.get(
          "key",
        );
        return json(res, 200, await engine.detail(text(key, "task")));
      }
      if (req.method === "POST") {
        const b = await body(req);
        if (workWatchMatch) {
          if (typeof b.value !== "boolean")
            throw new Error("Invalid watch value");
          engine.watch(decodeURIComponent(workWatchMatch[1]), b.value);
          return json(res, 200, { ok: true });
        }
        if (path === "/api/watch") {
          if (typeof b.value !== "boolean")
            throw new Error("Invalid watch value");
          engine.watch(text(b.key, "task"), b.value);
          return json(res, 200, { ok: true });
        }
        if (path === "/api/actions/resolve") {
          const a = store.actionById(text(b.id, "action", 100));
          if (!a || (a.kind === "approval" && a.status !== "expired"))
            throw new Error("Use the approval controls to answer this request");
          store.resolve(a.id);
          engine.emit("change");
          return json(res, 200, { ok: true });
        }
        if (path === "/api/actions/resolve-many") {
          if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 250)
            throw new Error("Choose between 1 and 250 inbox items");
          const ids: string[] = [
              ...new Set(
                (b.ids as unknown[]).map((id) => text(id, "action", 100)),
              ),
            ],
            chosen = ids.map((id) => store.actionById(id));
          if (chosen.some((a) => !a))
            throw new Error("One or more inbox items no longer exist");
          if (
            chosen.some((a) => a.kind === "approval" && a.status !== "expired")
          )
            throw new Error("Answer live approval requests individually");
          store.resolveMany(ids);
          engine.emit("change");
          return json(res, 200, { ok: true, resolved: ids.length });
        }
        if (path === "/api/briefing/feedback") {
          const rating = text(b.rating, "feedback rating", 20);
          if (!["useful", "wrong", "stale"].includes(rating))
            throw new Error("Invalid feedback rating");
          return json(
            res,
            200,
            engine.rateRecommendation(
              text(b.recommendationId, "recommendation", 200),
              text(b.evidenceRevision, "evidence revision", 200),
              optionalText(b.taskKey, "task", 300),
              rating as "useful" | "wrong" | "stale",
            ),
          );
        }
        if (path === "/api/briefing/apply")
          return json(
            res,
            200,
            await engine.applyRecommendation(
              requestId(b.requestId),
              text(b.recommendationId, "recommendation", 200),
              text(b.evidenceRevision, "evidence revision", 200),
              optionalText(b.taskKey, "task", 300),
            ),
          );
        if (path === "/api/shadow-analysis/run")
          return json(res, 202, engine.triggerShadowAnalysis());
        if (path === "/api/approval/expired-decision") {
          const decision = text(b.action, "decision", 20);
          if (decision !== "accept" && decision !== "decline")
            throw new Error("Choose whether to approve or decline this request");
          return json(
            res,
            200,
            await engine.decideExpiredApproval(
              requestId(b.requestId),
              text(b.id, "action", 100),
              decision,
            ),
          );
        }
        if (path === "/api/approval")
          return json(res, 200, engine.approval(text(b.id, "action"), b));
        if (path === "/api/send")
          return json(
            res,
            200,
            await engine.send(
              requestId(b.requestId),
              text(b.key, "task"),
              text(b.prompt, "message"),
            ),
          );
        if (path === "/api/continue")
          return json(
            res,
            200,
            await engine.continueTask(
              requestId(b.requestId),
              text(b.key, "task"),
            ),
          );
        if (path === "/api/pause")
          return json(
            res,
            200,
            await engine.pause(requestId(b.requestId), text(b.key, "task")),
          );
        if (path === "/api/archive")
          return json(
            res,
            200,
            await engine.archive(requestId(b.requestId), text(b.key, "task")),
          );
        if (path === "/api/create") {
          if (b.isolate != null && typeof b.isolate !== "boolean")
            throw new Error("Invalid checkout mode");
          return json(
            res,
            200,
            await engine.create(
              requestId(b.requestId),
              text(b.hostId, "machine"),
              optionalText(b.projectId, "project", 200),
              text(b.cwd, "working directory"),
              text(b.title, "title", 160),
              text(b.prompt, "prompt"),
              b.isolate === true,
            ),
          );
        }
        if (path === "/api/chat")
          return json(
            res,
            200,
            await engine.chat(text(b.message, "message", 5000)),
          );
        if (path === "/api/refresh") {
          await engine.refresh();
          return json(res, 200, { ok: true });
        }
        if (path === "/api/hosts/refresh")
          return json(
            res,
            200,
            await engine.refreshMachine(text(b.hostId, "machine", 100)),
          );
      }
      if (path.startsWith("/api/"))
        return json(res, 404, { error: "Not found" });
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, 405, { error: "Method not allowed" });
      const files: Record<string, string> = {
        "/": "index.html",
        "/app.js": "app.js",
        "/workspace.js": "workspace.js",
        "/conversation.js": "conversation.js",
        "/style.css": "style.css",
        "/conversation.css": "conversation.css",
        "/favicon.svg": "favicon.svg",
        "/robots.txt": "robots.txt",
      };
      const file = files[path];
      if (!file) return json(res, 404, { error: "Not found" });
      const types: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".txt": "text/plain",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(file)] + "; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        req.method === "HEAD" ? "" : readFileSync(`${root}/public/${file}`),
      );
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  },
);
server.listen(config.port, "127.0.0.1", () => {
  console.log(
    `ThreadHelm${demoMode ? " demo" : ""} listening on 127.0.0.1:${config.port}`,
  );
  engine.start();
});
function stop() {
  engine.close();
  for (const p of peers) p.end();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

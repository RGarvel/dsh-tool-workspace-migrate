/**
 * Model-facing workspace-migration tools: `list_workspace_sessions` and
 * `migrate_workspace`. Together they distribute the conversations of one shared
 * workspace into separate target workspaces, carrying each conversation over as
 * a new seeded session (a session's cwd is immutable, so a "move" is a new
 * session id in the target plus an archived source session).
 *
 * @module @garvel/dsh-tool-workspace-migrate
 *
 * File handling (grounded in the dsh session log):
 * - There is no per-file provenance table; every `tool/call` event logs its
 *   `name` and `arguments`, so a session's explicitly-written/edited files are
 *   recoverable by parsing `write`/`edit`/`read` calls.
 * - Reads that were only touched through shell commands are invisible to this
 *   recovery, which is exactly why `full` is the default and safest copy mode.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "tool-workspace-migrate";
const inject = ["tools", "agents", "sessionPersistence", "workspaceRegistry"];

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read"]);

function throwPolicy(code, message) {
  throw new HarnessError(message, code);
}

/** Canonicalize a path for comparison; a non-existent path resolves unchanged. */
async function canonical(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/** Whether `child` is `parent` or lies under it (both already absolute). */
function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

/** Read one session's header + full events, unified over live and cold sessions. */
async function readSession(ctx, sessionId) {
  const inspected = await ctx.sessionPersistence.inspect(sessionId);
  return {
    id: inspected.meta.id,
    header: inspected.meta,
    events: [...inspected.events]
  };
}

/** Latest logged title, or undefined. */
function sessionTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "session/title" && typeof event.data?.title === "string" && event.data.title) return event.data.title;
  }
  return void 0;
}

/** First direct-human prompt text (truncated), as a listing fallback. */
function firstPrompt(events) {
  for (const event of events) {
    if (event?.type !== "user/message" || event.data?.source?.kind !== "user") continue;
    const content = event.data.content;
    if (typeof content === "string" && content.trim()) return content.trim().slice(0, 120);
    if (Array.isArray(content)) {
      const text = content.filter((block) => block?.type === "text" && block.text).map((block) => block.text).join(" ").trim();
      if (text) return text.slice(0, 120);
    }
  }
  return void 0;
}

/** File paths a session explicitly touched through structured file tools. */
function extractedPaths(cwd, events, includeReads) {
  const paths = new Set();
  for (const event of events) {
    if (event?.type !== "tool/call") continue;
    const toolName = event.data?.name;
    if (!WRITE_TOOLS.has(toolName) && !(includeReads && READ_TOOLS.has(toolName))) continue;
    let args;
    try {
      args = typeof event.data.arguments === "string" ? JSON.parse(event.data.arguments) : event.data.arguments;
    } catch {
      continue;
    }
    const filePath = args?.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    paths.add(isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath));
  }
  return [...paths];
}

/** Copy every entry of `src` into `target` (target is created; contents merge). */
async function copyDirContents(src, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    await cp(join(src, entry.name), join(target, entry.name), { recursive: true, force: true, errorOnExist: false });
  }
}

/** Copy one path residing under `sourceCwd` into `target`, preserving relative structure. */
async function copyInto(sourceCwd, target, absolutePath) {
  const rel = relative(sourceCwd, absolutePath);
  if (rel === "" || isAbsolute(rel) || rel.startsWith(".." + sep)) return { path: absolutePath, copied: false, reason: "outside source workspace" };
  const dest = join(target, rel);
  await mkdir(dirname(dest), { recursive: true });
  await cp(absolutePath, dest, { recursive: true, force: true, errorOnExist: false });
  return { path: absolutePath, copied: true, reason: void 0 };
}

/** Resolve the continuation composition, mirroring the api-proxy's preset mount. */
async function composeContinuation(ctx, presetId) {
  const presets = ctx.get("agentPresets");
  if (presets === void 0) return { setup: () => Promise.resolve() };
  const resolvedId = (await presets.resolve(presetId)).id;
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, resolvedId);
    }
  };
}

/** Best-effort agent model selection so the seeded session never mounts model-less. */
function defaultSelection(ctx) {
  try {
    const selection = ctx.get("agentDefaultModel")?.currentSelection();
    return selection?.provider && selection?.model ? selection : void 0;
  } catch {
    return void 0;
  }
}

/**
 * Completed-turn prefix of a session's events, mirroring the host fork: seed up
 * to and including the last `turn/end`, dropping any in-flight turn. A settled
 * (cold) session ends on `turn/end`, so its full log passes through unchanged.
 */
function seedPrefix(events) {
  const boundary = events.findLast((event) => event.type === "turn/end");
  if (boundary === void 0) return events;
  let cut = boundary.seq + 1;
  while (cut < events.length && events[cut]?.type !== "turn/start") cut += 1;
  return events.slice(0, cut);
}

/** Create a continuation session in `targetPath` seeded with `events`; returns its id. */
async function seedContinuation(ctx, source, targetPath) {
  const events = seedPrefix([...source.events]);
  const composition = await composeContinuation(ctx, resolveSessionPreset(source));
  const selection = defaultSelection(ctx);
  const sessionId = `session-${randomUUID()}`;
  await ctx.agents.create({
    sessionId,
    seed: events,
    meta: {
      cwd: targetPath,
      seedLength: events.length,
      ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset })
    },
    ...(selection === void 0 ? {} : { agentOptions: { provider: selection.provider, model: selection.model } }),
    setup: composition.setup
  });
  return sessionId;
}

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "list_workspace_sessions",
    description:
      "List the top-level conversations that share one workspace directory, so you can decide which session should move to which target. " +
      "Returns each session's id, title (or first prompt), creation time, and archived status. " +
      "Reading a session's title may load its transcript, so prefer one call per shared directory rather than calling repeatedly.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "The workspace directory whose sessions to list (an absolute path)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          sessions: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                session_id: { type: "string", required: true },
                title: { type: "string" },
                first_prompt: { type: "string" },
                created_at: { type: "string" },
                archived: { type: "boolean", required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
    },
    async execute(args) {
      const canonicalPath = await canonical(args.path);
      const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
      const sessions = [];
      for (const meta of await ctx.sessionPersistence.list()) {
        if (meta.cwd === void 0) continue;
        if (meta.origin === "subagent") continue;
        if (await canonical(meta.cwd) !== canonicalPath) continue;
        const events = await ctx.sessionPersistence.inspect(meta.id).then((r) => r.events);
        const title = sessionTitle(events);
        const prompt = firstPrompt(events);
        sessions.push({
          session_id: meta.id,
          ...(title === void 0 ? {} : { title }),
          ...(prompt === void 0 ? {} : { first_prompt: prompt }),
          ...(meta.createdAt === void 0 ? {} : { created_at: new Date(meta.createdAt).toISOString() }),
          archived: archived.has(meta.id)
        });
      }
      return { path: canonicalPath, sessions };
    }
  }));

  ctx.tools.register(defineTool({
    name: "migrate_workspace",
    description:
      "Migrate one or more conversations out of a shared workspace into separate target directories. " +
      "For each migration it COPIES files (the source directory is left intact), registers the target directory as a Workspace " +
      "(reusing the registration when it already exists), creates a continuation session in the target seeded with that session's full " +
      "history (sessions cannot be re-bound, so continuation is a new session id), and archives the source session. " +
      "`copy_mode` controls how much of the shared directory each target receives: `full` copies the whole directory (safest, nothing is lost), " +
      "`artifacts` copies only files that session wrote/edited via the write/edit tools, `artifacts_read` adds files it explicitly read. " +
      "`extra_paths` always adds explicit files or directories (e.g. node_modules, .git, .env, a config folder).",
    parameters: {
      migrations: {
        type: "array",
        required: true,
        description: "One entry per conversation to migrate.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            session_id: { type: "string", required: true, description: "Source session id (from list_workspace_sessions)." },
            target_path: { type: "string", required: true, description: "Destination directory; created when missing." },
            title: { type: "string", description: "Workspace display title; used only when the target directory is newly registered." }
          }
        }
      },
      copy_mode: {
        type: "string",
        enum: ["full", "artifacts", "artifacts_read"],
        description: "full (default) = copy the entire shared directory; artifacts = only write/edit-touched files; artifacts_read = write/edit + read files."
      },
      extra_paths: {
        type: "array",
        items: { type: "string" },
        description: "Extra files or subdirectories (relative to the source workspace) to always copy, on top of the copy_mode selection."
      },
      carry_context: {
        type: "boolean",
        description: "Seed a continuation session in each target with that session's full history (default true)."
      },
      archive_source: {
        type: "boolean",
        description: "Archive each source session after migration (default true). Keeps its log and files; hides it from the sidebar."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                session_id: { type: "string", required: true },
                ok: { type: "boolean", required: true },
                error: { type: "string" },
                source_path: { type: "string" },
                target_path: { type: "string" },
                workspace_id: { type: "string" },
                copied_files: { type: "array", items: { type: "string" } },
                skipped_files: { type: "array", items: { type: "string" } },
                continuation_session_id: { type: "string" },
                continuation_error: { type: "string" },
                archived: { type: "boolean" }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
    },
    async execute(args) {
      const copyMode = args.copy_mode ?? "full";
      const extraPaths = args.extra_paths ?? [];
      const carryContext = args.carry_context !== false;
      const archiveSource = args.archive_source !== false;

      const results = [];
      for (const migration of args.migrations) {
        const entry = { session_id: migration.session_id, ok: true };
        try {
          const source = await readSession(ctx, migration.session_id);
          const sourceCwd = source.header.cwd;
          if (sourceCwd === void 0) throwPolicy("MIGRATE_NO_CWD", `session "${migration.session_id}" has no cwd`);

          const sourceAbs = resolve(sourceCwd);
          const targetAbs = resolve(migration.target_path);
          if (targetAbs === sourceAbs) throwPolicy("MIGRATE_SAME_DIR", "target equals the source directory");
          if (isWithin(targetAbs, sourceAbs)) throwPolicy("MIGRATE_TARGET_NESTED", "target is inside the source directory");
          if (isWithin(sourceAbs, targetAbs)) throwPolicy("MIGRATE_SOURCE_NESTED", "source is inside the target directory");

          const canonicalSource = await canonical(sourceAbs);
          await mkdir(targetAbs, { recursive: true });
          const canonicalTarget = await canonical(targetAbs);

          const copied = [];
          const skipped = [];
          const recordCopy = (r) => {
            if (r.copied) copied.push(r.path);
            else skipped.push(r.path);
          };

          if (copyMode === "full") {
            await copyDirContents(canonicalSource, canonicalTarget);
            copied.push(canonicalSource);
          } else {
            const includeReads = copyMode === "artifacts_read";
            for (const path of extractedPaths(canonicalSource, source.events, includeReads)) recordCopy(await copyInto(canonicalSource, canonicalTarget, path));
            for (const extra of extraPaths) recordCopy(await copyInto(canonicalSource, canonicalTarget, resolve(canonicalSource, extra)));
          }

          const workspace = await ctx.workspaceRegistry.create(canonicalTarget, migration.title ?? basename(canonicalTarget));
          entry.source_path = canonicalSource;
          entry.target_path = canonicalTarget;
          entry.workspace_id = workspace.id;
          entry.copied_files = copied;
          entry.skipped_files = skipped;

          if (carryContext) {
            try {
              const sessionId = await seedContinuation(ctx, source, canonicalTarget);
              await workspace.attachSession(sessionId);
              entry.continuation_session_id = sessionId;
            } catch (error) {
              entry.continuation_error = error instanceof Error ? error.message : String(error);
            }
          }

          if (archiveSource) {
            await ctx.workspaceRegistry.archiveSession(migration.session_id);
            entry.archived = true;
          }
        } catch (error) {
          entry.ok = false;
          entry.error = error instanceof Error ? error.message : String(error);
        }
        results.push(entry);
      }
      return { results };
    }
  }));
}

export { apply, inject, name };
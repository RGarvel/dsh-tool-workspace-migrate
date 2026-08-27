/**
 * QQ channel rebind after workspace migration — interop with
 * `@tencent-connect/dsh-qqbot`.
 *
 * Storage shapes (verified against dsh-qqbot dist sources):
 * - `~/.dsh-qqbot/session-peers.json` (PeerMap):
 *     { [sessionId]: { scope, peerId, senderId, lastMsgId, updatedAt } }
 *   Outbound mirror: any turn on `sessionId` resolves its QQ peer through this.
 * - `~/.dsh-qqbot/model-prefs.json` (PrefsStore):
 *     { overrides: { [sessionKey]: {provider, model} },
 *       sessionIds: { [sessionKey]: sessionId } }
 *   Inbound routing: `sessionKey -> sessionIds[key] ?? sha256-derive(sessionKey)`,
 *   where sessionKey is `qqbot:<appId>:<scope>:<peerId>`.
 *
 * A migrated conversation gets a NEW continuation session id, but the QQ peer
 * still resolves (by hash or stale override) to the OLD id. Rebinding therefore
 * means: point the peer's sessionKey override at the continuation, and seed the
 * peer-map entry so web-side turns mirror to QQ immediately. Both files are
 * read-modify-written; the bot caches them at startup, so a bot restart is
 * required for the change to take effect.
 *
 * The resolved sessionKey is verified cryptographically when possible: we only
 * trust an override path whose `deriveSessionId(key)` equals the source id, or
 * a prefs entry that literally maps some key to the source id.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same derivation as dsh-qqbot SessionManager#deriveSessionId. */
export function deriveSessionId(sessionKey) {
  const hash = createHash("sha256").update(sessionKey).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Default store locations, mirroring dsh-qqbot's own path conventions. */
export function defaultQQPaths(env = process.env) {
  const home = homedir();
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  return {
    peers: join(home, ".dsh-qqbot", "session-peers.json"),
    prefs: join(home, ".dsh-qqbot", "model-prefs.json"),
    profilesDir: join(dshHome, "profiles"),
  };
}

function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** appIds declared by `im-qqbot` patch blocks across all dsh profiles. */
function collectAppIds(profilesDir) {
  const appIds = new Set();
  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(profilesDir, entry.name, "cordis.patch.yml");
    let text;
    try {
      text = existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch {
      continue;
    }
    if (!text.includes("im-qqbot")) continue;
    for (const match of text.matchAll(/appId:\s*["']?([0-9A-Za-z]+)["']?/g)) appIds.add(match[1]);
  }
  return [...appIds];
}

/**
 * Rebind the QQ peer currently mapped to `sourceSessionId` onto
 * `continuationSessionId`. Fail-soft: never throws; returns a status object.
 */
export function rebindQQChannel({ sourceSessionId, continuationSessionId, paths = defaultQQPaths() }) {
  try {
    if (!existsSync(paths.peers)) return { rebound: false, reason: "qqbot-not-installed" };
    const peers = readJsonSafe(paths.peers, {});
    const entry = peers[sourceSessionId];
    if (!entry || typeof entry !== "object" || typeof entry.peerId !== "string"
      || (entry.scope !== "c2c" && entry.scope !== "group")) {
      return { rebound: false, reason: "no-qq-binding" };
    }

    let sessionKey;
    for (const appId of collectAppIds(paths.profilesDir)) {
      const candidate = `qqbot:${appId}:${entry.scope}:${entry.peerId}`;
      if (deriveSessionId(candidate) === sourceSessionId) {
        sessionKey = candidate;
        break;
      }
    }
    if (sessionKey === void 0) {
      const prefs = readJsonSafe(paths.prefs, {});
      for (const [key, value] of Object.entries(prefs.sessionIds ?? {})) {
        if (value === sourceSessionId) {
          sessionKey = key;
          break;
        }
      }
    }
    if (sessionKey === void 0) return { rebound: false, reason: "session-key-unresolved" };

    const prefs = readJsonSafe(paths.prefs, null) ?? { overrides: {}, sessionIds: {} };
    prefs.overrides = prefs.overrides ?? {};
    prefs.sessionIds = prefs.sessionIds ?? {};
    prefs.sessionIds[sessionKey] = continuationSessionId;
    writeFileSync(paths.prefs, JSON.stringify(prefs, null, 2), "utf8");

    peers[continuationSessionId] = { ...entry, updatedAt: Date.now() };
    writeFileSync(paths.peers, JSON.stringify(peers, null, 2), "utf8");

    return {
      rebound: true,
      session_key: sessionKey,
      from: sourceSessionId,
      to: continuationSessionId,
      needs_restart: true,
    };
  } catch (error) {
    return { rebound: false, reason: `qq-rebind-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
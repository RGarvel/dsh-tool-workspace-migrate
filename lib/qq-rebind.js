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
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
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

    // switch = 原子转移：一个 QQ 对端只保留一条 peer 行。seed 新行前先删同
    // (scope, peerId) 的旧行（含 sourceSessionId 及此前的历史残留），否则换绑只增不清。
    for (const [sid, p] of Object.entries(peers)) {
      if (sid !== continuationSessionId && p && typeof p === "object"
        && p.peerId === entry.peerId && p.scope === entry.scope) {
        delete peers[sid];
      }
    }
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

const SESSION_KEY_RE = /^qqbot:[^:\s]+:(c2c|group):\S+$/;

function validPeerEntry(entry) {
  return Boolean(entry) && typeof entry === "object" && typeof entry.peerId === "string"
    && (entry.scope === "c2c" || entry.scope === "group");
}

/** The sessionKey whose hash equals `sessionId`, across all profile appIds; else undefined. */
function derivedKeyFor(entry, sessionId, paths) {
  for (const appId of collectAppIds(paths.profilesDir)) {
    const candidate = `qqbot:${appId}:${entry.scope}:${entry.peerId}`;
    if (deriveSessionId(candidate) === sessionId) return candidate;
  }
  return void 0;
}

/** Read-only view of the qqbot binding state (prefs + peers), normalized for tool output. */
export function listQQBindings(paths = defaultQQPaths()) {
  const peers = readJsonSafe(paths.peers, {});
  const prefs = readJsonSafe(paths.prefs, {});
  return {
    qqbot_installed: existsSync(paths.peers),
    bindings: Object.entries(prefs.sessionIds ?? {}).map(([session_key, session_id]) => ({ session_key, session_id })),
    model_overrides: Object.entries(prefs.overrides ?? {}).map(([session_key, o]) => ({
      session_key,
      provider: o && typeof o === "object" ? o.provider : void 0,
      model: o && typeof o === "object" ? o.model : void 0,
    })),
    peers: Object.entries(peers).map(([session_id, p]) => ({
      session_id,
      scope: validPeerEntry(p) ? p.scope : void 0,
      peer_id: validPeerEntry(p) ? p.peerId : void 0,
      sender_id: validPeerEntry(p) ? p.senderId : void 0,
      updated_at: validPeerEntry(p) ? p.updatedAt : void 0,
      has_last_msg_id: Boolean(validPeerEntry(p) && typeof p.lastMsgId === "string"),
    })),
  };
}

/**
 * Manually point a QQ channel (sessionKey) at `targetSessionId` — the explicit
 * counterpart of the automatic migration rebind. Key resolution order: explicit
 * `sessionKey` > prefs reverse-lookup / derive match for `sourceSessionId` >
 * same for `targetSessionId` > the single known binding (when unambiguous).
 * Seeds the target's peers entry whenever a matching peer entry is copyable.
 */
export function setQQChannelBinding({ targetSessionId, sessionKey, sourceSessionId, paths = defaultQQPaths() }) {
  try {
    if (!existsSync(paths.peers)) return { ok: false, reason: "qqbot-not-installed" };
    const peers = readJsonSafe(paths.peers, {});
    const prefs = readJsonSafe(paths.prefs, null) ?? { overrides: {}, sessionIds: {} };
    prefs.overrides = prefs.overrides ?? {};
    prefs.sessionIds = prefs.sessionIds ?? {};
    const bindings = prefs.sessionIds;

    let key;
    let seed;
    if (sessionKey !== void 0 && sessionKey !== "") {
      if (!SESSION_KEY_RE.test(sessionKey)) {
        return { ok: false, reason: "invalid-session-key", known_bindings: Object.keys(bindings) };
      }
      key = sessionKey;
    }
    if (key === void 0 && sourceSessionId !== void 0 && sourceSessionId !== "") {
      key = Object.keys(bindings).find((k) => bindings[k] === sourceSessionId);
      if (validPeerEntry(peers[sourceSessionId])) {
        seed = peers[sourceSessionId];
        if (key === void 0) key = derivedKeyFor(peers[sourceSessionId], sourceSessionId, paths);
      }
    }
    if (key === void 0) {
      key = Object.keys(bindings).find((k) => bindings[k] === targetSessionId);
      if (validPeerEntry(peers[targetSessionId])) {
        seed = seed ?? peers[targetSessionId];
        if (key === void 0) key = derivedKeyFor(peers[targetSessionId], targetSessionId, paths);
      }
    }
    if (key === void 0) {
      const all = Object.keys(bindings);
      if (all.length === 1) key = all[0];
      else return { ok: false, reason: all.length === 0 ? "no-known-bindings" : "ambiguous-session-key", known_bindings: all };
    }
    const previous = bindings[key];
    if (seed === void 0) {
      if (previous !== void 0 && validPeerEntry(peers[previous])) seed = peers[previous];
      else {
        const [, , scope, peerId] = key.split(":");
        seed = Object.values(peers).find((p) => validPeerEntry(p) && p.scope === scope && p.peerId === peerId);
      }
    }

    bindings[key] = targetSessionId;
    writeFileSync(paths.prefs, JSON.stringify(prefs, null, 2), "utf8");
    let peersSeeded = false;
    if (seed !== void 0) {
      // switch = 原子转移：一个 QQ 对端只保留一条 peer 行。seed 新行前先删同
      // (scope, peerId) 的旧行（含 previous 及历史残留），只留 target 一条。
      let changed = false;
      for (const [sid, p] of Object.entries(peers)) {
        if (sid !== targetSessionId && p && typeof p === "object"
          && p.peerId === seed.peerId && p.scope === seed.scope) {
          delete peers[sid];
          changed = true;
        }
      }
      if (peers[targetSessionId] === void 0) {
        peers[targetSessionId] = { ...seed, updatedAt: Date.now() };
        changed = true;
        peersSeeded = true;
      }
      if (changed) {
        writeFileSync(paths.peers, JSON.stringify(peers, null, 2), "utf8");
      }
    }
    return {
      ok: true,
      session_key: key,
      previous_session_id: previous,
      target_session_id: targetSessionId,
      peers_seeded: peersSeeded,
      needs_restart: true,
    };
  } catch (error) {
    return { ok: false, reason: `qq-rebind-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
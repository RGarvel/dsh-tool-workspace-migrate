/**
 * Regression tests for ./../lib/qq-rebind.js (QQ channel rebind).
 * Run: npm test   (no external deps; fixtures live in the OS temp dir)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebindQQChannel, setQQChannelBinding, deriveSessionId } from "../lib/qq-rebind.js";

let failures = 0;
const check = (label, cond) => { if (cond) console.log("ok  :", label); else { failures++; console.log("FAIL:", label); } };

const APPID = "1905185859";
const PEER = "00BF91CB0E5FD32A482D7375C56FDD71";
const KEY = `qqbot:${APPID}:c2c:${PEER}`;
const entry = (o) => ({ scope: "c2c", peerId: PEER, senderId: PEER, lastMsgId: "msg-1", updatedAt: 1787836351132, ...o });

function fixture({ peers, prefs, withAppId = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qqbind-"));
  const qq = join(root, "store"); mkdirSync(qq);
  const profiles = join(root, "profiles");
  if (withAppId) {
    const p = join(profiles, "web"); mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "cordis.patch.yml"), `- id: im-qqbot\n  config:\n    appId: '${APPID}'\n    cwd: X:\\somewhere\n`);
  } else mkdirSync(profiles, { recursive: true });
  const paths = { peers: join(qq, "session-peers.json"), prefs: join(qq, "model-prefs.json"), profilesDir: profiles };
  if (peers !== void 0) writeFileSync(paths.peers, typeof peers === "string" ? peers : JSON.stringify(peers));
  if (prefs !== void 0) writeFileSync(paths.prefs, JSON.stringify(prefs));
  return paths;
}
const loadJson = (f) => JSON.parse(readFileSync(f, "utf8"));

// A. derived route: source id equals sha256-derive(sessionKey) (plain QQ session)
{
  const src = deriveSessionId(KEY);
  const paths = fixture({ peers: { [src]: entry() } });
  const r = rebindQQChannel({ sourceSessionId: src, continuationSessionId: "session-CONT-A", paths });
  check("A1 rebound via crypto-verified key", r.rebound === true && r.session_key === KEY && r.needs_restart === true);
  const prefs = loadJson(paths.prefs);
  check("A2 prefs override written", prefs.sessionIds[KEY] === "session-CONT-A");
  const peers = loadJson(paths.peers);
  check("A3 peers seeded for continuation, source kept", peers["session-CONT-A"]?.peerId === PEER && peers[src] !== void 0);
  check("A4 chained rebind resolves through prefs value",
    rebindQQChannel({ sourceSessionId: "session-CONT-A", continuationSessionId: "session-CONT-B", paths }).rebound === true);
  check("A5 chain repoints to latest continuation", loadJson(paths.prefs).sessionIds[KEY] === "session-CONT-B");
}

// B. override route: source bound via prefs (e.g. after /new); per-peer model prefs survive
{
  const paths = fixture({
    peers: { "session-OLDUUID": entry() },
    prefs: { overrides: { [KEY]: { provider: "pp", model: "mm" } }, sessionIds: { [KEY]: "session-OLDUUID" } },
  });
  const r = rebindQQChannel({ sourceSessionId: "session-OLDUUID", continuationSessionId: "session-CONT-X", paths });
  check("B1 prefs value reverse-lookup hits", r.rebound === true && r.session_key === KEY);
  const prefs = loadJson(paths.prefs);
  check("B2 existing model override preserved", prefs.overrides[KEY]?.model === "mm");
  check("B3 sessionIds repointed", prefs.sessionIds[KEY] === "session-CONT-X");
}

// C-F. silent & fail-soft paths
{
  const p1 = fixture({ peers: { [deriveSessionId(KEY)]: entry() } });
  const r1 = rebindQQChannel({ sourceSessionId: "session-UNRELATED", continuationSessionId: "session-Z", paths: p1 });
  check("C1 unbound source is a no-op (no prefs file created)", r1.reason === "no-qq-binding" && !existsSync(p1.prefs));

  const p2 = fixture({});
  check("D1 qqbot absent", rebindQQChannel({ sourceSessionId: "s", continuationSessionId: "z", paths: p2 }).reason === "qqbot-not-installed");

  const p3 = fixture({ peers: "{corrupt!!!" });
  check("E1 corrupt peers fail-soft", rebindQQChannel({ sourceSessionId: "s", continuationSessionId: "z", paths: p3 }).reason === "no-qq-binding");

  const src = deriveSessionId(KEY);
  const p4 = fixture({ peers: { [src]: entry() }, withAppId: false });
  check("F1 unresolvable session key reported",
    rebindQQChannel({ sourceSessionId: src, continuationSessionId: "z", paths: p4 }).reason === "session-key-unresolved");
}

// G. manual switch after a migration chain: single-binding fallback + seed + idempotence
{
  const src = deriveSessionId(KEY);
  const paths = fixture({ peers: { [src]: entry() } });
  rebindQQChannel({ sourceSessionId: src, continuationSessionId: "session-A", paths });
  const r = setQQChannelBinding({ targetSessionId: "session-B", paths });
  check("G1 resolves single binding, reports previous",
    r.ok === true && r.session_key === KEY && r.previous_session_id === "session-A" && r.peers_seeded === true);
  check("G2 prefs repointed and peers seeded",
    loadJson(paths.prefs).sessionIds[KEY] === "session-B" && loadJson(paths.peers)["session-B"]?.peerId === PEER);
  const r2 = setQQChannelBinding({ targetSessionId: "session-B", paths });
  check("G3 idempotent (already bound to target)", r2.ok === true && r2.previous_session_id === "session-B" && r2.peers_seeded === false);
}

// H. explicit sessionKey without any binding; seed via scope+peerId match; invalid key rejected
{
  const paths = fixture({ peers: { "session-OLD": entry() } });
  const r = setQQChannelBinding({ targetSessionId: "session-T", sessionKey: KEY, paths });
  check("H1 explicit key works, seeds from peerId match", r.ok === true && r.previous_session_id === void 0 && r.peers_seeded === true);
  const bad = setQQChannelBinding({ targetSessionId: "session-T", sessionKey: "qqbot:x:bad:1", paths });
  check("H2 invalid key rejected", bad.ok === false && bad.reason === "invalid-session-key");
}

// I/J. several bindings: ambiguous without hint, resolved with source hint
{
  const paths = fixture({
    peers: { "session-P1": entry(), "session-P2": entry({ peerId: "OTHERPEER" }) },
    prefs: { overrides: {}, sessionIds: { [KEY]: "session-P1", [`qqbot:${APPID}:group:G1`]: "session-P2" } },
  });
  const amb = setQQChannelBinding({ targetSessionId: "session-NEW", paths });
  check("I1 ambiguous rejected with known bindings", amb.ok === false && amb.reason === "ambiguous-session-key" && amb.known_bindings.length === 2);
  const hinted = setQQChannelBinding({ targetSessionId: "session-NEW", sourceSessionId: "session-P2", paths });
  check("J1 source hint resolves intended key", hinted.ok === true && hinted.session_key === `qqbot:${APPID}:group:G1` && hinted.previous_session_id === "session-P2");
}

// K. UTF-8 BOM tolerance (PowerShell Set-Content style files)
{
  const src = deriveSessionId(KEY);
  const paths = fixture({ peers: { [src]: entry() } });
  writeFileSync(paths.peers, "\uFEFF" + readFileSync(paths.peers, "utf8"), "utf8");
  check("K1 BOM-prefixed peers still parses",
    rebindQQChannel({ sourceSessionId: src, continuationSessionId: "session-BOM", paths }).rebound === true);
}

console.log(failures === 0 ? "\n== ALL PASS ==" : `\n== ${failures} FAILURES ==`);
process.exitCode = failures === 0 ? 0 : 1;
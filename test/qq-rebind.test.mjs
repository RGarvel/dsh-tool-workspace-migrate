/**
 * Regression tests for ./../lib/qq-rebind.js (QQ channel rebind).
 * Run: npm test   (no external deps; fixtures live in the OS temp dir)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebindQQChannel, deriveSessionId } from "../lib/qq-rebind.js";

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

console.log(failures === 0 ? "\n== ALL PASS ==" : `\n== ${failures} FAILURES ==`);
process.exitCode = failures === 0 ? 0 : 1;
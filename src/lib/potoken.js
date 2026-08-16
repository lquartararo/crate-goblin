// Minting a proof-of-origin token.
//
// This is the wall everything else ran into. YouTube stopped putting media URLs
// in the player response at all — not withheld behind a cipher, simply absent —
// and no client identity, origin or header gets them back. Measured across six
// InnerTube clients and the watch page's own ytInitialPlayerResponse: no `url`,
// no `signatureCipher`, on any of twelve audio formats.
//
// What unlocks it is a PoToken, and it is worth knowing that yt-dlp does not
// produce one either. Its extractor carries PoTokenPolicy, PoTokenContext and
// po_token_func, all of which take a token from somewhere else. Download sites
// run headless browsers to mint them server-side.
//
// The token comes from BotGuard, a VM YouTube ships as obfuscated JavaScript.
// bgutils-js runs it, and is by the same author as youtubei.js, so the two are
// built to meet. Everyone else emulates a browser to do this. We have a real
// one, which is the one advantage this design has over a server.

import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';

// YouTube's own BotGuard request key, the same one their player uses.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const ATTESTATION = 'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT';

// Tokens are good for hours. Minting is the expensive part of a download — it
// runs an obfuscated VM — so it happens once and is reused across a crate.
const TTL_MS = 60 * 60_000;
let cached = null;

/**
 * @param {string} contentBinding  visitor id, data sync id, or video id
 * @param {Function} fetchFn       goes through a YouTube page, see youtube.js
 */
export async function mintPoToken(contentBinding, fetchFn) {
  if (cached && cached.binding === contentBinding && Date.now() - cached.at < TTL_MS) {
    return cached.token;
  }

  // 1. The challenge: an interpreter program plus the name it expects to be
  //    reachable under once evaluated.
  const challenge = await getChallenge({
    requestKey: REQUEST_KEY,
    fetchFunction: fetchFn,
    useYouTubeAPI: true,
  });
  if (!challenge?.bgChallenge) throw new Error('BotGuard returned no challenge');

  const { interpreterJavascript, program, globalName } = challenge.bgChallenge;
  const source = interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!source) throw new Error('BotGuard challenge carried no interpreter');

  // 2. Evaluate the interpreter. This is why the work happens in the offscreen
  //    document rather than the service worker: the VM expects a DOM, and a
  //    worker has none.
  //
  //    eval is the only way in — the program is generated per challenge and
  //    arrives as source. That is also why the extension keeps 'wasm-unsafe-eval'
  //    out of its CSP and confines this to one place.
  (0, eval)(source);

  const bg = await BotGuardClient.create({
    program,
    globalName,
    globalObj: globalThis,
  });

  // 3. Run it, collecting the signals the minter needs.
  const webPoSignalOutput = [];
  const botguardResponse = await bg.snapshot({ webPoSignalOutput });

  // 4. Trade the response for an integrity token.
  const res = await fetchFn(ATTESTATION, {
    method: 'POST',
    headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw' },
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!res.ok) throw new Error(`integrity token ${res.status}`);

  const [integrityToken] = await res.json();
  if (!integrityToken) throw new Error('no integrity token returned');

  // 5. Mint, bound to this session's visitor id.
  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  const token = await minter.mintAsWebsafeString(contentBinding);

  cached = { token, binding: contentBinding, at: Date.now() };
  return token;
}

export function forgetPoToken() {
  cached = null;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { shareToken, analysisIdFromToken, shareUrl } from "./share";

const SECRET = "test-secret-not-a-real-one";
function withSecret(value: string | undefined, fn: () => void) {
  const before = process.env.ANALYSIS_SHARE_SECRET;
  const beforeKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "";
  if (value === undefined) delete process.env.ANALYSIS_SHARE_SECRET;
  else process.env.ANALYSIS_SHARE_SECRET = value;
  try { fn(); } finally {
    if (before === undefined) delete process.env.ANALYSIS_SHARE_SECRET;
    else process.env.ANALYSIS_SHARE_SECRET = before;
    if (beforeKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = beforeKey;
  }
}

const ID = "3f1c9e02-7a44-4c77-9c1e-1b0f0a2d5e88";

test("a token we issued opens the analysis it was issued for", () => {
  withSecret(SECRET, () => {
    assert.equal(analysisIdFromToken(shareToken(ID)), ID);
  });
});

test("a bare analysis id is not a token", () => {
  // THE WHOLE POINT. Without a signature anybody who saw one analysis URL
  // could walk the ids and read other people's games. The id alone must open
  // nothing.
  withSecret(SECRET, () => {
    assert.equal(analysisIdFromToken(ID), null);
    assert.equal(analysisIdFromToken(`${ID}.`), null);
    assert.equal(analysisIdFromToken(""), null);
    assert.equal(analysisIdFromToken(".abc"), null);
  });
});

test("a signature for one analysis does not open another", () => {
  withSecret(SECRET, () => {
    const other = "99999999-7a44-4c77-9c1e-1b0f0a2d5e88";
    const forged = `${other}.${shareToken(ID).split(".")[1]}`;
    assert.equal(analysisIdFromToken(forged), null);
  });
});

test("tampering with any character breaks it", () => {
  withSecret(SECRET, () => {
    const token = shareToken(ID);
    for (let i = 0; i < token.length; i++) {
      const swapped = token[i] === "a" ? "b" : "a";
      const bad = token.slice(0, i) + swapped + token.slice(i + 1);
      if (bad === token) continue;
      assert.equal(analysisIdFromToken(bad), null, `position ${i} was not protected`);
    }
  });
});

test("rotating the secret invalidates every link ever issued", () => {
  // The cost of signing rather than storing tokens, pinned so nobody is
  // surprised by it: there is no per-link revocation, only a reset of all.
  let token = "";
  withSecret(SECRET, () => { token = shareToken(ID); });
  withSecret("a-different-secret", () => {
    assert.equal(analysisIdFromToken(token), null);
  });
});

test("with no secret configured, nothing opens", () => {
  // Failing closed. A deployment missing its secret must refuse to verify
  // rather than accept anything, and it must not throw a 500 either.
  withSecret(undefined, () => {
    assert.equal(analysisIdFromToken(`${ID}.anything`), null);
  });
});

test("the url has no double slash when the site url has a trailing one", () => {
  withSecret(SECRET, () => {
    assert.match(shareUrl(ID, "https://example.com/"), /^https:\/\/example\.com\/share\//);
    assert.equal(shareUrl(ID, "https://example.com/").includes("//share"), false);
  });
});

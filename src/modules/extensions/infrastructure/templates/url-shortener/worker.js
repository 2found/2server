// Short-link Worker for the `url-shortener` template.
// GET / → 302 to the default landing target; GET /:code → 302 | 404 | 410
// Signed: GET /v1/links, POST /v1/mint, POST /v1/revoke (Soot1 Ed25519).
// The short-link host comes from the request, so the same script serves any
// hostname in the App spec; only the empty-path landing target is fixed.
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISS = /^[a-z][a-z0-9-]{0,47}$/;
const DEFAULT_TTL = 30 * 24 * 3600;
const MAX_TTL = 365 * 24 * 3600;
const MIN_TTL = 60;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/healthz") {
      return new Response(req.method === "HEAD" ? null : "ok\n", { headers: { "content-type": "text/plain" } });
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/v1/links") {
      return listLinks(req, env, url.origin);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const code = url.pathname.replace(/^\/+/, "");
      if (!code) return Response.redirect("https://trysoot.com", 302);
      if (!CODE.test(code)) return text("not found", 404);
      const row = await env.LINKS.prepare(
        "SELECT url, expires_at FROM links WHERE code = ?",
      ).bind(code).first();
      if (!row) return text("not found", 404);
      if (row.expires_at && row.expires_at < Date.now() / 1000) return text("link expired", 410);
      return Response.redirect(row.url, 302);
    }
    if (req.method !== "POST") return text("method not allowed", 405);
    const op = url.pathname === "/v1/mint" ? "mint"
      : url.pathname === "/v1/revoke" ? "revoke" : "";
    if (!op) return text("not found", 404);
    const token = bearer(req);
    if (!token) return text("unauthorized", 401);
    let claims;
    try {
      claims = await verify(env, token, op);
    } catch (e) {
      return text(String(e.message || e), 401);
    }
    if (op === "revoke") {
      if (!claims.code) return text("revoke requires code", 400);
      const res = await env.LINKS.prepare(
        "DELETE FROM links WHERE code = ? AND iss = ?",
      ).bind(claims.code, claims.iss).run();
      if (!res.meta?.changes) return text("not found", 404);
      return json({ kind: "receipt", state: "succeeded", code: claims.code });
    }
    const target = claims.url;
    if (!target || !target.startsWith("https://")) return text("url must be https", 400);
    // A signed claim can still carry a URL that Response.redirect refuses.
    try { new URL(target); } catch { return text("url must be https", 400); }
    const ttl = claims.ttl ?? DEFAULT_TTL;
    if (!Number.isInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL) return text("ttl out of range", 400);
    const quota = await env.LINKS.prepare(
      "SELECT quota FROM customers WHERE id = ?",
    ).bind(claims.iss).first();
    const used = await env.LINKS.prepare(
      "SELECT count(*) AS n FROM links WHERE iss = ? AND created_at > ?",
    ).bind(claims.iss, Math.floor(Date.now() / 1000) - 86400).first();
    if ((used?.n ?? 0) >= (quota?.quota ?? 200)) return text("daily quota exceeded", 429);
    let code = claims.code || randomCode();
    if (!CODE.test(code)) return text("invalid code", 400);
    const now = Math.floor(Date.now() / 1000);
    const expires = now + ttl;
    for (let i = 0; i < 4; i++) {
      try {
        await env.LINKS.prepare(
          "INSERT INTO links (code, url, iss, sub, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(code, target, claims.iss, claims.sub || "", expires, now).run();
        break;
      } catch (e) {
        // Only a unique-code collision is retryable; a storage failure must not
        // be reported as a taken code.
        if (!/UNIQUE/i.test(String(e?.message ?? e))) return text("storage unavailable", 503);
        if (claims.code) return text("code taken", 409);
        code = randomCode();
        if (i === 3) return text("could not allocate code", 500);
      }
    }
    return json({
      kind: "shortlink",
      shortlink: {
        code,
        url: `${url.origin}/${code}`,
        expiresAt: expires,
      },
    });
  },
};

function text(body, status) {
  return new Response(body + "\n", { status, headers: { "content-type": "text/plain;charset=UTF-8" } });
}
function json(body) {
  return new Response(JSON.stringify(body) + "\n", { headers: { "content-type": "application/json" } });
}

async function listLinks(req, env, origin) {
  const token = bearer(req);
  if (!token) return text("unauthorized", 401);
  let claims;
  try {
    claims = await verify(env, token, "list");
  } catch (e) {
    return text(String(e.message || e), 401);
  }
  let sql = "SELECT code, url, sub, expires_at, created_at FROM links WHERE iss = ?";
  const binds = [claims.iss];
  if (claims.sub) {
    sql += " AND sub = ?";
    binds.push(claims.sub);
  }
  sql += " ORDER BY created_at DESC LIMIT 100";
  const res = await env.LINKS.prepare(sql).bind(...binds).all();
  const now = Date.now() / 1000;
  const links = (res.results || []).map((row) => ({
    code: row.code,
    url: origin + "/" + row.code,
    target: row.url,
    sub: row.sub || "",
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    expired: !!(row.expires_at && row.expires_at < now),
  }));
  return json({ kind: "list", links });
}

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  const m = /^Soot1\s+(\S+)$/i.exec(h);
  return m ? m[1] : "";
}
function b64url(s) {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function verify(env, token, op) {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "soot1" || !ISS.test(parts[1])) throw new Error("invalid token");
  const payload = b64url(parts[2]);
  const sig = b64url(parts[3]);
  const customer = await env.LINKS.prepare(
    "SELECT pubkey, quota FROM customers WHERE id = ?",
  ).bind(parts[1]).first();
  if (!customer?.pubkey) throw new Error("unknown customer");
  const key = await crypto.subtle.importKey(
    "raw",
    b64url(customer.pubkey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, payload);
  if (!ok) throw new Error("signature rejected");
  const claims = JSON.parse(new TextDecoder().decode(payload));
  if (claims.v !== 1 || claims.op !== op) throw new Error("wrong operation");
  if (!claims.exp || claims.exp < Date.now() / 1000) throw new Error("token expired");
  claims.iss = parts[1];
  return claims;
}
function randomCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  let s = "";
  for (const n of b) s += ALPHABET[n % ALPHABET.length];
  return s;
}

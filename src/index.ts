import {
  adminSession,
  verifyAdmin,
  equalSecret,
  verifyToken,
  digest,
  type SigningConfig,
} from "./crypto";
import { json, error, readJson, HttpInputError } from "./http";
import { relayRequest } from "./relay";
import QRCode from "qrcode";
export { Deployment } from "./deployment";
export interface Env extends SigningConfig {
  DEPLOYMENT: DurableObjectNamespace;
  NODE_ENABLED?: string;
  PUSH_ALLOWED_HOSTS?: string;
  DEVICE_DAILY_BUDGET?: string;
  ADMIN_PASSWORD: string;
  TURN_KEY_ID: string;
  TURN_API_TOKEN: string;
  CREDENTIAL_TTL: string;
}
function stub(env: Env) {
  return env.DEPLOYMENT.get(env.DEPLOYMENT.idFromName("deployment"));
}
async function forward(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  return stub(env).fetch(`https://deployment${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GriefSeed 中继来源</title>
<style>body{max-width:800px;margin:3rem auto;padding:1rem;font:16px system-ui;color:#222}input,button{font:inherit;padding:.6rem;margin:.3rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}#qr svg{max-width:260px}li{margin:1rem 0}</style>
<h1>GriefSeed 中继来源</h1><form id="login"><input id="password" type="password" autocomplete="current-password" placeholder="管理密码" required><button>登录</button></form>
<section id="panel" hidden><form id="create"><input id="name" maxlength="80" placeholder="来源 token 名称" required><button>发放 token</button></form>
<p>配对链接只显示一次，请分别在手机上扫码。吊销将拒绝新签发，并重试撤销未过期凭据；已有通话何时中断须实测。</p><pre id="link"></pre><div id="qr"></div><ul id="tokens"></ul><section id="node" hidden><h2>节点配对</h2><button id="join">生成两部手机的加入码</button><p>同一码供 Homura 和 Madoka 各使用一次，15 分钟有效。</p><ul id="devices"></ul><pre id="budget"></pre></section>
<h2>备份与恢复</h2><button id="backup">下载备份</button><input id="restorefile" type="file" accept="application/json"><button id="restore">恢复备份</button><p>备份包含短信，请妥善保存。恢复会撤销旧会话及来源 token，将未完成命令隔离为未知，需要重新配对。</p><button id="refresh">刷新状态</button><button id="logout">退出</button></section><p id="status" role="status"></p>
<script nonce="NONCE">
let csrf='';const el=id=>document.getElementById(id);function status(s){el('status').textContent=s;}
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error?.code||'请求失败');return d;}
async function load(){const d=await api('/admin/tokens');el('tokens').replaceChildren();for(const t of d.tokens){const li=document.createElement('li');const pending=d.revocations.find(r=>r.token_id===t.id)?.pending||0;li.textContent=t.name+' · '+(t.revoked?'已吊销':'可用')+' · 签发请求 '+t.requests+' / 成功 '+t.successes+' / 失败 '+t.failures+' · 待撤销 '+pending;const b=document.createElement('button');b.textContent=t.revoked?'重试撤销':'吊销';b.onclick=()=>api('/admin/tokens/'+t.id+'/revoke','POST',{}).then(load).catch(e=>status(e.message));li.append(b);el('tokens').append(li);}}
async function loadNode(){const info=await api('/admin/info');el('node').hidden=!info.node_enabled;if(!info.node_enabled)return;const d=await api('/admin/devices');el('devices').replaceChildren();for(const device of d.devices){const row=document.createElement('li');row.textContent=device.name+' · '+device.role+' · '+device.state;const button=document.createElement('button');button.textContent='撤销设备';button.onclick=()=>api('/admin/devices/'+device.id+'/revoke','POST',{}).then(loadNode).catch(e=>status(e.message));row.append(button);el('devices').append(row);}el('budget').textContent='本日设备操作计数（不是平台账单）：'+JSON.stringify(d.budget);}
function showLink(d){el('link').textContent=d.link;el('qr').replaceChildren();const img=document.createElement('img');img.alt='配对二维码';img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(d.qr);el('qr').append(img);}
el('join').onclick=()=>api('/admin/join','POST',{}).then(showLink).catch(e=>status(e.message));
el('backup').onclick=async()=>{try{const data=await api('/admin/backup');const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='griefseed-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(e.message);}};
el('restore').onclick=async()=>{try{const file=el('restorefile').files[0];if(!file||file.size>4194304)throw Error('请选择不超过 4 MiB 的备份');if(!confirm('恢复将撤销所有旧会话和来源 token，并停止未完成命令。确认恢复？'))return;const body=JSON.parse(await file.text());body.confirm='RESTORE_AND_REVOKE';await api('/admin/restore','POST',body);location.reload();}catch(e){status(e.message);}};
el('login').onsubmit=async e=>{e.preventDefault();try{const d=await api('/admin/login','POST',{password:el('password').value});el('password').value='';csrf=d.csrf;el('panel').hidden=false;el('login').hidden=true;await load();await loadNode();status('已登录');}catch(e){status(e.message);}};
el('create').onsubmit=async e=>{e.preventDefault();try{el('link').textContent='';el('qr').replaceChildren();const d=await api('/admin/tokens','POST',{name:el('name').value});el('link').textContent=d.link;const img=document.createElement('img');img.alt='来源配对二维码';img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(d.qr);el('qr').append(img);await load();status('请保存链接，刷新后无法再次查看');}catch(e){status(e.message);}};
el('refresh').onclick=()=>Promise.all([load(),loadNode()]).catch(e=>status(e.message));el('logout').onclick=()=>api('/admin/logout','POST',{}).then(()=>location.reload()).catch(e=>status(e.message));
</script></html>`;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "GET" && path === "/healthz")
        return json({ status: "ok" });
      if (request.method === "GET" && path === "/") {
        const nonce = crypto.randomUUID();
        return new Response(page.replace("NONCE", nonce), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
          },
        });
      }
      if (
        env.NODE_ENABLED === "true" &&
        path === "/v1/capabilities" &&
        request.method === "GET"
      )
        return json({
          protocol_version: 1,
          extensions: [
            "sim_radio",
            "sim_country",
            "mesh",
            "client_ping_v1",
            "rtc_control_ws_v1",
            "cold_standby_v1",
          ],
          rtc_audio: true,
          rtc_call_control: true,
          push: !!env.PUSH_ALLOWED_HOSTS?.trim(),
          rtc_sleep: !!env.PUSH_ALLOWED_HOSTS?.trim(),
          reception_v2: true,
          global_decline_v1: true,
          incoming_ring_until_end: true,
          ice_servers_v1: true,
        });
      if (
        env.NODE_ENABLED === "true" &&
        path.startsWith("/v1/") &&
        path !== "/v1/rtc/ice-servers"
      ) {
        // Reject unknown paths before touching the deployment object.
        const routes =
          /^\/v1\/(?:pairings\/claim|auth\/(?:refresh|revoke)|clients|gateways(?:\/[A-Za-z0-9_-]+\/(?:sims|heartbeat|sim-bindings|events:batch|commands(?:\/[A-Za-z0-9_-]+\/claim)?))?|messages(?:\/[A-Za-z0-9_-]+)?|events(?:\/ack)?|devices\/self\/(?:rtc-capability|reception|push-endpoint(?:\/test)?)|rtc\/(?:control\/(?:ws|capability|incoming(?:-policy)?|calls(?:\/[A-Za-z0-9_-]+(?:\/operations)?)?)|legs\/[A-Za-z0-9_-]+)|calls(?:\/[A-Za-z0-9_-]+(?:\/media(?:\/active)?)?)?|ws)$/;
        if (!routes.test(path)) return error("NOT_FOUND", 404);
        const publicRoute =
          path === "/v1/pairings/claim" || path === "/v1/auth/refresh";
        const authorization = request.headers.get("Authorization") || "";
        if (
          !publicRoute &&
          (!authorization.startsWith("Bearer ") ||
            !(await verifyToken(env, authorization.slice(7), "nodeAccess")))
        )
          return error("INVALID_CREDENTIALS", 401);
        return stub(env).fetch(
          new Request("https://deployment/node" + path + url.search, request),
        );
      }
      if (path === "/v1/rtc/ice-servers" && request.method === "GET") {
        const authorization = request.headers.get("Authorization") || "";
        if (
          env.NODE_ENABLED === "true" &&
          authorization.startsWith("Bearer a1.") &&
          (await verifyToken(env, authorization.slice(7), "nodeAccess"))
        )
          return stub(env).fetch(
            new Request("https://deployment/node/v1/rtc/ice-servers", request),
          );
        return relayRequest(env, authorization, (hash) =>
          forward(env, "/ice", "POST", { hash }),
        );
      }
      if (!path.startsWith("/admin/")) return error("NOT_FOUND", 404);
      if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16)
        return error("ADMIN_NOT_CONFIGURED", 503);
      // Same-origin POSTs plus strict cookies and a session-bound CSRF token. No wildcard CORS.
      if (
        request.method !== "GET" &&
        request.headers.get("Origin") !== url.origin
      )
        return error("INVALID_ORIGIN", 403);
      if (path === "/admin/login" && request.method === "POST") {
        const budget = await forward(env, "/login-budget", "POST", {
          ip: request.headers.get("CF-Connecting-IP") || "local",
        });
        if (!budget.ok) return budget;
        const body = await readJson(request);
        if (
          typeof body.password !== "string" ||
          !(await equalSecret(body.password, env.ADMIN_PASSWORD))
        )
          return error("INVALID_CREDENTIALS", 401);
        const session = await adminSession(
          env.ADMIN_PASSWORD,
          env.DEPLOYMENT_ID,
        );
        const saved = await forward(env, "/admin-session", "POST", {
          hash: await digest(session),
          expires: Number(session.split(".")[0]) * 1000,
        });
        if (!saved.ok) return saved;
        return json({ csrf: session.split(".")[1] }, 200, {
          "Set-Cookie": `admin=${session}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
        });
      }
      const session =
        request.headers.get("Cookie")?.match(/(?:^|;\s*)admin=([^;]+)/)?.[1] ||
        "";
      if (!(await verifyAdmin(env.ADMIN_PASSWORD, env.DEPLOYMENT_ID, session)))
        return error("INVALID_CREDENTIALS", 401);
      if (
        request.method !== "GET" &&
        request.headers.get("X-CSRF-Token") !== session.split(".")[1]
      )
        return error("INVALID_CSRF", 403);
      const active = await forward(env, "/admin-check", "POST", {
        hash: await digest(session),
      });
      if (!active.ok) return active;
      if (path === "/admin/logout" && request.method === "POST") {
        await forward(env, "/admin-logout", "POST", {
          hash: await digest(session),
        });
        return json({ ok: true }, 200, {
          "Set-Cookie":
            "admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        });
      }
      if (path === "/admin/info" && request.method === "GET")
        return json({ node_enabled: env.NODE_ENABLED === "true" });
      if (
        path === "/admin/devices" &&
        request.method === "GET" &&
        env.NODE_ENABLED === "true"
      )
        return forward(env, "/node-devices");
      const device = path.match(/^\/admin\/devices\/([0-9a-f-]{36})\/revoke$/);
      if (device && request.method === "POST" && env.NODE_ENABLED === "true")
        return forward(
          env,
          "/node-devices/" + device[1] + "/revoke",
          "POST",
          {},
        );
      if (path === "/admin/backup" && request.method === "GET")
        return forward(env, "/backup");
      if (path === "/admin/restore" && request.method === "POST")
        return forward(
          env,
          "/restore",
          "POST",
          await readJson(request, 4 * 1024 * 1024),
        );
      if (
        path === "/admin/join" &&
        request.method === "POST" &&
        env.NODE_ENABLED === "true"
      ) {
        const response = await forward(env, "/node-join", "POST", {});
        if (!response.ok) return response;
        const data = (await response.json()) as { join_code: string };
        const link =
          "mahogsm://join?v=2&n=" +
          encodeURIComponent(url.origin + "#" + data.join_code);
        return json(
          {
            ...data,
            link,
            qr: await QRCode.toString(link, {
              type: "svg",
              errorCorrectionLevel: "M",
            }),
          },
          201,
        );
      }
      if (path === "/admin/tokens" && request.method === "GET")
        return forward(env, "/tokens");
      if (path === "/admin/tokens" && request.method === "POST") {
        const body = await readJson(request);
        const result = await forward(env, "/tokens", "POST", body);
        if (!result.ok) return result;
        const data = (await result.json()) as { token: string; id: string };
        const link = `gsm2sip://relay?url=${encodeURIComponent(url.origin)}&token=${encodeURIComponent(data.token)}`;
        return json(
          {
            ...data,
            link,
            qr: await QRCode.toString(link, {
              type: "svg",
              errorCorrectionLevel: "M",
            }),
          },
          201,
        );
      }
      const match = path.match(
        /^\/admin\/tokens\/([A-Za-z0-9_-]{43})\/revoke$/,
      );
      if (match && request.method === "POST")
        return forward(env, `/tokens/${match[1]}/revoke`, "POST", {});
      return error("NOT_FOUND", 404);
    } catch (failure) {
      return failure instanceof HttpInputError
        ? error(failure.code, failure.status)
        : error("REQUEST_FAILED", 503);
    }
  },
};

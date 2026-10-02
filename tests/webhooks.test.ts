import { expect,test } from "bun:test";
import { chmod,mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceCommand } from "../src/cli/resources";
import { configSchema } from "../src/modules/config/application/config";
import { webhookOperations } from "../src/modules/extensions/infrastructure/templates/monitoring/cli";
import { monitoringCompose,monitoringFiles } from "../src/modules/extensions/infrastructure/templates/monitoring/hooks";
import { alertmanagerConfig,discordUrl,testWebhook,type WebhookFetch } from "../src/modules/extensions/infrastructure/templates/monitoring/webhooks";
import { webhookSchema } from "../src/shared/domain/schema";
import { run } from "../src/shared/infrastructure/process";
const base = { version: 1, name: "webhook-test", ssh: { kind: "ssh", host: "example.com", user: "deploy" }, edge: { mode: "managed" }, extensions: { monitoring: { zone: "example.com" } } };
const hook = webhookSchema.parse({ name: "discord", provider: "discord", urlEnv: "TWO_TEST_DISCORD" });
const fakeUrl = "https://discord.com/api/webhooks/123456789/test-only-token";
const cfg = () => configSchema.parse({ ...base, extensions: { ...base.extensions, webhooks: [hook] } });
test("Discord endpoints reject non-Discord URLs, credentials, queries; errors never echo secrets", () => {
  delete process.env.TWO_TEST_DISCORD;
  expect(()=>discordUrl(hook)).toThrow("2server/.env");
  for (const url of ["http://discord.com/api/webhooks/123/token", "https://discord.com.evil.test/api/webhooks/123/token", "https://discord.com@127.0.0.1/api/webhooks/123/token", fakeUrl+"?redirect=secret", fakeUrl+"#secret", "https://user:secret@discord.com/api/webhooks/123/token"]) {
    process.env.TWO_TEST_DISCORD = url;
    try { discordUrl(hook); throw new Error("accepted bad URL"); } catch (e) { expect(String(e)).toContain("Invalid Discord"); expect(String(e)).not.toContain(url); }
  }
  process.env.TWO_TEST_DISCORD = fakeUrl;
  expect(discordUrl(hook)).toBe(fakeUrl);
  expect(()=>configSchema.parse({...base,extensions:{webhooks:[hook,hook]}})).toThrow("unique");
  expect(()=>webhookSchema.parse({...hook,url:fakeUrl})).toThrow();
  delete process.env.TWO_TEST_DISCORD;
});
test("native Discord receiver enables Alertmanager; disabled targets need no secret", () => {
  process.env.TWO_TEST_DISCORD = fakeUrl;
  const c = cfg();
  expect(monitoringCompose(c).services.alertmanager).toBeDefined();
  const receiver = alertmanagerConfig(c).receivers[0] as any;
  expect(receiver.discord_configs[0].webhook_url).toBe(fakeUrl);
  expect(receiver.discord_configs[0].http_config.follow_redirects).toBe(false);
  expect(receiver.webhook_configs).toBeUndefined();
  delete process.env.TWO_TEST_DISCORD;
  c.extensions.webhooks[0].enabled = false;
  expect(monitoringCompose(c).services.alertmanager).toBeUndefined();
  expect(monitoringFiles(c)["alertmanager.yml"]).toBeUndefined();
});
test("test sends once with wait=true and no mentions; redacts HTTP/transport errors", async () => {
  process.env.TWO_TEST_DISCORD = fakeUrl;
  let calls=0;
  const ok = (async (url:any, init:any) => {
    calls++;
    expect(String(url)).toBe(fakeUrl+"?wait=true");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body).allowed_mentions.parse).toEqual([]);
    return Response.json({id:"12345"});
  }) as WebhookFetch;
  expect((await testWebhook(cfg(),hook,ok)).messageId).toBe("12345");
  expect(calls).toBe(1);
  for (const status of [403,404,429,500,204]) {
    let count=0;
    const fail = (async()=>{ count++; return new Response(null,{status,headers:{"retry-after":"2"}}); }) as WebhookFetch;
    await expect(testWebhook(cfg(),hook,fail)).rejects.toThrow(status===429 ? "rate limited" : `HTTP ${status}`);
    expect(count).toBe(1);
  }
  await expect(testWebhook(cfg(),hook,(async()=>{throw new Error(fakeUrl);}) as WebhookFetch)).rejects.toThrow("delivery status is unknown");
  await expect(testWebhook(cfg(),hook,(async()=>Response.json({})) as WebhookFetch)).rejects.toThrow("confirmation missing");
  delete process.env.TWO_TEST_DISCORD;
});
test("webhook CLI CRUD persists only after apply; test/dry-run/read never deploy", async () => {
  const root=await mkdtemp(join(tmpdir(),"two-webhook-cli-"));
  const saved={...webhookOperations};
  const file=join(root,"server.json"), spec=join(root,"hook.json");
  let applied=0,sent=0,fail=false;
  webhookOperations.apply=async c=>{ if(fail)throw new Error("fixture deployment failed"); applied++; expect(c.extensions.monitoring).toBeTruthy(); };
  webhookOperations.test=async()=>{sent++;return {webhook:hook.name,provider:hook.provider,messageId:"1",sentFrom:"operator"};};
  try {
    await Bun.write(file,JSON.stringify(configSchema.parse({...base,name:`test-${crypto.randomUUID().slice(0,8)}`})));
    await Bun.write(spec,JSON.stringify(hook));
    const call=(verb:string,apply=false)=>resourceCommand([verb,"webhook",hook.name,"-f",file,...(["create","update"].includes(verb)?["--spec",spec]:[]),...(apply?["--apply"]:[])]);
    const original=await Bun.file(file).text();
    await call("create"); expect(await Bun.file(file).text()).toBe(original); expect(applied).toBe(0);
    await call("create",true); expect(applied).toBe(1);
    await expect(call("create",true)).rejects.toThrow("absent");
    await call("get"); await call("test"); expect(sent).toBe(0);
    await call("test",true); expect(sent).toBe(1); expect(applied).toBe(1);
    await Bun.write(spec,JSON.stringify({...hook,enabled:false}));
    fail=true; const before=await Bun.file(file).text();
    await expect(call("update",true)).rejects.toThrow("fixture"); expect(await Bun.file(file).text()).toBe(before);
    fail=false; await call("update",true); expect((await Bun.file(file).json()).extensions.webhooks[0].enabled).toBe(false);
    await call("delete",true); expect((await Bun.file(file).json()).extensions.webhooks).toEqual([]);
    await expect(call("test",true)).rejects.toThrow("not found");
    expect(applied).toBe(3);
  } finally { Object.assign(webhookOperations,saved); await rm(root,{recursive:true,force:true}); }
});
const integration=process.env.DOCKER_TESTS==="1" ? test : test.skip;
integration("real Alertmanager validates and delivers firing/resolved Discord embeds", async()=>{
  const root=await mkdtemp(join(tmpdir(),"two-discord-am-"));
  const ctr=`two-discord-am-${crypto.randomUUID().slice(0,8)}`;
  const payloads:any[]=[];
  const receiver=Bun.serve({hostname:"0.0.0.0",port:0,async fetch(req){payloads.push(await req.json());return Response.json({id:"12345"});}});
  process.env.TWO_TEST_DISCORD=fakeUrl;
  try {
    const config=alertmanagerConfig(cfg()) as any;
    config.route.group_wait="0s";config.route.group_interval="1s";
    // Only the transport is local; generated native Discord notifier and templates run unchanged.
    config.receivers[0].discord_configs[0].webhook_url=`http://host.docker.internal:${receiver.port}/api/webhooks/123/local-fixture`;
    await chmod(root,0o755);
    const file=join(root,"alertmanager.yml"); await Bun.write(file,JSON.stringify(config));await chmod(file,0o644);
    await run(["docker","run","--rm","--network","none","-v",`${root}:/fixture:ro`,"--entrypoint","/bin/amtool","prom/alertmanager:v0.28.1","check-config","/fixture/alertmanager.yml"]);
    await run(["docker","run","-d","--name",ctr,"--add-host","host.docker.internal:host-gateway","-p","127.0.0.1::9093","-v",`${file}:/etc/alertmanager/alertmanager.yml:ro`,"prom/alertmanager:v0.28.1","--config.file=/etc/alertmanager/alertmanager.yml","--cluster.listen-address="]);
    const url=`http://${(await run(["docker","port",ctr,"9093/tcp"])).trim()}`;
    for(let i=0;i<40;i++){try{if((await fetch(url+"/-/ready")).ok)break;}catch{}await Bun.sleep(100);}
    const startsAt=new Date(Date.now()-60000).toISOString();
    const send=async(endsAt:string)=>{expect((await fetch(url+"/api/v2/alerts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify([{labels:{alertname:"TwoServerTest",container:"fixture"},annotations:{summary:"Test alert"},startsAt,endsAt}])})).status).toBe(200);};
    await send(new Date(Date.now()+60000).toISOString());
    for(let i=0;i<60&&!payloads.length;i++)await Bun.sleep(250);
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads[0].embeds[0].title).toContain("FIRING");
    expect(payloads[0].embeds[0].description).toContain("TwoServerTest");
    await send(new Date(Date.now()-1000).toISOString());
    for(let i=0;i<60&&!payloads.some(p=>p.embeds?.[0]?.title?.includes("RESOLVED"));i++)await Bun.sleep(250);
    expect(payloads.some(p=>p.embeds?.[0]?.title?.includes("RESOLVED"))).toBe(true);
  } finally {receiver.stop(true);delete process.env.TWO_TEST_DISCORD;await run(["docker","rm","-f",ctr]).catch(()=>{});await rm(root,{recursive:true,force:true});}
},60000);

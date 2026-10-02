import { test, expect } from "bun:test";
import { mkdtemp, mkdir, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config";
import { statefulFiles, extensionProject } from "../src/stateful";
import { extensionByName } from "../src/extensions";
import { postgresExtension } from "../src/extensions/postgres";
import { redisExtension } from "../src/extensions/redis";
import { natsExtension } from "../src/extensions/nats";
import { postgresImage, physicalRestoreScript, removeRecoveryScript } from "../src/extensions/postgres/pgbackrest";
import { backupScript } from "../src/extensions/postgres/backups";
import { postgresHealthFiles } from "../src/extensions/postgres/health";
import { run } from "../src/process";
const integration = process.env.DOCKER_TESTS === "1" ? test : test.skip;
integration("PostgreSQL least privilege, real WAL/PITR, isolated drills and failed recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "two-pitr-"));
  const name = `pitr-${crypto.randomUUID().slice(0,8)}`, project = `two-${name}-postgres`;
  const network = `two-${name}`, repo = `${project}-repository`, file = join(root,"compose.json");
  const c = configSchema.parse({version:1,name,ssh:{kind:"ssh",host:"example.com",user:"test"},edge:{mode:"managed",network},
    extensions:{postgres:{passwordEnv:"TEST_PITR_APP",adminPasswordEnv:"TEST_PITR_ADMIN",migrationPasswordEnv:"TEST_PITR_MIGRATE",backup:{destination:"gs://test-bucket/pgbackrest"}}}});
  for (const k of ["APP","ADMIN","MIGRATE"]) process.env[`TEST_PITR_${k}`] = `fixture-${k}-long-$-quote-'password`;
  const pg = extensionProject(c,"postgres"), image = postgresImage(c);
  const sql = (role: string, query: string, container=pg) => run(["docker","exec",container,"psql","-X","-U",role,"-d","app","-v","ON_ERROR_STOP=1","-Atc",query]);
  const backrest = (...args:string[]) => run(["docker","exec","--user","postgres",pg,"pgbackrest","--stanza=main",...args]);
  const recoveries = ["verify","drill","broken"];
  try {
    await run(["docker","network","create",network]);
    await run(["docker","volume","create",repo]);
    await run(["docker","run","--rm","--network","none","--user","0:0","-v",`${repo}:/repository`,"--entrypoint","sh",c.extensions.postgres!.image,"-ec","chown postgres:postgres /repository"]);
    const files = await statefulFiles(c, postgresExtension);
    // Exercise pgBackRest's real archive/backup/recovery engine with a local
    // repository. Cloud credentials and bucket APIs are not touched by this test.
    files["pgbackrest.conf"] = files["pgbackrest.conf"]
      .replace(/repo1-type=gcs\nrepo1-gcs-bucket=.*\nrepo1-gcs-key-type=auto/,"repo1-type=posix")
      .replace(/repo1-path=.*/,"repo1-path=/repository");
    const compose = JSON.parse(files["compose.json"]), service = compose.services[pg];
    compose.volumes = {data:{}, repository:{external:true,name:repo}};
    service.volumes[0] = "data:/var/lib/postgresql";
    service.volumes.push("repository:/repository");
    files["compose.json"] = JSON.stringify(compose);
    for(const [key,value] of Object.entries(files)) {
      await Bun.write(join(root,key),value);
      await chmod(join(root,key),key==="pgbackrest.conf" ? 0o644 : 0o600);
    }
    await run(["docker","compose","-p",project,"-f",file,"build"]);
    await run(["docker","compose","-p",project,"-f",file,"up","-d","--wait","--wait-timeout","90"]);
    expect((await sql("app","SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname=current_user")).trim()).toBe("f");
    expect((await sql("two_migrator","SELECT current_user")).trim()).toBe("two_owner");
    await expect(sql("app","CREATE TABLE forbidden(id int)")).rejects.toThrow();
    await expect(sql("app","CREATE ROLE forbidden LOGIN")).rejects.toThrow();
    await expect(sql("app","CREATE DATABASE forbidden")).rejects.toThrow();
    await expect(sql("app","SET ROLE two_owner")).rejects.toThrow();
    await sql("two_migrator","CREATE TABLE sample(id serial PRIMARY KEY, value text)");
    await sql("app","INSERT INTO sample(value) VALUES ('before backup')");
    await expect(run(["docker","exec","-e","PGPASSWORD=wrong",pg,"psql","-h","127.0.0.1","-U","app","-d","app","-c","SELECT 1"])).rejects.toThrow();
    await mkdir(join(root,"edge")); await Bun.write(join(root,"edge/owner"),name);
    await mkdir(join(root,"extensions/postgres/current"),{recursive:true});
    await Bun.write(join(root,"extensions/postgres/current/pgbackrest.conf"),files["pgbackrest.conf"]);
    await chmod(join(root,"extensions/postgres/current/pgbackrest.conf"),0o644);
    await mkdir(join(root,"bin"));
    const realDocker=(await run(["which","docker"])).trim();
    // Share only the fixture repository with the restore containers.
    await Bun.write(join(root,"bin/docker"),`#!/bin/bash\nif [ "$1" = run ]; then shift; exec '${realDocker}' run -v '${repo}:/repository' "$@"; fi\nexec '${realDocker}' "$@"\n`);
    await chmod(join(root,"bin/docker"),0o755);
    const shell=async(script:string)=>{
      const p=Bun.spawn(["bash","-se"],{env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`},stdin:new Blob([script.replaceAll("/opt/2server",root).replaceAll("/var/lock/",root+"/").replace("seq 1 120","seq 1 40").replace("sleep 5","sleep 0.25")]),stdout:"pipe",stderr:"pipe"});
      const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
      if(code)throw new Error(`fixture script failed: ${err.slice(-2500)} ${out.slice(-1500)}`);
      return out;
    };
    await shell(backupScript(c));
    let info=JSON.parse(await backrest("--output=json","info"));
    expect(info[0].backup.at(-1).type).toBe("full");
    await Bun.sleep(1100);
    await sql("app","INSERT INTO sample(value) VALUES ('after full backup')");
    const target=(await sql("two_admin",`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)).trim();
    await Bun.sleep(1100);
    await sql("app","INSERT INTO sample(value) VALUES ('after target')");
    await sql("two_admin","SELECT pg_switch_wal()"); await backrest("check");
    const script=physicalRestoreScript(c,{name:"verify",targetTime:target});
    await shell(script);
    const recovery=`two-${name}-recovery-verify`;
    expect((await sql("two_admin","SELECT count(*) FROM sample",recovery)).trim()).toBe("2");
    expect((await sql("app","SELECT count(*) FROM sample")).trim()).toBe("3");
    expect((await sql("two_admin","SHOW default_transaction_read_only",recovery)).trim()).toBe("on");
    expect((await sql("two_admin","SHOW archive_mode",recovery)).trim()).toBe("off");
    await expect(shell(script)).rejects.toThrow("already exists");
    await shell(removeRecoveryScript(c,"verify"));
    await shell(backupScript(c));
    info=JSON.parse(await backrest("--output=json","info"));
    expect(info[0].backup.at(-1).type).toBe("diff");
    await shell(physicalRestoreScript(c,{name:"drill",check:true}));
    expect(Number(await Bun.file(join(root,"backups/postgres-last-restore-check-epoch")).text())).toBeGreaterThan(0);
    await expect(run(["docker","inspect",`two-${name}-recovery-drill`])).rejects.toThrow();
    await shell(postgresHealthFiles(c)["metrics.sh"]);
    const metrics=await Bun.file(join(root,"metrics/postgres.prom")).text();
    expect(metrics).toContain("two_postgres_up 1");
    expect(metrics).toContain("two_postgres_archive_required 1");
    await run(["docker","exec",pg,"mv","/repository/archive/main","/repository/archive/missing"]);
    await expect(shell(physicalRestoreScript(c,{name:"broken",targetTime:target,check:true}))).rejects.toThrow();
    expect(await Bun.file(join(root,"backups/postgres-restore-check-failed")).text()).toBe("1");
    await expect(run(["docker","volume","inspect",`two-${name}-recovery-broken`])).rejects.toThrow();
    expect((await sql("app","SELECT count(*) FROM sample")).trim()).toBe("3");
    await run(["docker","exec",pg,"mv","/repository/archive/missing","/repository/archive/main"]);
    await run(["docker","stop",pg]);
    await expect(shell(backupScript(c))).rejects.toThrow();
    await shell(postgresHealthFiles(c)["metrics.sh"]);
    const failedMetrics = await Bun.file(join(root,"metrics/postgres.prom")).text();
    expect(failedMetrics).toContain("two_postgres_up 0");
    expect(failedMetrics).toContain("two_postgres_backup_failed 1");
    expect(failedMetrics).toContain("two_postgres_restore_check_failed 1");
  } catch(error) {
    console.error((await run(["docker","logs","--tail","25",pg]).catch(()=>"no fixture logs")).slice(-3500));
    throw error;
  } finally {
    for(const suffix of recoveries) {
      await run(["docker","rm","-f",`two-${name}-recovery-${suffix}-restore`]).catch(()=>{});
      await run(["docker","rm","-f",`two-${name}-recovery-${suffix}`]).catch(()=>{});
      await run(["docker","volume","rm",`two-${name}-recovery-${suffix}`]).catch(()=>{});
    }
    await run(["docker","compose","-p",project,"-f",file,"down","-v"]).catch(()=>{});
    await run(["docker","volume","rm",repo]).catch(()=>{});
    await run(["docker","network","rm",network]).catch(()=>{});
    await rm(root,{recursive:true,force:true});
    for(const k of ["APP","ADMIN","MIGRATE"])delete process.env[`TEST_PITR_${k}`];
  }
},240000);

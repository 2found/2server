"""Trusted template adapter. Requests arrive on SSH stdin; output is bounded facts.

Never copy an open database, source active config from a release, or log a token.
Runtime config-deploy.v1 owns all source writes, snapshots and rollback fences.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request


def fail(code):
    raise RuntimeError(code)


def command(args, timeout=180):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    if result.returncode:
        fail("host_command_failed")
    return result.stdout.decode()


def directory(path):
    path = Path(path)
    for node in [*reversed(path.parents), path]:
        info = node.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail("mount_identity_invalid")


def read(path, limit=65536):
    path = Path(path)
    directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            fail("private_file_invalid")
        raw = os.read(fd, limit + 1)
        after = os.fstat(fd)
        current = path.lstat()
        if len(raw) > limit or (before.st_ino, before.st_dev, before.st_mtime_ns, before.st_size) != (after.st_ino, after.st_dev, after.st_mtime_ns, after.st_size) or (before.st_ino, before.st_dev) != (current.st_ino, current.st_dev):
            fail("file_changed")
        return raw
    finally:
        os.close(fd)


def write_new(path, raw, mode=0o600):
    path = Path(path)
    directory(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
    finally:
        os.close(fd)


def verify_tree(root, inventory):
    directory(root)
    allowed_directories = set(inventory["directories"])
    for f in inventory["files"]:
        allowed_directories.update(str(p) for p in Path(f["name"]).parents if str(p) != ".")
    actual_files, actual_directories = [], []
    for p in root.rglob("*"):
        if p.is_symlink():
            fail("staged_files_changed")
        (actual_directories if p.is_dir() else actual_files).append(str(p.relative_to(root)))
    if sorted(actual_files) != sorted(f["name"] for f in inventory["files"]) or sorted(actual_directories) != sorted(allowed_directories):
        fail("staged_files_changed")
    for f in inventory["files"]:
        p = root / f["name"]
        if hashlib.sha256(read(p, 128 << 20)).hexdigest() != f["digest"] or bool(p.stat().st_mode & 0o111) != f["executable"]:
            fail("staged_files_changed")


def materialize_source(path, q):
    inventory = json.loads(q["inventory"])
    if path.exists():
        verify_tree(path, inventory)
        return
    path.mkdir(mode=0o700)
    for name in q["directories"]:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name) or any(p in [".", ".."] for p in name.split("/")):
            fail("staging_path_invalid")
        (path / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    for f in q["files"]:
        name = f["name"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name) or any(p in [".", ".."] for p in name.split("/")):
            fail("staging_path_invalid")
        p = path / name
        p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        raw = base64.b64decode(f["bytes"], validate=True)
        if hashlib.sha256(raw).hexdigest() != f["digest"]:
            fail("staging_bytes_changed")
        write_new(p, raw, 0o700 if f["executable"] else 0o600)
    verify_tree(path, inventory)


def container(q):
    p = subprocess.run(["docker", "inspect", q["container"]], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if p.returncode:
        return None
    c = json.loads(p.stdout)[0]
    labels = c["Config"].get("Labels") or {}
    if labels.get("io.2server.owner") != q["server"] or labels.get("io.2server.app") != q["instance"] or labels.get("io.2server.extension") != q["instance"]:
        fail("foreign_container")
    expected = {"/config": q["root"] + "/config", "/transactions": q["root"] + "/transactions", "/state": q["data"], "/credentials": q["root"] + "/credentials"}
    mounts = {m["Destination"]: m["Source"] for m in c["Mounts"]}
    modes = {m["Destination"]: m["RW"] for m in c["Mounts"]}
    host_config = c["HostConfig"]
    if any(mounts.get(k) != v or not modes.get(k) for k, v in expected.items()) or set(mounts) != set(expected) | {"/release"} or modes.get("/release") or host_config.get("PortBindings") or host_config.get("Privileged") or host_config.get("NetworkMode") == "host" or not host_config.get("ReadonlyRootfs"):
        fail("container_mount_identity_changed")
    release = release_path(q, c["Config"].get("Labels", {}).get("io.2server.release", ""))
    meta = release_meta(q, release)
    if c["Config"]["Image"] != meta["image"] or mounts.get("/release") != str(release):
        fail("container_package_changed")
    return c


def owner(q):
    root = Path(q["root"])
    directory(root)
    if read(root / "owner").decode() != q["owner"]:
        fail("foreign_instance")
    for p in [root / "config", root / "transactions", root / "credentials", Path(q["data"])]:
        directory(p)
    if read(Path(q["data"]) / ".2server-owner").decode() != q["owner"]:
        fail("foreign_data")


def release_path(q, identifier):
    if not re.fullmatch(r"[a-f0-9-]{36}", identifier):
        fail("release_identity_invalid")
    return Path(q["root"]) / "releases" / identifier


def release_meta(q, path):
    directory(path)
    meta = json.loads(read(path / "release.json"))
    if meta["owner"] != q["owner"] or hashlib.sha256(read(path / "receipt.json")).hexdigest() != meta["receipt_digest"]:
        fail("release_receipt_changed")
    if hashlib.sha256(read(path / "compose.json")).hexdigest() != meta["compose_digest"]:
        fail("release_supervisor_changed")
    return meta


def inspect(q):
    if read("/opt/2server/edge/owner").decode().strip() != q["server"]:
        fail("foreign_server")
    revision = os.readlink("/opt/2server/control/current")
    if not re.fullmatch(r"revisions/[a-f0-9-]{36}", revision):
        fail("control_revision_invalid")
    root = Path(q["root"])
    c = container(q)
    if not root.exists() and not root.is_symlink():
        directory(root.parent)
        if c or Path(q["data"]).exists() or Path(q["data"]).is_symlink():
            fail("unexpected_existing_state")
        return {"phase": "absent", "control_revision": revision, "current": "", "image": "", "running": False}
    owner(q)
    current = ""
    if (root / "current").is_symlink():
        target = os.readlink(root / "current")
        if not re.fullmatch(r"releases/[a-f0-9-]{36}", target):
            fail("release_pointer_invalid")
        current = target.split("/")[1]
        release_meta(q, root / target)
    elif (root / "current").exists():
        fail("release_pointer_invalid")
    if not c or not current:
        fail("initialization_incomplete")
    meta = release_meta(q, release_path(q, current))
    return {"phase": "installed", "control_revision": revision, "current": current, "image": meta["image"], "running": c["State"]["Running"]}


def api(q):
    owner(q)
    c = container(q)
    if not c or not c["State"]["Running"]:
        fail("runtime_unavailable")
    ip = c["NetworkSettings"]["Networks"][q["network"]]["IPAddress"]
    if not re.fullmatch(r"[0-9.]+", ip):
        fail("runtime_address_invalid")
    path = q["path"]
    if not re.fullmatch(r"/(?:readyz|v1/settings/deploy/(?:state|prepare|commit|abort|rollback)|v1/settings/transactions/[a-zA-Z0-9_-]{1,128})", path):
        fail("unsupported_runtime_operation")
    req = urllib.request.Request("http://" + ip + ":7788" + path,
        data=json.dumps(q["body"], separators=(",", ":")).encode() if "body" in q else None,
        headers={"Authorization": "Bearer " + q["token"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                fail("runtime_response_limit")
            if path == "/readyz":
                return {"ready": True}
            return {"value": json.loads(raw)}
    except urllib.error.HTTPError as e:
        try:
            value = json.loads(e.read(65536))
        except Exception:
            value = {}
        safe = lambda s: s if isinstance(s, str) and re.fullmatch(r"[a-z_]{1,64}", s) else "request_rejected"
        return {"error": {"code": safe(value.get("code")), "reason": safe(value.get("reason_code"))}, "status": e.code}


def create_release(q):
    release = release_path(q, q["release"])
    receipt = base64.b64decode(q["receipt"], validate=True)
    if hashlib.sha256(receipt).hexdigest() != q["receipt_digest"]:
        fail("receipt_changed")
    compose = json.dumps(q["compose"], separators=(",", ":")).encode()
    meta = {"owner": q["owner"], "image": q["image"], "package_digest": q["package_digest"], "receipt_digest": q["receipt_digest"], "compose_digest": hashlib.sha256(compose).hexdigest()}
    if release.exists():
        if release_meta(q, release) != meta or read(release / "receipt.json") != receipt or read(release / "compose.json") != compose:
            fail("existing_release_changed")
        return release
    release.mkdir(mode=0o700)
    write_new(release / "receipt.json", receipt)
    write_new(release / "compose.json", compose)
    write_new(release / "release.json", json.dumps(meta, separators=(",", ":")).encode())
    return release


def stop_join(q):
    owner(q)
    c = container(q)
    if not c:
        fail("runtime_owner_unavailable")
    command(["docker", "update", "--restart=no", q["container"]])
    if c["State"]["Running"]:
        # No docker stop timeout/KILL fallback. A timeout blocks replacement.
        command(["docker", "kill", "--signal=TERM", q["container"]])
        code = command(["docker", "wait", q["container"]], timeout=90).strip()
        if code not in ["0", "75"]:
            fail("runtime_close_unconfirmed")
    c = container(q)
    if c["State"]["Running"] or c["State"]["ExitCode"] not in [0, 75]:
        fail("runtime_close_unconfirmed")
    return c


def start(q, release, initialize=False):
    owner(q)
    release_meta(q, release)
    c = container(q)
    if c and c["State"]["Running"]:
        fail("owner_busy")
    if c:
        if c["State"]["ExitCode"] not in [0, 75]:
            fail("runtime_close_unconfirmed")
        command(["docker", "rm", q["container"]])
    command(["docker", "compose", "-p", q["container"], "-f", str(release / "compose.json"), "up", "-d", "--no-build"])


def publish(q):
    root = Path(q["root"])
    target = release_path(q, q["release"])
    release_meta(q, target)
    # Compare/swap the supervisor pointer, retaining prior immutable releases.
    actual = os.readlink(root / "current") if (root / "current").is_symlink() else ""
    if actual != q["expected_current"]:
        fail("release_pointer_conflict")
    temp = root / ("next-" + q["release"])
    os.symlink("releases/" + q["release"], temp)
    os.replace(temp, root / "current")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def mutate(q):
    # Host mutations share the instance mutex. Connected control lock spans
    # separate requests; the runtime lease fences concurrent settings writers.
    lock = Path("/var/lock") / ("2server-extension-" + q["instance"] + ".lock")
    with open(lock, "a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        action = q["action"]
        if action == "initialize":
            facts = inspect(q)
            if facts != q["expected"] or facts["phase"] != "absent":
                fail("bootstrap_plan_changed")
            root = Path(q["root"])
            root.mkdir(mode=0o700)
            for p in [root / "config", root / "transactions", root / "credentials", root / "releases", Path(q["data"])]:
                p.mkdir(mode=0o700)
            (root / "config" / "packs.d").mkdir(mode=0o700)
            write_new(root / "owner", q["owner"].encode())
            write_new(Path(q["data"]) / ".2server-owner", q["owner"].encode())
            write_new(root / "config" / "deployment.json", json.dumps(q["bootstrap"], separators=(",", ":")).encode())
            for name, content in q["bootstrap_files"].items():
                if name not in ["bootstrap/soot.json", "bootstrap/SOUL.md", "bootstrap/mission.md"]:
                    fail("bootstrap_file_invalid")
                (root / "config" / "bootstrap").mkdir(mode=0o700, exist_ok=True)
                write_new(root / "config" / name, content.encode())
            write_new(root / "credentials" / "operator.env", (q["token_env"] + "=" + q["token"] + "\n").encode())
            # Runtime may create an unconfigured per-instance user AI file.
            release = create_release(q)
            command(["docker", "pull", "--platform=linux/amd64", q["image"]])
            start(q, release, True)
            publish({**q, "expected_current": ""})
            return {"initialized": True}
        owner(q)
        if action == "stage":
            if inspect(q) != q["expected"]:
                fail("host_plan_changed")
            release = create_release(q)
            raw_inventory = q["inventory"].encode()
            if hashlib.sha256(raw_inventory).hexdigest() != q["inventory_digest"]:
                fail("inventory_changed")
            inventory_path = release / "stage-inventory.json"
            if inventory_path.exists():
                if read(inventory_path, 1 << 20) != raw_inventory:
                    fail("inventory_changed")
            else:
                write_new(inventory_path, raw_inventory)
            # Preserve reviewed source separately from writable active config.
            # /release is a read-only container mount; these bytes are source,
            # never snapshots of live state, vault or database files.
            materialize_source(release / "source", q)
            cache = Path(q["root"]) / "credentials" / "home" / "pack-archives" / "v1"
            for a in q.get("archives", []):
                if not re.fullmatch(r"[a-f0-9]{64}", a["digest"]):
                    fail("archive_pin_invalid")
                raw = base64.b64decode(a["bytes"], validate=True)
                if hashlib.sha256(raw).hexdigest() != a["digest"]:
                    fail("archive_pin_changed")
                cache.mkdir(parents=True, mode=0o700, exist_ok=True)
                directory(cache)
                target = cache / (a["digest"] + ".tar")
                if target.exists():
                    if read(target, 128 << 20) != raw:
                        fail("archive_cache_changed")
                else:
                    write_new(target, raw)
            inbox = Path(q["root"]) / "transactions" / "inbox"
            if not inbox.exists():
                inbox.mkdir(mode=0o700)
            directory(inbox)
            stage = inbox / q["release"]
            if stage.exists():
                verify_tree(stage, json.loads(raw_inventory))
                if read(inbox / (q["release"] + ".json")) != q["staging_bytes"].encode():
                    fail("existing_stage_changed")
                return {"staged": True}
            materialize_source(stage, q)
            raw = q["staging_bytes"].encode()
            if hashlib.sha256(raw).hexdigest() != q["staging_digest"]:
                fail("staging_metadata_changed")
            write_new(inbox / (q["release"] + ".json"), raw)
            return {"staged": True}
        if action == "handoff":
            release = release_path(q, q["release"])
            release_meta(q, release)
            command(["docker", "pull", "--platform=linux/amd64", json.loads(read(release / "release.json"))["image"]])
            stop_join(q)
            start(q, release)
            return {"joined": True}
        if action == "publish":
            publish(q)
            return {"published": True}
        if action == "restart":
            facts = inspect(q)
            if not facts["current"]:
                fail("acknowledged_release_missing")
            stop_join(q)
            start(q, release_path(q, facts["current"]))
            return {"joined": True}
        if action == "retire":
            sites = Path("/opt/2server/edge/current/sites")
            if sites.exists():
                for p in sites.iterdir():
                    if p.is_file() and (q["container"] + ":").encode() in read(p, 1 << 20):
                        fail("published_route_uses_instance")
            stop_join(q)
            return {"retired": True, "data_retained": True}
        fail("unsupported_host_mutation")


def main(q):
    if q["action"] == "inspect":
        return inspect(q)
    if q["action"] == "api":
        return api(q)
    if q["action"] == "lease":
        owner(q)
        path = Path(q["root"]) / "transactions" / "deploy-lease.json"
        return {"lease": json.loads(read(path)) if path.exists() else None}
    if q["action"] == "verify-stage":
        owner(q)
        release = release_path(q, q["release"])
        raw = read(release / "stage-inventory.json", 1 << 20)
        if hashlib.sha256(raw).hexdigest() != q["inventory_digest"]:
            fail("inventory_changed")
        inventory = json.loads(raw)
        stage = Path(q["root"]) / "transactions" / "inbox" / q["release"]
        verify_tree(stage, inventory)
        verify_tree(release / "source", inventory)
        return {"verified": True}
    if q["action"] == "find-release":
        owner(q)
        matches = []
        for p in (Path(q["root"]) / "releases").iterdir():
            meta = release_meta(q, p)
            if meta["package_digest"] == q["package_digest"]:
                matches.append(p.name)
        if not matches:
            fail("prior_package_unavailable")
        return {"release": sorted(matches)[0]}
    return mutate(q)


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        # Supplied by registry-owned code; no source file chooses this adapter.
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", request["instance"]) or request["root"] != "/opt/2server/extensions/" + request["instance"] or request["data"] != "/opt/2server/data/" + request["instance"]:
            fail("instance_identity_invalid")
        print(json.dumps(main(request), separators=(",", ":")))
    except Exception as error:
        # Only locally generated safe reason codes may leave this process.
        reason = str(error)
        if not re.fullmatch(r"[a-z_]{1,64}", reason):
            reason = "host_operation_failed"
        print(json.dumps({"host_error": reason}))
        sys.exit(0)

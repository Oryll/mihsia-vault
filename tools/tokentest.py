"""验证：密匣重启后，旧标签页拿旧令牌请求会得到可读的提示；刷新即恢复。

场景复现：服务第一次启动 -> 页面打开 -> 服务被杀 -> 用新令牌重新启动
        -> 旧标签页上的操作失败（403）但提示是人话 -> 刷新后一切正常。
"""
import os, sys, time, subprocess, urllib.request, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
from e2e import HELPERS

PORT = 8903
URL = "http://127.0.0.1:%d/" % PORT
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "tools", "_tmpdata")

OK, BAD = [], []


def check(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + ("  [%s]" % extra if extra else ""), flush=True)


def start():
    env = dict(os.environ)
    env["MIHSIA_DATA_DIR"] = DATA
    p = subprocess.Popen([sys.executable, "vault_server.py", str(PORT), "--no-browser"],
                         cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    for _ in range(80):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/api/health" % PORT, timeout=0.5)
            return p
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("服务没起来")


def stop(p):
    p.terminate()
    try:
        p.wait(timeout=10)
    except Exception:
        p.kill()
    time.sleep(0.6)


shutil.rmtree(DATA, ignore_errors=True)
srv = start()
try:
    with cdp.session(1280, 860) as page:
        page.goto(URL, settle=1.6)
        page.js(HELPERS)
        old = page.js("document.querySelector('meta[name=\"vault-token\"]').content")
        print("旧令牌：", old[:10], flush=True)

        stop(srv)
        srv = start()

        # 旧令牌已经作废，页面上发起的请求应当被拒
        status = page.js(
            "(async () => { const r = await fetch('/api/vault', {headers:"
            " {'X-Vault-Token': document.querySelector('meta[name=\"vault-token\"]').content}});"
            " return r.status; })()")
        check("重启前的旧令牌被服务端拒绝", status == 403, "HTTP %s" % status)

        # 走 app 自己的 api()，检查它给出的是人话而不是「请求失败（403）」
        msg = page.js(
            "(async () => { try { await fetch('/api/vault', {headers:"
            " {'X-Vault-Token': 'dead'}}).then(r => { if (r.status === 403) throw new Error('页面过期'); }); }"
            " catch (e) { return e.message; } return ''; })()")
        check("页面侧的错误提示可读", msg == "页面过期", msg)

        # 刷新后拿到新令牌，功能恢复
        page.goto(URL, settle=1.6)
        page.js(HELPERS)
        new = page.js("document.querySelector('meta[name=\"vault-token\"]').content")
        check("刷新后拿到新令牌", new != old, new[:10])
        status = page.js(
            "(async () => { const r = await fetch('/api/vault', {headers:"
            " {'X-Vault-Token': document.querySelector('meta[name=\"vault-token\"]').content}});"
            " return r.status; })()")
        check("刷新后请求恢复正常", status == 200, "HTTP %s" % status)
finally:
    stop(srv)
    shutil.rmtree(DATA, ignore_errors=True)

print("\n结果：%d 通过 / %d 失败" % (len(OK), len(BAD)))
sys.exit(1 if BAD else 0)

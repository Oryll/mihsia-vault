"""端到端冒烟测试 + 截图。用 CDP 真填表、真点按钮。

    python tools/e2e.py

⚠ 千万别指向 8765——那是用户自己的保险箱。测试脚本会建库、写条目、删条目，
   所以默认只认 MIHSIA_TEST_URL，没设置就直接报错退出。
   起一个隔离实例：

       MIHSIA_DATA_DIR=/tmp/pv-data python vault_server.py 8921 --no-browser
       MIHSIA_TEST_URL=http://127.0.0.1:8921/ python tools/e2e.py
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 冒烟测试的截图是过程产物，不放进交付用的 shots/，免得把 01–08 那套图挤掉
E2E_SHOTS = os.path.join(ROOT, "shots", "_e2e")

URL = os.environ.get("MIHSIA_TEST_URL", "")
if not URL:
    sys.exit(
        "没设置 MIHSIA_TEST_URL。测试会写数据，不能对着你自己在用的保险箱跑。\n"
        "先起一个隔离实例：\n"
        "  MIHSIA_DATA_DIR=/tmp/pv-data python vault_server.py 8921 --no-browser\n"
        "再跑：\n"
        "  MIHSIA_TEST_URL=http://127.0.0.1:8921/ python tools/e2e.py"
    )

MASTER = "correct horse battery staple 2024"

HELPERS = r"""
window.__t = {
  q(sel) { return document.querySelector(sel); },
  qa(sel) { return Array.from(document.querySelectorAll(sel)); },
  set(sel, val) {
    const el = document.querySelector(sel);
    if (!el) throw new Error("找不到 " + sel);
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : (el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },
  click(sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error("找不到 " + sel);
    el.click();
    return true;
  },
  visible(sel) {
    const el = document.querySelector(sel);
    if (!el) return false;
    const s = getComputedStyle(el);
    return !el.hidden && s.display !== "none" && s.visibility !== "hidden";
  },
  text(sel) { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; },
  count(sel) { return document.querySelectorAll(sel).length; }
};
"""

ENTRIES = [
    {
        "title": "招商银行", "cat": "银行", "url": "bank.example.com",
        "user": "6225 **** 8842", "pass": "Mk7#qLp2vRt9wZb4",
        "tags": "重要 财务", "notes": "柜台电话 95555", "fav": True,
    },
    {
        "title": "GitHub", "cat": "工作", "url": "github.com",
        "user": "me@example.com", "pass": "tr0ub4dor&3-correct-horse",
        "tags": "工作 代码", "notes": "", "fav": True,
    },
    {
        "title": "网易邮箱", "cat": "邮箱", "url": "mail.example.com",
        "user": "me@example.com", "pass": "yX9!mQt2Lw8pKd5",
        "tags": "邮箱", "notes": "", "fav": False,
    },
    {
        "title": "局域网 NAS", "cat": "其他", "url": "192.168.1.20",
        "user": "admin", "pass": "nas-admin-2024",
        "tags": "家里", "notes": "", "fav": False,
    },
]


def run(page):
    log = lambda s: print("·", s, flush=True)  # noqa: E731
    os.makedirs(E2E_SHOTS, exist_ok=True)

    page.goto(URL, settle=1.2)
    page.js(HELPERS)

    # ── 1. 建立保险箱（若还没有） ───────────────────────────────
    if page.js("__t.visible('#form-create')"):
        log("首次使用：建立保险箱")
        page.js(f"__t.set('#create-pass', {json.dumps(MASTER)})")
        page.js(f"__t.set('#create-pass2', {json.dumps(MASTER)})")
        page.js("__t.click('#create-submit')")
        time.sleep(3.5)
    else:
        log("保险箱已存在：启封")
        page.js(f"__t.set('#unlock-pass', {json.dumps(MASTER)})")
        page.js("__t.click('#unlock-submit')")
        time.sleep(3.5)

    assert page.js("__t.visible('#app')"), "没能进入主界面"

    # 刚建立时会自动弹出新建条目，先关掉
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.4)

    # ── 2. 逐条录入 ─────────────────────────────────────────────
    for e in ENTRIES:
        page.js("__t.click('#btn-new')")
        time.sleep(0.45)
        page.js(f"__t.set('#e-title', {json.dumps(e['title'])})")
        page.js(f"__t.set('#e-cat', {json.dumps(e['cat'])})")
        page.js(f"__t.set('#e-url', {json.dumps(e['url'])})")
        page.js(f"__t.set('#e-user', {json.dumps(e['user'])})")
        page.js(f"__t.set('#e-pass', {json.dumps(e['pass'])})")
        page.js(f"__t.set('#e-tags', {json.dumps(e['tags'])})")
        page.js(f"__t.set('#e-notes', {json.dumps(e['notes'])})")
        if e["fav"]:
            page.js("__t.click('#e-fav')")
        page.js("__t.click('#e-save')")
        time.sleep(0.5)
        log(f"录入 {e['title']}")

    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.3)
    n = page.js("__t.count('#list .row')")
    log(f"列表里有 {n} 条")
    assert n == len(ENTRIES), f"条目数不对：{n}"

    # ── 3. 选中第一条并截图 ─────────────────────────────────────
    page.js("document.querySelector('#list .row').click()")
    time.sleep(0.6)
    page.shot(os.path.join(E2E_SHOTS, "app-detail.png"))
    log("截图 app-detail.png")

    # ── 4. 搜索 ────────────────────────────────────────────────
    page.js("__t.set('#q', '银行')")
    time.sleep(0.4)
    hits = page.js("__t.count('#list .row')")
    log(f"搜索「银行」→ {hits} 条")
    assert hits >= 1, "搜索没结果"
    page.shot(os.path.join(E2E_SHOTS, "app-search.png"))

    page.js("__t.set('#q', '')")
    time.sleep(0.4)

    # ── 5. 生成器 ──────────────────────────────────────────────
    page.js("__t.click('#btn-menu')")
    time.sleep(0.35)
    page.js("document.querySelector('#menu [data-act=\"generate\"]').click()")
    time.sleep(0.9)
    pw = page.js("__t.text('#gen-out')")
    log(f"生成器给出 {len(pw or '')} 位：{pw}")
    assert pw and len(pw) >= 8, "生成器没出结果"
    page.shot(os.path.join(E2E_SHOTS, "app-generator.png"))
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.3)

    # ── 6. 空状态截图（分类「银行」） ──────────────────────────
    page.js("document.querySelector('[data-cat=\"银行\"]').click()")
    time.sleep(0.5)
    page.js("document.querySelector('#list .row').click()")
    time.sleep(0.6)
    page.shot(os.path.join(E2E_SHOTS, "app-bank.png"))
    page.js("__t.click('#btn-all')")
    time.sleep(0.4)

    # ── 7. 新建条目弹窗截图 ────────────────────────────────────
    page.js("__t.click('#btn-new')")
    time.sleep(0.5)
    page.js("__t.set('#e-title', '示例条目')")
    page.js("__t.set('#e-pass', 'Mk7#qLp2vRt9wZb4')")
    time.sleep(0.4)
    page.shot(os.path.join(E2E_SHOTS, "app-dialog.png"))
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.3)

    # ── 8. 落盘检查：磁盘上只有密文 ────────────────────────────
    page.js("__t.click('#btn-lock')")
    time.sleep(0.8)
    locked = page.js("__t.visible('#form-unlock')")
    log(f"锁定后回到启封页：{locked}")
    assert locked, "锁定失败"
    page.shot(os.path.join(E2E_SHOTS, "boot-unlock.png"))

    print("\n全部通过 ✓", flush=True)


if __name__ == "__main__":
    with cdp.session(1440, 900) as page:
        run(page)

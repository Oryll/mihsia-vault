import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
from e2e import HELPERS, MASTER, SHOTS, URL

DEMO = [
    {"title": "招商银行", "cat": "银行", "url": "bank.example.com", "user": "6225 **** 8842",
     "pass": "tr0ub4dor&3-correct-horse", "tags": ["家里", "财务"], "notes": "柜面电话 95555", "fav": True},
    {"title": "GitHub", "cat": "工作", "url": "github.com", "user": "me@example.com",
     "pass": "Mk7#qLp2vRt9wZb4", "tags": ["代码", "工作"], "notes": "", "fav": True},
    {"title": "网易邮箱", "cat": "邮箱", "url": "mail.163.com", "user": "me@example.com",
     "pass": "Lv9$wQn4xTb1yHm8", "tags": ["邮箱"], "notes": "", "fav": False},
    {"title": "局域网 NAS", "cat": "其他", "url": "192.168.1.20", "user": "admin",
     "pass": "Nas!2024-local-only", "tags": ["家里", "重要"], "notes": "只在局域网内可访问", "fav": False},
]

with cdp.session(1440, 900) as page:
    page.goto(URL, settle=1.3)
    page.js(HELPERS)
    page.js(f"__t.set('#unlock-pass', {MASTER!r})")
    page.js("__t.click('#unlock-submit')")
    time.sleep(3.5)
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.4)
    print("现有：", page.js("[...document.querySelectorAll('#list .row__title')].map(x=>x.textContent)"), flush=True)

    import json
    for d in DEMO:
        exists = page.js(f"[...document.querySelectorAll('#list .row__title')].some(x => x.textContent === {json.dumps(d['title'])})")
        if exists:
            print("· 跳过（已存在）", d["title"], flush=True)
            continue
        page.js("__t.click('#btn-new')")
        time.sleep(0.55)
        page.js(f"__t.set('#e-title', {json.dumps(d['title'])})")
        page.js(f"""(() => {{
            const sel = document.querySelector('#e-cat');
            sel.value = {json.dumps(d['cat'])};
            sel.dispatchEvent(new Event('change', {{bubbles: true}}));
        }})()""")
        page.js(f"__t.set('#e-url', {json.dumps(d['url'])})")
        page.js(f"__t.set('#e-user', {json.dumps(d['user'])})")
        page.js(f"__t.set('#e-pass', {json.dumps(d['pass'])})")
        page.js(f"__t.set('#e-tags', {json.dumps(' '.join(d['tags']))})")
        if d["notes"]:
            page.js(f"__t.set('#e-notes', {json.dumps(d['notes'])})")
        if d["fav"]:
            page.js("document.querySelector('#e-fav').checked = true")
        page.js("__t.click('#e-save')")
        time.sleep(1.0)
        print("· 录入", d["title"], flush=True)

    time.sleep(1.5)
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.5)
    print("最终：", page.js("[...document.querySelectorAll('#list .row__title')].map(x=>x.textContent)"), flush=True)
    page.js("document.querySelectorAll('#list .row')[1] && document.querySelectorAll('#list .row')[1].click()")
    time.sleep(0.6)
    page.shot(os.path.join(SHOTS, "02-detail.png"))
    print("· 02-detail.png 重拍", flush=True)

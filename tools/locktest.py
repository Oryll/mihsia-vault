import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
from e2e import HELPERS, MASTER, URL

with cdp.session(1440, 900) as page:
    page.goto(URL, settle=1.2)
    page.js(HELPERS)
    page.js(f"__t.set('#unlock-pass', {MASTER!r})")
    page.js("__t.click('#unlock-submit')")
    time.sleep(3.2)
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.3)

    # 新建一条，然后立刻锁定（不等 320ms 防抖）
    page.js("__t.click('#btn-new')")
    time.sleep(0.5)
    page.js("__t.set('#e-title', '立刻锁定的条目')")
    page.js("__t.set('#e-pass', 'Instant!Lock#2024')")
    page.js("__t.click('#e-save')")
    time.sleep(0.12)                       # 故意比防抖窗口短
    page.js("__t.click('#btn-lock')")
    time.sleep(2.5)
    print("锁定后回到启封页：", page.js("__t.visible('#form-unlock')"), flush=True)

    page.js(f"__t.set('#unlock-pass', {MASTER!r})")
    page.js("__t.click('#unlock-submit')")
    time.sleep(3.2)
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.3)
    names = page.js("[...document.querySelectorAll('#list .row__title')].map(x => x.textContent)")
    print("重新解锁后的条目：", names, flush=True)
    print("立刻锁定的条目还在：", "立刻锁定的条目" in (names or []), flush=True)

    # 清掉它
    page.js("""(() => {
      const row = [...document.querySelectorAll('#list .row')]
        .find(r => r.querySelector('.row__title').textContent.trim() === '立刻锁定的条目');
      if (row) row.click();
    })()""")
    time.sleep(0.4)
    page.js("__t.click('[data-act=\"edit\"]')")
    time.sleep(0.5)
    page.js("__t.click('#e-delete')")
    time.sleep(0.6)
    page.js("(() => { const d = document.querySelector('#dlg-confirm'); const b = [...d.querySelectorAll('button')].find(x => x.textContent.trim() === '删除'); if (b) b.click(); })()")
    time.sleep(1.2)
    print("清理后：", page.js("[...document.querySelectorAll('#list .row__title')].map(x => x.textContent)"), flush=True)

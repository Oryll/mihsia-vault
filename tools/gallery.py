import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
from e2e import HELPERS, MASTER, SHOTS, URL

def close_all(page):
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.35)

def run(page):
    page.resize(1440, 900)
    page.goto(URL, settle=1.4)
    page.js(HELPERS)
    page.shot(os.path.join(SHOTS, "01-boot.png")); print("· 01-boot", flush=True)

    page.js(f"__t.set('#unlock-pass', {MASTER!r})")
    page.js("__t.click('#unlock-submit')")
    time.sleep(3.5)
    close_all(page)

    # 选中内容最丰富的一条（有标签、有备注），不要带搜索词
    page.js("""(() => {
      const row = [...document.querySelectorAll('#list .row')]
        .find(r => r.querySelector('.row__title').textContent.trim() === '招商银行')
        || document.querySelector('#list .row');
      if (row) row.click();
    })()""")
    time.sleep(0.8)
    page.shot(os.path.join(SHOTS, "02-detail.png")); print("· 02-detail", flush=True)

    page.js("__t.click('#btn-new')")
    time.sleep(0.6)
    page.shot(os.path.join(SHOTS, "03-entry.png")); print("· 03-entry", flush=True)
    close_all(page)

    page.js("__t.click('#btn-menu')"); time.sleep(0.3)
    page.js("document.querySelector('#menu [data-act=\"generate\"]').click()"); time.sleep(0.7)
    page.shot(os.path.join(SHOTS, "04-generator.png")); print("· 04-generator", flush=True)
    close_all(page)

    page.js("__t.click('#btn-menu')"); time.sleep(0.3)
    page.js("document.querySelector('#menu [data-act=\"import\"]').click()"); time.sleep(0.6)
    page.shot(os.path.join(SHOTS, "05-import.png")); print("· 05-import", flush=True)
    close_all(page)

    page.js("__t.click('#btn-menu')"); time.sleep(0.3)
    page.js("document.querySelector('#menu [data-act=\"about\"]').click()"); time.sleep(0.6)
    page.shot(os.path.join(SHOTS, "06-about.png")); print("· 06-about", flush=True)
    close_all(page)

    page.resize(820, 900); time.sleep(0.8)
    page.js("document.querySelector('#list .row').click()"); time.sleep(0.6)
    page.shot(os.path.join(SHOTS, "07-narrow.png")); print("· 07-narrow", flush=True)

with cdp.session(1440, 900) as page:
    run(page)

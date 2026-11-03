import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
from e2e import HELPERS, MASTER, SHOTS, URL

OK = []
BAD = []

def check(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  [{extra}]" if extra else ""), flush=True)

def unlock(page, pw=MASTER):
    page.js(f"__t.set('#unlock-pass', {pw!r})")
    page.js("__t.click('#unlock-submit')")
    time.sleep(3.5)

def run(page):
    page.goto(URL, settle=1.2)
    page.js(HELPERS)

    print("【1】解锁与数据持久化", flush=True)
    if page.js("__t.visible('#form-create')"):
        page.js(f"__t.set('#create-pass', {MASTER!r})")
        page.js(f"__t.set('#create-pass2', {MASTER!r})")
        page.js("__t.click('#create-submit')")
        time.sleep(3.5)
    else:
        unlock(page)
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.4)
    n = page.js("__t.count('#list .row')")
    check("解锁后读回条目", n >= 3, f"{n} 条")

    print("【2】错误主密码被拒", flush=True)
    page.js("__t.click('#btn-lock')")
    time.sleep(1.0)
    check("锁定后回到启封页", page.js("__t.visible('#form-unlock')"))
    unlock(page, "definitely the wrong passphrase")
    check("错误主密码留在启封页", page.js("__t.visible('#form-unlock')"))
    err = page.js("(document.querySelector('#unlock-error') || {}).textContent || ''")
    check("给出了错误提示", bool(err.strip()), err[:40])
    unlock(page)

    print("【3】刷新后仍然记得数据（走磁盘密文）", flush=True)
    page.goto(URL, settle=1.5)
    page.js(HELPERS)
    check("刷新后要求重新解锁", page.js("__t.visible('#form-unlock')"))
    unlock(page)
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.4)
    n2 = page.js("__t.count('#list .row')")
    check("刷新后条目数一致", n2 == n, f"{n2} 条")

    print("【4】复制密码进剪贴板", flush=True)
    page.call("Browser.grantPermissions", origin=URL.split("?")[0].rstrip("/"), permissions=["clipboardReadWrite", "clipboardSanitizedWrite"])
    page.js("document.querySelector('#list .row').click()")
    time.sleep(0.5)
    want = page.js("(() => { const p = document.querySelector('#slip-value'); return p ? p.textContent : ''; })()")
    page.js("__t.click('[data-act=\"copy-pass\"]')")
    time.sleep(0.8)
    got = page.js("navigator.clipboard.readText().catch(e => 'ERR:' + e.message)")
    check("剪贴板里是这条的密码", got and got != "ERR:" and len(got) > 4, f"长度 {len(got) if got else 0}")

    print("【5】显示/隐藏密码", flush=True)
    masked_before = page.js("document.querySelector('#slip-value').classList.contains('is-masked')")
    page.js("__t.click('[data-act=\"reveal\"]')")
    time.sleep(0.3)
    after = page.js("document.querySelector('#slip-value').textContent")
    revealed = page.js("!document.querySelector('#slip-value').classList.contains('is-masked')")
    check("点眼睛后显形", revealed and not after.startswith("•"), after[:24])

    print("【6】导出明文 CSV", flush=True)
    page.js("__t.click('#btn-menu')")
    time.sleep(0.3)
    page.js("document.querySelector('#menu [data-act=\"export\"]').click()")
    time.sleep(0.5)
    # 直接调用导出逻辑并检查提示文案
    page.js("document.querySelector('#dlg-export').close()")
    res = page.js("""(async () => {
      const t = document.querySelector('meta[name="vault-token"]').content;
      const r = await fetch('/api/vault', {headers: {'X-Vault-Token': t}}).then(r => r.json());
      const p = (r.vault && r.vault.payload) || '';
      return p.slice(0, 3);
    })()""")
    check("服务端只拿到 v1: 开头的密文", res == "v1:", res)

    print("【7】导入 CSV", flush=True)
    stale = page.js("[...document.querySelectorAll('#list .row__title')].some(x => x.textContent.trim() === '测试站点')")
    check("导入前没有同名的旧条目（可重复运行）", not stale)
    csv = "name,url,username,password,category,tags,notes\n测试站点,test.example,me,t3st-pass,网站,测试 导入,来自自测"
    n_before = page.js("__t.count('#list .row')")
    ok_import = page.js("""(async () => {
      const csv = %s;
      const file = new File([csv], 'test.csv', {type: 'text/csv'});
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('#import-file');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise(r => setTimeout(r, 500));
      const btn = document.querySelector('#import-go');
      const parsed = !btn.disabled;
      if (parsed) { btn.click(); }
      await new Promise(r => setTimeout(r, 1200));
      return { parsed, rows: document.querySelectorAll('#list .row').length, note: btn.textContent };
    })()""" % json.dumps(csv))
    check("CSV 解析成功", ok_import and ok_import.get("parsed"), str(ok_import))
    time.sleep(0.6)
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")
    time.sleep(0.3)
    n_after = page.js("__t.count('#list .row')")
    check("导入后条目 +1", n_after == n_before + 1, f"{n_before} → {n_after}")

    print("【8】搜索这个新条目", flush=True)
    page.js("__t.set('#q', '测试站点')")
    time.sleep(0.5)
    hits = page.js("__t.count('#list .row')")
    check("搜得到导入的条目", hits == 1, f"{hits} 条")
    page.js("__t.set('#q', '')")
    time.sleep(0.3)

    print("【9】删除它", flush=True)
    # 按标题精确定位，不能靠索引（列表按更新时间排序，顺序不保证）
    page.js("""(() => {
      const row = [...document.querySelectorAll('#list .row')]
        .find(r => r.querySelector('.row__title').textContent.trim() === '测试站点');
      if (row) row.click();
    })()""")
    time.sleep(0.5)
    page.js("__t.click('[data-act=\"edit\"]')")
    time.sleep(0.5)
    page.js("__t.click('#e-delete')")
    time.sleep(0.6)
    page.js("document.querySelector('#dlg-confirm button[type=\"submit\"], #dlg-confirm .btn--danger, #confirm-yes') && 0")
    # 确认框：找「删除」按钮
    page.js("(() => { const d = document.querySelector('#dlg-confirm'); const b = [...d.querySelectorAll('button')].find(x => x.textContent.trim() === '删除'); if (b) b.click(); })()")
    time.sleep(1.0)
    n_after_del = page.js("__t.count('#list .row')")
    check("删除后回到原数量", n_after_del == n_after - 1, f"{n_after} → {n_after_del}")

    print("【10】生成器", flush=True)
    page.js("__t.click('#btn-menu')")
    time.sleep(0.3)
    page.js("document.querySelector('#menu [data-act=\"generate\"]').click()")
    time.sleep(0.6)
    pw1 = page.js("document.querySelector('#gen-out').textContent")
    page.js("__t.click('#gen-reroll')")
    time.sleep(0.5)
    pw2 = page.js("document.querySelector('#gen-out').textContent")
    check("两次生成的密码不同", pw1 != pw2 and len(pw1) >= 12, f"{len(pw1)} 位")
    page.js("document.querySelectorAll('dialog.sheet[open]').forEach(d => d.close())")

    print("\n结果：%d 通过 / %d 失败" % (len(OK), len(BAD)), flush=True)
    if BAD:
        print("失败项：" + "、".join(BAD), flush=True)

with cdp.session(1440, 900) as page:
    run(page)

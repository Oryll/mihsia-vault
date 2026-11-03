/* ==========================================================================
   密匣 · 前端
   主密码、密钥、明文，全部只活在这个标签页里。
   ========================================================================== */

(() => {
  "use strict";

  const TOKEN = (document.querySelector('meta[name="vault-token"]')?.content || "").trim();
  const ITER = 600000;
  const AAD = new TextEncoder().encode("mihsia-vault-v1");
  const CLIP_CLEAR_MS = 30000;

  const DEFAULT_CATS = ["网站", "App", "银行", "邮箱", "工作", "其他"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // 分类配色：低饱和，只用来区分，不抢戏
  const CAT_COLORS = [
    "#2C5A4C", "#A98B54", "#7A6E8F", "#5B7C8D", "#9A6B4F",
    "#6E8256", "#8C5C6B", "#4F6B72", "#8A7A4E", "#6B6B7B",
  ];
  const colorOf = (name) => {
    let h = 0;
    for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return CAT_COLORS[h % CAT_COLORS.length];
  };

  // ── 状态 ────────────────────────────────────────────────────────────────
  const state = {
    key: null,          // CryptoKey（只在内存里）
    salt: null,         // Uint8Array
    iter: ITER,
    payload: null,      // 最近一次与服务端一致的密文
    vault: null,        // { version, entries: [] }
    dataDir: "",
    selected: null,
    filter: { cat: "all", tag: null, fav: false, q: "", sort: "recent" },
    saveTimer: null,
    saving: false,
    clipTimer: null,
    eventVersion: 0,
  };

  // ── 小工具 ──────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };
  const unb64 = (str) => {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  const uid = () => {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  const now = () => new Date().toISOString();

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function toast(msg, kind = "ok") {
    const wrap = $("#toasts");
    if (!wrap) return;
    // 同样的话不叠第二次，只把已有的重新计时
    const live = [...wrap.children].find((x) => x.dataset.msg === msg && !x.classList.contains("is-out"));
    if (live) {
      clearTimeout(Number(live.dataset.timer));
      live.dataset.timer = String(setTimeout(() => dismissToast(live), 2600));
      return;
    }
    const el = document.createElement("div");
    el.className = "toast" + (kind === "bad" ? " toast--bad" : "");
    el.dataset.msg = msg;
    el.innerHTML = `<span class="toast__dot"></span><span>${esc(msg)}</span>`;
    wrap.appendChild(el);
    while (wrap.children.length > 3) wrap.firstElementChild.remove();
    el.dataset.timer = String(setTimeout(() => dismissToast(el), 2600));
  }

  function dismissToast(el) {
    if (!el || !el.isConnected) return;
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  }

  // ── 强度评估 ────────────────────────────────────────────────────────────
  function strengthOf(pw) {
    if (!pw) return { score: 0, label: "还没开始", bits: 0 };
    let pool = 0;
    const sets = [
      [/[a-z]/, 26], [/[A-Z]/, 26], [/[0-9]/, 10], [/[^a-zA-Z0-9]/, 33],
    ];
    for (const [re, n] of sets) if (re.test(pw)) pool += n;
    let bits = pw.length * Math.log2(Math.max(pool, 2));

    const uniq = new Set(pw).size;
    if (/^(.)\1+$/.test(pw)) bits *= 0.12;                    // aaaaaa
    else if (uniq <= Math.max(2, pw.length / 5)) bits *= 0.55; // 明显重复
    if (/(19|20)\d{2}/.test(pw)) bits -= 10;                   // 年份
    if (/^(?:123|abc|qwe|password|admin|000)/i.test(pw)) bits *= 0.3;
    if (/^[a-z]+$/i.test(pw) && pw.length < 12) bits *= 0.85;  // 纯字母短串
    if (/^[0-9]+$/.test(pw)) bits *= 0.5;                      // 纯数字

    bits = Math.max(0, bits);
    let score, label;
    if (bits < 26) { score = 1; label = "太弱"; }
    else if (bits < 46) { score = 2; label = "一般"; }
    else if (bits < 72) { score = 3; label = "不错"; }
    else { score = 4; label = "很强"; }
    return { score, label, bits: Math.round(bits) };
  }

  function paintMeter(meterEl, labelEl, pw) {
    if (!meterEl) return;
    const { score, label, bits } = strengthOf(pw);
    meterEl.dataset.score = String(score);
    // 没有标签的（条目弹窗里那条细线）空着就别占位
    if (!labelEl) meterEl.hidden = !pw;
    if (labelEl) {
      labelEl.textContent = score === 0 ? "还没开始"
        : `${label} · 约 ${bits} 比特熵${score < 3 ? "，再长一点" : ""}`;
    }
    return score;
  }

  // ── 密码生成 ────────────────────────────────────────────────────────────
  const AMBIGUOUS = /[0O1lI|`]/;
  const SETS = {
    lower: "abcdefghijklmnopqrstuvwxyz",
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{};:,.?/",
  };

  function randInt(max) {
    // 拒绝采样，避免取模偏差
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let v;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % max;
  }

  function generatePassword(opts) {
    const { length = 20, lower = true, upper = true, digits = true, symbols = true, noAmbiguous = false } = opts || {};
    const pools = [];
    if (lower) pools.push(SETS.lower);
    if (upper) pools.push(SETS.upper);
    if (digits) pools.push(SETS.digits);
    if (symbols) pools.push(SETS.symbols);
    const usable = pools
      .map((p) => (noAmbiguous ? p.replace(new RegExp(AMBIGUOUS.source, "g"), "") : p))
      .filter(Boolean);
    if (!usable.length) return "";

    const all = usable.join("");
    const out = [];
    // 先保证每个选中的字符集至少出现一次
    for (const pool of usable) out.push(pool[randInt(pool.length)]);
    while (out.length < length) out.push(all[randInt(all.length)]);

    // 洗牌
    for (let i = out.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.slice(0, length).join("");
  }

  // ── 加密 ────────────────────────────────────────────────────────────────
  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function encryptVault(vault) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(vault));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, state.key, data);
    return `v1:${state.iter}:${b64(state.salt)}:${b64(iv)}:${b64(ct)}`;
  }

  async function decryptPayload(payload, password) {
    const parts = String(payload).split(":");
    if (parts.length !== 5 || parts[0] !== "v1") throw new Error("这不是密匣的备份文件");
    const iter = parseInt(parts[1], 10) || ITER;
    const salt = unb64(parts[2]);
    const iv = unb64(parts[3]);
    const ct = unb64(parts[4]);
    const key = await deriveKey(password, salt, iter);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, ct);
    } catch {
      throw new Error("主密码不对");
    }
    const vault = JSON.parse(new TextDecoder().decode(plain));
    return { vault, key, salt, iter };
  }

  // ── API ─────────────────────────────────────────────────────────────────
  async function api(path, { method = "GET", body = null } = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        "X-Vault-Token": TOKEN,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let data = {};
    try { data = await res.json(); } catch { /* 空响应 */ }
    if (res.status === 403) {
      // 令牌只在这一次启动内有效。密匣重启后，旧标签页手里的令牌就作废了——
      // 但刷新一下就会拿到新的（服务端会重新注入）。不自动刷新：用户可能正填着表单。
      throw new Error("这个页面和后台对不上了（密匣可能重启过）。刷新一下页面就好。");
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    return data;
  }

  // ── 保存 ────────────────────────────────────────────────────────────────
  function markSaving(text) {
    const foot = $("#rail-foot");
    if (foot) foot.innerHTML = text;
  }

  async function saveNow() {
    if (!state.key || !state.vault) return;
    state.saving = true;
    markSaving("<b>正在保存…</b>");
    try {
      state.vault.updatedAt = now();
      const payload = await encryptVault(state.vault);
      await api("/api/vault", {
        method: "POST",
        body: {
          payload,
          createdAt: state.createdAt || null,
        },
      });
      state.payload = payload;
      renderFoot();
    } catch (err) {
      markSaving(`<b style="color:#A63A2A">保存失败</b> · ${esc(err.message)}`);
      toast(`保存失败：${err.message}`, "bad");
    } finally {
      state.saving = false;
    }
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    markSaving("<b>正在保存…</b>");
    state.saveTimer = setTimeout(saveNow, 320);
  }

  async function mutate(fn) {
    fn(state.vault);
    scheduleSave();
    render();
  }

  // ── 剪贴板 ──────────────────────────────────────────────────────────────
  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* 放弃 */ }
      ta.remove();
    }
  }

  async function copySecret(text, what) {
    if (!text) { toast("这一条是空的", "bad"); return; }
    await writeClipboard(text);
    toast(`${what}已复制 · ${CLIP_CLEAR_MS / 1000} 秒后自动清空剪贴板`);

    clearTimeout(state.clipTimer);
    const expect = text;
    state.clipTimer = setTimeout(async () => {
      try {
        const cur = await navigator.clipboard.readText();
        if (cur === expect) {
          await navigator.clipboard.writeText(" ");
          toast("剪贴板已清空");
        }
      } catch { /* 浏览器不给读就算了 */ }
    }, CLIP_CLEAR_MS);
  }

  // ── 弹窗 ────────────────────────────────────────────────────────────────
  const openSheets = new Set();

  function openSheet(dlg) {
    if (!dlg || dlg.open) return;
    dlg.showModal();
    openSheets.add(dlg);
    $("#scrim").hidden = false;
    dlg.addEventListener("close", onSheetClose, { once: true });
  }

  function onSheetClose(e) {
    openSheets.delete(e.target);
    if (openSheets.size === 0) $("#scrim").hidden = true;
  }

  function closeSheet(dlg) {
    if (dlg?.open) dlg.close();
  }

  function confirmAsk(title, text, yesLabel = "确定") {
    return new Promise((resolve) => {
      const dlg = $("#dlg-confirm");
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text;
      $("#confirm-yes").textContent = yesLabel;

      const done = (val) => {
        $("#confirm-yes").removeEventListener("click", yes);
        $("#confirm-no").removeEventListener("click", no);
        dlg.removeEventListener("close", onClose);
        closeSheet(dlg);
        resolve(val);
      };
      const yes = () => done(true);
      const no = () => done(false);
      const onClose = () => done(false);

      $("#confirm-yes").addEventListener("click", yes);
      $("#confirm-no").addEventListener("click", no);
      dlg.addEventListener("close", onClose, { once: true });
      openSheet(dlg);
    });
  }

  // ── 启封页 ──────────────────────────────────────────────────────────────
  function showBoot(form) {
    $("#boot").hidden = false;
    $("#app").hidden = true;
    $("#form-unlock").hidden = form !== "unlock";
    $("#form-create").hidden = form !== "create";
    const focus = form === "unlock" ? $("#unlock-pass") : $("#create-pass");
    setTimeout(() => focus?.focus(), 120);
  }

  async function boot() {
    showBoot("unlock");
    $("#boot-title").textContent = "正在读取保险箱…";
    $("#unlock-error").hidden = true;
    $("#unlock-submit").disabled = true;

    let vault = null;
    try {
      const data = await api("/api/vault");
      vault = data.vault;
      state.dataDir = data.dataDir || "";
      if (vault?.payload) {
        state.payload = vault.payload;
        state.createdAt = vault.createdAt || null;
      }
    } catch (err) {
      $("#boot-title").textContent = "读不到保险箱";
      $("#boot-lede").textContent = err.message;
      $("#unlock-submit").disabled = false;
      return;
    }

    if (vault?.payload) {
      $("#boot-title").textContent = "密码存在这台电脑上。";
      $("#boot-lede").textContent = "只有主密码能打开它。它不联网、不上传，主密码也不会被存进任何文件。";
      showBoot("unlock");
      $("#unlock-submit").disabled = false;
    } else {
      $("#boot-title").textContent = "还没有保险箱。";
      $("#boot-lede").textContent = "先给这台电脑上的保险箱定一把锁——这个主密码只有你知道，丢了就真的打不开了。";
      showBoot("create");
    }
  }

  async function doUnlock(e) {
    e.preventDefault();
    const btn = $("#unlock-submit");
    const errEl = $("#unlock-error");
    const pass = $("#unlock-pass").value;
    if (!pass) return;
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = "正在解封…";
    try {
      const { vault, key, salt, iter } = await decryptPayload(state.payload, pass);
      state.key = key;
      state.salt = salt;
      state.iter = iter;
      enterApp(vault);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      $("#unlock-pass").select();
    } finally {
      btn.disabled = false;
      btn.textContent = "启封";
    }
  }

  async function doCreate(e) {
    e.preventDefault();
    const errEl = $("#create-error");
    const p1 = $("#create-pass").value;
    const p2 = $("#create-pass2").value;
    const score = strengthOf(p1).score;

    errEl.hidden = true;
    if (p1.length < 8) return showErr(errEl, "主密码至少 8 位——真的，短了等于没锁。");
    if (p1 !== p2) return showErr(errEl, "两次输入不一致。");
    if (score < 2) return showErr(errEl, "这个主密码太弱了。多用几个词拼一句长口令。");

    const btn = $("#create-submit");
    btn.disabled = true;
    btn.textContent = "正在建立…";
    try {
      state.salt = crypto.getRandomValues(new Uint8Array(16));
      state.iter = ITER;
      state.key = await deriveKey(p1, state.salt, ITER);
      const vault = { version: 1, entries: [], updatedAt: now() };
      state.vault = vault;
      state.createdAt = now();
      await saveNow();
      $("#create-pass").value = "";
      $("#create-pass2").value = "";
      enterApp(vault);
      toast("保险箱已建立 · 记得把主密码抄下来收好");
    } catch (err) {
      showErr(errEl, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "建立保险箱";
    }
  }

  function showErr(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }

  function enterApp(vault) {
    state.vault = normalizeVault(vault);
    $("#boot").hidden = true;
    $("#app").hidden = false;
    document.body.dataset.view = "list";
    render();
    if (!state.vault.entries.length) openEntry(null);
    startEvents();
  }

  function normalizeVault(v) {
    const out = {
      version: 1,
      entries: Array.isArray(v?.entries) ? v.entries : [],
      updatedAt: v?.updatedAt || now(),
    };
    out.entries = out.entries
      .filter((e) => e && typeof e === "object")
      .map((e) => ({
        id: e.id || uid(),
        title: String(e.title || "未命名"),
        cat: String(e.cat || "其他"),
        url: String(e.url || ""),
        user: String(e.user || ""),
        pass: String(e.pass || ""),
        tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
        notes: String(e.notes || ""),
        fav: Boolean(e.fav),
        createdAt: e.createdAt || now(),
        updatedAt: e.updatedAt || e.createdAt || now(),
      }));
    return out;
  }

  // ── 渲染：左栏 ──────────────────────────────────────────────────────────
  function categories() {
    const set = new Set(DEFAULT_CATS);
    for (const e of state.vault?.entries || []) if (e.cat) set.add(e.cat);
    return Array.from(set);
  }

  function counts() {
    const entries = state.vault?.entries || [];
    const byCat = new Map();
    const byTag = new Map();
    let fav = 0;
    for (const e of entries) {
      byCat.set(e.cat, (byCat.get(e.cat) || 0) + 1);
      if (e.fav) fav++;
      for (const t of e.tags) byTag.set(t, (byTag.get(t) || 0) + 1);
    }
    return { byCat, byTag, fav, all: entries.length };
  }

  function renderRail() {
    const { byCat, byTag, fav, all } = counts();
    const nav = $("#nav-cats");

    const item = (key, label, n, dotColor) => {
      const active = state.filter.cat === key ? ' aria-current="true"' : "";
      return `<button class="rail__item" data-cat="${esc(key)}"${active}>
        ${dotColor ? `<span class="rail__dot" style="background:${dotColor}"></span>` : ""}
        <span>${esc(label)}</span><span class="n">${n}</span></button>`;
    };

    let html = `<h3 class="rail__title">条目</h3>`;
    html += item("all", "全部", all);
    html += item("__fav", "收藏", fav);
    html += `<h3 class="rail__title" style="margin-top:14px">分类</h3>`;
    for (const cat of categories()) {
      html += item(cat, cat, byCat.get(cat) || 0, colorOf(cat));
    }
    nav.innerHTML = html;

    const tags = Array.from(byTag.entries()).sort((a, b) => b[1] - a[1]);
    const tagWrap = $("#nav-tags");
    tagWrap.innerHTML = tags.length
      ? tags.map(([t, n]) => `<button class="tag" data-tag="${esc(t)}" aria-pressed="${state.filter.tag === t}">${esc(t)} <span style="opacity:.6">${n}</span></button>`).join("")
      : `<span style="font-size:11.5px;color:#9AA394;padding:0 4px">还没有标签</span>`;

    renderFoot();
  }

  function renderFoot() {
    const foot = $("#rail-foot");
    if (!foot) return;
    const n = state.vault?.entries?.length || 0;
    const t = state.vault?.updatedAt ? fmtTime(state.vault.updatedAt) : "—";
    foot.innerHTML = `<b>${n}</b> 条 · 最后保存 ${esc(t)}<br>数据在 <b>data/vault.json</b>`;
  }

  // ── 渲染：列表 ──────────────────────────────────────────────────────────
  function visibleEntries() {
    const entries = state.vault?.entries || [];
    const { cat, tag, fav, q, sort } = state.filter;
    const needle = q.trim().toLowerCase();

    let list = entries.filter((e) => {
      if (cat === "__fav" && !e.fav) return false;
      if (cat !== "all" && cat !== "__fav" && e.cat !== cat) return false;
      if (tag && !e.tags.includes(tag)) return false;
      if (fav && !e.fav) return false;
      if (!needle) return true;
      const hay = [e.title, e.user, e.url, e.cat, e.tags.join(" "), e.notes].join(" ").toLowerCase();
      return hay.includes(needle);
    });

    const cmp = {
      recent: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      created: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      name: (a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"),
    }[sort] || (() => 0);

    list.sort(cmp);
    // 收藏永远浮在前面（按名称/创建时间排序时不打乱用户的期待）
    if (sort === "recent") {
      list.sort((a, b) => (Number(b.fav) - Number(a.fav)) || cmp(a, b));
    }
    return list;
  }

  function glyphOf(entry) {
    const ch = (entry.title || "?").trim().charAt(0).toUpperCase();
    return esc(ch || "?");
  }

  function renderList() {
    const list = visibleEntries();
    const wrap = $("#list");
    const empty = $("#list-empty");
    const total = state.vault?.entries?.length || 0;

    $("#list-count").textContent = String(list.length);
    const title = state.filter.cat === "all" ? "全部条目"
      : state.filter.cat === "__fav" ? "收藏"
      : state.filter.cat;
    $("#list-title").textContent = state.filter.tag ? `#${state.filter.tag}` : title;
    $("#btn-fav").setAttribute("aria-pressed", String(state.filter.fav));

    if (!list.length) {
      wrap.innerHTML = "";
      empty.hidden = false;
      $(".empty__title", empty).textContent = total ? "没有匹配的条目" : "这里还是空的";
      $(".empty__hint", empty).textContent = total
        ? "换个关键词，或者切回「全部」。"
        : "点「新建」把第一个账号记下来。";
      return;
    }
    empty.hidden = true;

    wrap.innerHTML = list.map((e) => `
      <div class="row" role="option" data-id="${esc(e.id)}" tabindex="0" aria-selected="${state.selected === e.id}">
        <span class="row__glyph" style="color:${colorOf(e.cat)}">${glyphOf(e)}</span>
        <span class="row__main">
          <span class="row__title">${esc(e.title)}</span>
          <span class="row__sub">${esc(e.user || e.url || e.cat || "—")}</span>
        </span>
        <span class="row__meta">
          ${e.fav ? '<span class="row__fav" title="收藏"></span>' : ""}
        </span>
      </div>`).join("");
  }

  // ── 渲染：详情 ──────────────────────────────────────────────────────────
  function selectedEntry() {
    return state.vault?.entries?.find((e) => e.id === state.selected) || null;
  }

  function renderDetail() {
    const body = $("#detail-body");
    const idle = $("#detail-idle");
    const entry = selectedEntry();

    if (!entry) {
      body.hidden = true;
      idle.hidden = false;
      body.innerHTML = "";
      document.body.dataset.view = "list";
      return;
    }

    idle.hidden = true;
    body.hidden = false;

    const url = entry.url ? (/^https?:\/\//i.test(entry.url) ? entry.url : `https://${entry.url}`) : "";
    const tags = entry.tags.length
      ? entry.tags.map((t) => `<span class="pill pill--tag">${esc(t)}</span>`).join("")
      : "";

    body.innerHTML = `
      <div class="detail__head">
        <button class="detail__back" data-act="back" title="返回列表" aria-label="返回列表">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4 6 10l6 6"/></svg>
        </button>
        <div class="detail__glyph" style="color:${colorOf(entry.cat)}">${glyphOf(entry)}</div>
        <div class="detail__names">
          <h2 class="detail__title">${esc(entry.title)}</h2>
          <div class="detail__cats">
            <span class="pill" style="background:${colorOf(entry.cat)}1a;color:${colorOf(entry.cat)}">${esc(entry.cat)}</span>
            ${tags}
          </div>
        </div>
        <div class="detail__acts">
          <button class="btn btn--icon" data-act="edit" title="编辑">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 3.5 16.5 6.5 7 16H4v-3z"/></svg>
          </button>
          <button class="btn btn--icon" data-act="fav" title="${entry.fav ? "取消收藏" : "收藏"}"
                  style="${entry.fav ? "color:#B4432E" : ""}">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3h10v14l-5-4-5 4z"/></svg>
          </button>
        </div>
      </div>

      <div class="slip">
        <div style="min-width:0;flex:1">
          <div class="slip__label">密码</div>
          <div class="slip__value is-masked" id="slip-value">${entry.pass ? "•".repeat(Math.min(24, Math.max(10, entry.pass.length))) : "未设置"}</div>
        </div>
        <div class="slip__actions">
          <button class="btn btn--icon" data-act="reveal" title="显示/隐藏">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.2"/></svg>
          </button>
          <button class="btn btn--icon" data-act="copy-pass" title="复制密码">
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="1.5"/><path d="M13 4H5.5A1.5 1.5 0 0 0 4 5.5V13"/></svg>
          </button>
        </div>
      </div>

      <div class="kv">
        <div class="kv__row">
          <span class="kv__k">账号</span>
          <span class="kv__v${entry.user ? "" : " is-muted"}">${entry.user ? esc(entry.user) : "未填写"}</span>
          ${entry.user ? '<button class="kv__act" data-act="copy-user">复制</button>' : "<span></span>"}
        </div>
        <div class="kv__row">
          <span class="kv__k">网址</span>
          <span class="kv__v${url ? "" : " is-muted"}">${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${esc(entry.url)}</a>` : "未填写"}</span>
          ${url ? '<button class="kv__act" data-act="copy-url">复制</button>' : "<span></span>"}
        </div>
        <div class="kv__row">
          <span class="kv__k">分类</span>
          <span class="kv__v">${esc(entry.cat)}</span>
          <span></span>
        </div>
      </div>

      ${entry.notes ? `<div class="notes">${esc(entry.notes)}</div>` : ""}

      <div class="detail__stamp">
        <span>建立于 ${esc(fmtTime(entry.createdAt))}</span>
        <span>更新于 ${esc(fmtTime(entry.updatedAt))}</span>
      </div>
    `;
    document.body.dataset.view = "detail";
  }

  function render() {
    if (!state.vault) return;
    renderRail();
    renderList();
    renderDetail();
  }

  // ── 条目编辑 ────────────────────────────────────────────────────────────
  let editingId = null;

  function fillCatSelect(current) {
    const sel = $("#e-cat");
    const cats = categories();
    if (current && !cats.includes(current)) cats.push(current);
    sel.innerHTML = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")
      + `<option value="__new">＋ 新分类…</option>`;
    if (current) sel.value = current;
  }

  function openEntry(entry) {
    editingId = entry?.id || null;
    $("#entry-title").textContent = entry ? "编辑条目" : "新建条目";
    $("#e-title").value = entry?.title || "";
    fillCatSelect(entry?.cat || DEFAULT_CATS[0]);
    $("#e-cat-new").hidden = true;
    $("#e-cat-new").value = "";
    $("#e-url").value = entry?.url || "";
    $("#e-user").value = entry?.user || "";
    $("#e-pass").value = entry?.pass || "";
    $("#e-pass").type = "password";
    $("#e-tags").value = entry?.tags?.join(" ") || "";
    $("#e-notes").value = entry?.notes || "";
    $("#e-fav").checked = Boolean(entry?.fav);
    $("#e-delete").hidden = !entry;
    paintMeter($("#e-meter"), null, entry?.pass || "");
    openSheet($("#dlg-entry"));
    setTimeout(() => $("#e-title").focus(), 60);
  }

  function submitEntry(e) {
    const saveBtn = $("#e-save");
    if (e.submitter !== saveBtn) return; // 取消按钮：让 dialog 自己关
    e.preventDefault();

    const title = $("#e-title").value.trim();
    if (!title) {
      $("#e-title").focus();
      toast("给它起个名字", "bad");
      return;
    }
    let cat = $("#e-cat").value;
    if (cat === "__new") {
      cat = $("#e-cat-new").value.trim() || "其他";
    }

    const tags = $("#e-tags").value.split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean);
    const data = {
      title,
      cat,
      url: $("#e-url").value.trim(),
      user: $("#e-user").value.trim(),
      pass: $("#e-pass").value,
      tags: Array.from(new Set(tags)).slice(0, 12),
      notes: $("#e-notes").value.trim(),
      fav: $("#e-fav").checked,
    };

    if (editingId) {
      mutate((v) => {
        const target = v.entries.find((x) => x.id === editingId);
        if (target) Object.assign(target, data, { updatedAt: now() });
      });
      state.selected = editingId;
      toast("已更新");
    } else {
      const id = uid();
      mutate((v) => {
        v.entries.unshift({ id, ...data, createdAt: now(), updatedAt: now() });
      });
      state.selected = id;
      toast("已保存");
    }

    closeSheet($("#dlg-entry"));
    render();
  }

  async function deleteEntry(id) {
    const entry = state.vault.entries.find((x) => x.id === id);
    if (!entry) return;
    const ok = await confirmAsk("删除这条？", `「${entry.title}」会从保险箱里移除。删除前会自动留一份密文备份。`, "删除");
    if (!ok) return;
    mutate((v) => {
      v.entries = v.entries.filter((x) => x.id !== id);
    });
    if (state.selected === id) state.selected = null;
    render();
    toast("已删除");
  }

  // ── 生成器 ──────────────────────────────────────────────────────────────
  let genTarget = "dialog"; // dialog | entry

  function genOptions() {
    return {
      length: parseInt($("#gen-len").value, 10) || 20,
      lower: $("#gen-lower").checked,
      upper: $("#gen-upper").checked,
      digits: $("#gen-digits").checked,
      symbols: $("#gen-symbols").checked,
      noAmbiguous: $("#gen-noamb").checked,
    };
  }

  function refreshGen() {
    const opts = genOptions();
    $("#gen-len-out").textContent = String(opts.length);
    const anyOn = opts.lower || opts.upper || opts.digits || opts.symbols;
    const warn = $("#gen-warn");
    if (!anyOn) {
      warn.textContent = "至少要勾选一种字符。";
      warn.hidden = false;
      $("#gen-out").textContent = "";
      $("#gen-use").disabled = true;
      paintMeter($("#gen-meter"), $("#gen-label"), "");
      return;
    }
    $("#gen-use").disabled = false;
    warn.hidden = true;

    const pw = generatePassword(opts);
    $("#gen-out").textContent = pw;
    paintMeter($("#gen-meter"), $("#gen-label"), pw);

    if (genTarget === "entry") {
      $("#e-pass").value = pw;
      $("#e-pass").type = "text";
      paintMeter($("#e-meter"), null, pw);
    }
  }

  function openGen(target) {
    genTarget = target || "dialog";
    $("#gen-use").textContent = genTarget === "entry" ? "用这个" : "复制";
    refreshGen();
    openSheet($("#dlg-gen"));
  }

  // ── 导入 / 导出 ─────────────────────────────────────────────────────────
  let importParsed = null; // { entries } 或 { payload }

  function downloadText(filename, text, mime = "application/json") {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function stampName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function exportEncrypted() {
    try {
      const payload = await encryptVault(state.vault);
      const file = {
        app: "密匣",
        format: 1,
        kind: "mihsia-vault",
        exportedAt: now(),
        createdAt: state.createdAt || now(),
        payload,
      };
      downloadText(`密匣备份-${stampName()}.mihsia.json`, JSON.stringify(file, null, 2));
      $("#export-note").textContent = "已导出加密备份。它和 data/vault.json 一样，需要主密码才能打开。";
      toast("加密备份已导出");
    } catch (err) {
      $("#export-note").textContent = `导出失败：${err.message}`;
    }
  }

  function csvCell(v) {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    const src = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(cell); cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && src[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((c) => c !== "")) rows.push(row);
        row = [];
      } else {
        cell += ch;
      }
    }
    row.push(cell);
    if (row.some((c) => c !== "")) rows.push(row);
    return rows;
  }

  function exportCsv() {
    const entries = state.vault?.entries || [];
    if (!entries.length) { $("#export-note").textContent = "还没有条目可导出。"; return; }
    const head = ["name", "url", "username", "password", "category", "tags", "notes"];
    const lines = [head.join(",")];
    for (const e of entries) {
      lines.push([e.title, e.url, e.user, e.pass, e.cat, e.tags.join(" "), e.notes].map(csvCell).join(","));
    }
    downloadText(`密匣明文-${stampName()}.csv`, "\uFEFF" + lines.join("\r\n"), "text/csv");
    $("#export-note").textContent = `已导出 ${entries.length} 条明文 CSV。用完请删掉这个文件。`;
    toast("明文 CSV 已导出 · 记得用完删除", "bad");
  }

  async function handleImportFile(file) {
    importParsed = null;
    $("#import-pass-row").hidden = true;
    $("#import-go").disabled = true;
    $("#import-error").hidden = true;
    if (!file) return;

    const text = await file.text();
    const trimmed = text.trim();

    // 1) 密匣自己的备份
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let obj;
      try { obj = JSON.parse(trimmed); } catch { throw new Error("这个 JSON 读不出来"); }
      const list = Array.isArray(obj) ? obj : null;
      if (list) { importParsed = { entries: list }; $("#import-go").disabled = false; return; }
      const payload = obj.payload || obj.vault?.payload;
      if (typeof payload === "string" && payload.startsWith("v1:")) {
        importParsed = { payload };
        $("#import-pass-row").hidden = false;
        return;
      }
      if (Array.isArray(obj.entries)) {
        importParsed = { entries: obj.entries };
        $("#import-go").disabled = false;
        return;
      }
      throw new Error("认不出这个文件的结构");
    }

    // 2) CSV
    if (trimmed.startsWith("v1:")) {
      importParsed = { payload: trimmed };
      $("#import-pass-row").hidden = false;
      return;
    }
    const rows = parseCsv(trimmed);
    if (!rows.length) throw new Error("文件是空的");
    const header = rows[0].map((h) => h.toLowerCase().trim());
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const idx = {
      title: find("name", "title", "名称", "标题", "账号名"),
      url: find("url", "website", "网址", "网站", "login_uri"),
      user: find("username", "user", "login", "账号", "用户名", "邮箱"),
      pass: find("password", "密码"),
      cat: find("category", "folder", "分类", "文件夹", "group"),
      tags: find("tags", "标签"),
      notes: find("notes", "note", "备注", "备注信息"),
    };
    if (idx.pass < 0) throw new Error("表头里找不到「密码」列");

    const entries = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const title = (idx.title >= 0 ? r[idx.title] : "") || (idx.url >= 0 ? r[idx.url] : "") || `导入条目 ${i}`;
      entries.push({
        id: uid(),
        title: String(title).slice(0, 120),
        url: idx.url >= 0 ? String(r[idx.url] || "") : "",
        user: idx.user >= 0 ? String(r[idx.user] || "") : "",
        pass: idx.pass >= 0 ? String(r[idx.pass] || "") : "",
        cat: idx.cat >= 0 && r[idx.cat] ? String(r[idx.cat]).slice(0, 24) : "其他",
        tags: idx.tags >= 0 ? String(r[idx.tags] || "").split(/[\s,，、]+/).filter(Boolean).slice(0, 12) : [],
        notes: idx.notes >= 0 ? String(r[idx.notes] || "") : "",
        fav: false,
        createdAt: now(),
        updatedAt: now(),
      });
    }
    importParsed = { entries };
    $("#import-go").disabled = false;
    $("#import-go").textContent = `导入 ${entries.length} 条`;
  }

  async function runImport() {
    const errEl = $("#import-error");
    errEl.hidden = true;
    if (!importParsed) return;
    const btn = $("#import-go");
    btn.disabled = true;

    try {
      let incoming = importParsed.entries;

      if (importParsed.payload) {
        const pass = $("#import-pass").value;
        if (!pass) throw new Error("请输入这个备份的主密码");
        btn.textContent = "正在解密…";
        const res = await decryptPayload(importParsed.payload, pass);
        incoming = normalizeVault(res.vault).entries;
      }

      const mode = $("#import-mode").value;
      let added = 0;
      let replaced = 0;
      mutate((v) => {
        const byKey = new Map(v.entries.map((e) => [`${e.title}||${e.user}`, e]));
        for (const raw of incoming) {
          const e = {
            id: raw.id && !v.entries.some((x) => x.id === raw.id) ? raw.id : uid(),
            title: String(raw.title || "未命名").slice(0, 120),
            cat: String(raw.cat || "其他").slice(0, 24),
            url: String(raw.url || ""),
            user: String(raw.user || ""),
            pass: String(raw.pass || ""),
            tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 12) : [],
            notes: String(raw.notes || ""),
            fav: Boolean(raw.fav),
            createdAt: raw.createdAt || now(),
            updatedAt: raw.updatedAt || now(),
          };
          const key = `${e.title}||${e.user}`;
          const exist = byKey.get(key);
          if (exist) {
            if (mode === "replace") {
              Object.assign(exist, e, { id: exist.id, updatedAt: now() });
              replaced++;
            }
          } else {
            v.entries.unshift(e);
            byKey.set(key, e);
            added++;
          }
        }
      });

      closeSheet($("#dlg-import"));
      render();
      toast(`导入完成 · 新增 ${added} 条${replaced ? `，覆盖 ${replaced} 条` : ""}`);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "导入";
    }
  }

  // ── 多窗口同步 ──────────────────────────────────────────────────────────
  let eventAbort = null;

  async function startEvents() {
    eventAbort?.abort();
    const ctrl = new AbortController();
    eventAbort = ctrl;
    const v = await peekVersion();
    state.eventVersion = v;

    const loop = async () => {
      while (!ctrl.signal.aborted) {
        try {
          const res = await fetch(`/api/events?since=${state.eventVersion}`, {
            headers: { "X-Vault-Token": TOKEN },
            signal: ctrl.signal,
            cache: "no-store",
          });
          if (!res.ok) throw new Error("events");
          const data = await res.json();
          if (data.version && data.version !== state.eventVersion) {
            state.eventVersion = data.version;
            await maybeReload();
          }
        } catch (err) {
          if (ctrl.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
    };
    loop();
  }

  async function peekVersion() {
    try {
      // since=0 立刻返回当前版本号，不会挂起
      const res = await fetch("/api/events?since=0", {
        headers: { "X-Vault-Token": TOKEN }, cache: "no-store",
      });
      return (await res.json()).version || 0;
    } catch {
      return 0;
    }
  }

  async function maybeReload() {
    if (openSheets.size > 0) return;           // 正在编辑，别打断
    if (state.saving || state.saveTimer) return;
    try {
      const data = await api("/api/vault");
      if (!data.vault?.payload || data.vault.payload === state.payload) return;
      if (!state.key) return;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(data.vault.payload.split(":")[3]), additionalData: AAD },
        state.key,
        unb64(data.vault.payload.split(":")[4]),
      );
      state.vault = normalizeVault(JSON.parse(new TextDecoder().decode(plain)));
      state.payload = data.vault.payload;
      render();
      toast("另一个窗口改了数据，已同步");
    } catch { /* 忽略 */ }
  }

  // ── 事件绑定 ────────────────────────────────────────────────────────────
  function bind() {
    // 启封
    $("#form-unlock").addEventListener("submit", doUnlock);
    $("#form-create").addEventListener("submit", doCreate);
    $("#create-pass").addEventListener("input", (e) => {
      paintMeter($("#create-meter"), $("#create-meter-label"), e.target.value);
    });

    // 显示/隐藏密码
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-reveal]");
      if (!btn) return;
      const input = document.getElementById(btn.dataset.reveal);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "隐藏" : "显示";
    });

    // 主界面
    $("#btn-all").addEventListener("click", () => {
      state.filter = { ...state.filter, cat: "all", tag: null, fav: false, q: "" };
      $("#q").value = "";
      render();
    });
    $("#q").addEventListener("input", (e) => {
      state.filter.q = e.target.value;
      renderList();
    });
    $("#btn-new").addEventListener("click", () => openEntry(null));
    $("#btn-lock").addEventListener("click", lock);
    $("#btn-fav").addEventListener("click", () => {
      state.filter.fav = !state.filter.fav;
      renderList();
    });
    $("#sort-by").addEventListener("change", (e) => {
      state.filter.sort = e.target.value;
      renderList();
    });

    $("#nav-cats").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat]");
      if (!btn) return;
      state.filter.cat = btn.dataset.cat;
      state.filter.tag = null;
      render();
    });
    $("#nav-tags").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tag]");
      if (!btn) return;
      state.filter.tag = state.filter.tag === btn.dataset.tag ? null : btn.dataset.tag;
      render();
    });

    $("#list").addEventListener("click", (e) => {
      const row = e.target.closest(".row");
      if (row) selectRow(row.dataset.id);
    });
    $("#list").addEventListener("keydown", (e) => {
      const rows = $$(".row", $("#list"));
      const i = rows.indexOf(document.activeElement);
      if (e.key === "ArrowDown" && i < rows.length - 1) {
        e.preventDefault(); rows[i + 1].focus(); selectRow(rows[i + 1].dataset.id);
      } else if (e.key === "ArrowUp" && i > 0) {
        e.preventDefault(); rows[i - 1].focus(); selectRow(rows[i - 1].dataset.id);
      } else if (e.key === "Enter") {
        e.preventDefault();
        openEntry(selectedEntry());
      }
    });

    function selectRow(id) {
      state.selected = id;
      renderList();
      renderDetail();
      $$(".row", $("#list")).find((r) => r.dataset.id === id)?.focus();
    }

    // 详情操作
    $("#detail-body").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const entry = selectedEntry();
      if (!entry) return;

      switch (btn.dataset.act) {
        case "back":
          state.selected = null;
          document.body.dataset.view = "list";
          renderDetail();
          $$(".row", $("#list")).find((r) => r.getAttribute("aria-selected") === "true")?.focus();
          break;
        case "edit": openEntry(entry); break;
        case "fav":
          mutate((v) => {
            const t = v.entries.find((x) => x.id === entry.id);
            if (t) { t.fav = !t.fav; t.updatedAt = now(); }
          });
          toast(entry.fav ? "已取消收藏" : "已收藏");
          break;
        case "reveal": {
          const el = $("#slip-value");
          if (!el || !entry.pass) return;
          const masked = el.classList.toggle("is-masked");
          el.textContent = masked ? "•".repeat(Math.min(24, Math.max(10, entry.pass.length))) : entry.pass;
          break;
        }
        case "copy-pass": copySecret(entry.pass, "密码"); break;
        case "copy-user": copySecret(entry.user, "账号"); break;
        case "copy-url": copySecret(entry.url, "网址"); break;
      }
    });

    // 菜单
    const menu = $("#menu");
    $("#btn-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      $("#btn-menu").setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", () => {
      if (!menu.hidden) { menu.hidden = true; $("#btn-menu").setAttribute("aria-expanded", "false"); }
    });
    menu.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      menu.hidden = true;
      $("#btn-menu").setAttribute("aria-expanded", "false");
      switch (btn.dataset.act) {
        case "generate": openGen("dialog"); break;
        case "import": resetImport(); openSheet($("#dlg-import")); break;
        case "export": $("#export-note").textContent = ""; openSheet($("#dlg-export")); break;
        case "folder":
          try {
            const r = await api("/api/reveal", { method: "POST", body: {} });
            toast(`已在资源管理器中打开${r.path ? "" : ""}`);
          } catch (err) { toast(err.message, "bad"); }
          break;
        case "backup":
          try {
            await saveNow();
            const r = await api("/api/backup", { method: "POST", body: {} });
            toast(r.name ? `已备份：${r.name}` : "还没有可备份的数据");
          } catch (err) { toast(err.message, "bad"); }
          break;
        case "about":
          $("#about-path").textContent = state.dataDir || "data/vault.json";
          openSheet($("#dlg-about"));
          break;
      }
    });

    // 关闭按钮
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) {
        const dlg = e.target.closest("dialog");
        if (dlg) closeSheet(dlg);
      }
    });
    $("#scrim").addEventListener("click", () => {
      for (const dlg of openSheets) closeSheet(dlg);
    });

    // 条目表单
    $("#entry-form").addEventListener("submit", submitEntry);
    $("#e-cat").addEventListener("change", () => {
      const isNew = $("#e-cat").value === "__new";
      $("#e-cat-new").hidden = !isNew;
      if (isNew) $("#e-cat-new").focus();
    });
    $("#e-pass").addEventListener("input", (e) => paintMeter($("#e-meter"), null, e.target.value));
    $("#e-gen").addEventListener("click", () => openGen("entry"));
    $("#e-delete").addEventListener("click", () => {
      const id = editingId;
      closeSheet($("#dlg-entry"));
      if (id) deleteEntry(id);
    });

    // 生成器
    $("#gen-len").addEventListener("input", refreshGen);
    for (const id of ["#gen-lower", "#gen-upper", "#gen-digits", "#gen-symbols", "#gen-noamb"]) {
      $(id).addEventListener("change", refreshGen);
    }
    $("#gen-reroll").addEventListener("click", refreshGen);
    $("#gen-use").addEventListener("click", async () => {
      const pw = $("#gen-out").textContent;
      if (!pw) return;
      if (genTarget === "entry") {
        // 密码已经填进表单了，这里只负责收工
        closeSheet($("#dlg-gen"));
        $("#e-pass").focus();
        toast("已填入这条的密码");
        return;
      }
      await copySecret(pw, "生成的密码");
      closeSheet($("#dlg-gen"));
    });

    // 导入
    $("#import-file").addEventListener("change", async (e) => {
      const errEl = $("#import-error");
      errEl.hidden = true;
      try {
        await handleImportFile(e.target.files?.[0]);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });
    $("#import-go").addEventListener("click", runImport);

    // 导出
    $("#export-enc").addEventListener("click", exportEncrypted);
    $("#export-csv").addEventListener("click", async () => {
      const ok = await confirmAsk(
        "导出明文 CSV？",
        "这个文件里所有密码都是明文，任何能打开它的人都能看到。只在迁移到别的工具时用，导完请删掉。",
        "我明白，导出",
      );
      if (ok) exportCsv();
    });

    // 快捷键
    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === "Escape" && !openSheets.size) {
          if (document.activeElement === $("#q")) {
            $("#q").value = "";
            state.filter.q = "";
            renderList();
          } else if (document.body.dataset.view === "detail" && state.selected) {
            state.selected = null;
            renderDetail();
          }
        }
        return;
      }
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#q")?.focus();
        $("#q")?.select();
      } else if (e.key.toLowerCase() === "n" && state.vault) {
        e.preventDefault();
        openEntry(null);
      }
    });

    // 关闭标签页时，如果还有没落盘的改动，先拦一下
    window.addEventListener("beforeunload", (e) => {
      if (state.saving || state.saveTimer) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function resetImport() {
    importParsed = null;
    $("#import-file").value = "";
    $("#import-pass").value = "";
    $("#import-pass-row").hidden = true;
    $("#import-go").disabled = true;
    $("#import-go").textContent = "导入";
    $("#import-error").hidden = true;
  }

  async function lock() {
    // 先把还没落盘的改动写掉，再扔密钥；否则锁定前 300ms 的编辑会丢
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      await saveNow();
    }
    // 把密钥和明文从内存里扔掉，回到启封页
    state.key = null;
    state.salt = null;
    state.vault = null;
    state.selected = null;
    state.payload = null;
    eventAbort?.abort();
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    $("#app").hidden = true;
    $("#unlock-pass").value = "";
    $("#unlock-error").hidden = true;
    $("#detail-body").innerHTML = "";
    $("#list").innerHTML = "";
    boot();
    toast("已锁上 · 密钥已从这个标签页清除");
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  function init() {
    // 把地址栏里的令牌擦掉，别留在历史和截图里
    if (location.search.includes("t=")) {
      history.replaceState(null, "", location.pathname);
    }
    for (const dlg of $$("dialog.sheet")) {
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) closeSheet(dlg); // 点空白处关闭
      });
    }
    bind();
    boot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// 画面の切り替えと表示。データの取得は data.js に任せる。
(function () {
  const STORE_KEY = "ijfa_portal_student"; // このスマホで確認済みの生徒
  const ID_PATTERN = /^[A-Z]{3}[0-9]{5}$/;   // 例 JKT16001
  const $ = id => document.getElementById(id);

  let pending = null;  // 確認待ちの生徒
  let portal = null;   // ホームの表示データ

  // ---- 共通 ----
  function show(viewId) {
    document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== viewId));
    window.scrollTo(0, 0);
  }
  function loading(on) { $("loading").hidden = !on; }
  function save(student) { try { localStorage.setItem(STORE_KEY, JSON.stringify(student)); } catch (e) {} }
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; } }
  function forget() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
  // 小文字・空白・ハイフンをなおす（例 "jkt 16-001" → "JKT16001"）
  function normalizeId(text) { return (text || "").toUpperCase().replace(/[\s\-ー－]/g, ""); }

  // 教材のリンク。URL内の {ID} は生徒IDに置きかえる（Googleフォームの事前入力用）
  function linkFor(material, student) {
    return material.url.split("{ID}").join(encodeURIComponent(student.id || ""));
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // 日本語＋インドネシア語（小さく）を並べる
  function twoLang(parent, ja, idn) {
    parent.append(document.createTextNode(ja));
    if (idn) parent.append(el("span", "id-text", idn));
  }

  // 表示順 → 名前（数字は数として比べる：2課 < 10課）
  function byOrderThenName(a, b) {
    return (a.order - b.order) || String(a.nameJa).localeCompare(String(b.nameJa), "ja", { numeric: true });
  }

  function materialItem(m, student, assigned) {
    const a = el("a", "item" + (assigned ? " item-assigned" : ""));
    a.href = linkFor(m, student);
    a.target = "_blank";
    a.rel = "noopener";
    twoLang(a, m.nameJa, m.nameId);
    return a;
  }

  // ---- 1. ID入力 ----
  $("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const id = normalizeId($("login-id").value);
    $("login-id").value = id;
    $("login-error").textContent = "";
    if (!ID_PATTERN.test(id)) {
      $("login-error").textContent = "IDの形がちがいます（例：JKT16001） / Format ID salah";
      return;
    }
    loading(true);
    try {
      const s = await PortalData.getStudent(id);
      if (!s) {
        $("login-error").textContent = "このIDは見つかりません。先生に聞いてください / ID tidak ditemukan. Tanya guru.";
        return;
      }
      pending = s;
      $("confirm-name").textContent = s.name;
      show("view-confirm");
    } catch (err) {
      $("login-error").textContent = "つながりません。あとでもう一度 / Gagal terhubung. Coba lagi nanti.";
    } finally {
      loading(false);
    }
  });

  // ---- 1b. ゲスト（IDがまだない人）：フォームのテストは出さず、練習サイトだけ使える ----
  const GUEST = { id: "", name: "ゲスト", guest: true, cohort: "", cohortKey: "GUEST" };
  $("guest-btn").addEventListener("click", () => { save(GUEST); openHome(GUEST); });

  // ---- 2. 本人確認 ----
  $("confirm-yes").addEventListener("click", () => { save(pending); openHome(pending); });
  $("confirm-no").addEventListener("click", () => {
    pending = null;
    $("login-id").value = "";
    $("login-error").textContent = "IDを確認して、もう一度入れてください。わからないときは先生に聞いてください / Cek ID Anda atau tanya guru.";
    show("view-login");
  });

  // ---- 3. ホーム ----
  async function openHome(student) {
    show("view-home");
    const guest = !!student.guest;
    $("home-hello").textContent = guest ? "ゲストさん / Tamu" : student.name + " さん";
    $("home-cohort").textContent = guest ? "IDがあれば、テストも受けられます / Dengan ID, Anda bisa ikut tes"
                                         : student.cohort + "期 / Angkatan " + student.cohort;
    $("assigned-title").hidden = guest;
    $("assigned-list").hidden = guest;
    $("switch-user").replaceChildren();
    if (guest) twoLang($("switch-user"), "IDを入れる ", "Masukkan ID");
    else twoLang($("switch-user"), "別の人です ", "Bukan saya");
    loading(true);
    try {
      portal = await PortalData.getPortal(student.cohortKey);
      renderHome(student);
    } catch (err) {
      $("assigned-list").replaceChildren(el("p", "error", "よみこめませんでした / Gagal memuat"));
    } finally {
      loading(false);
    }
  }

  function renderHome(student) {
    const assigned = $("assigned-list");
    assigned.replaceChildren();
    if (portal.assigned.length === 0) {
      assigned.append(el("p", "empty", "いまは指定がありません / Belum ada tugas"));
    } else {
      portal.assigned.forEach(m => assigned.append(materialItem(m, student, true)));
    }

    const grid = $("category-list");
    grid.replaceChildren();
    portal.categories.forEach(c => {
      const b = el("button", "cat");
      b.type = "button";
      twoLang(b, c.nameJa, c.nameId);
      b.addEventListener("click", () => openCategory(c, student));
      grid.append(b);
    });
  }

  $("switch-user").addEventListener("click", () => {
    forget();
    $("login-id").value = "";
    $("login-error").textContent = "";
    show("view-login");
  });

  // ---- 4. カテゴリー ----
  function openCategory(cat, student) {
    $("category-title").replaceChildren();
    twoLang($("category-title"), cat.nameJa, " " + cat.nameId);
    const list = $("material-list");
    list.replaceChildren();
    const items = portal.materials.filter(m => m.categoryId === cat.id).sort(byOrderThenName);
    if (items.length === 0) list.append(el("p", "empty", "じゅんびちゅう / Segera hadir"));

    // グループのない教材は上に並べ、グループ（例 いろどり入門）は押すと開く箱にまとめる
    items.filter(m => !m.group).forEach(m => list.append(materialItem(m, student, false)));
    const groups = [];
    items.filter(m => m.group).forEach(m => {
      let g = groups.find(x => x.name === m.group);
      if (!g) { g = { name: m.group, items: [] }; groups.push(g); }
      g.items.push(m);
    });
    groups.forEach(g => {
      const box = el("details", "group");
      const [ja, idn] = g.name.split(" / ");
      const sum = el("summary", "group-title");
      twoLang(sum, ja + "（" + g.items.length + "）", idn);
      box.append(sum);
      const inner = el("div", "list");
      g.items.forEach(m => inner.append(materialItem(m, student, false)));
      box.append(inner);
      list.append(box);
    });
    show("view-category");
  }
  $("back-home").addEventListener("click", () => show("view-home"));

  // ---- 起動 ----
  if (PortalData.useSample) $("sample-banner").hidden = false;
  const saved = load();
  if (saved && (saved.id || saved.guest) && saved.cohortKey) openHome(saved);
  else show("view-login");
})();

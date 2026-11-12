// 画面の切り替えと表示。データの取得は data.js に任せる。
(function () {
  const STORE_KEY = "ijfa_portal_student"; // このスマホで確認済みの生徒
  const LAST_ID_KEY = "ijfa_portal_last_id"; // ログアウトした人のIDだけ（「もう一度入る」ボタン用。名前は残さない）
  const TEACHER_KEY = "ijfa_portal_teacher"; // ログイン中の先生（名前・メール・期生の一覧・期限）
  const TEACHER_DAYS = 365;                  // 先生のログインは「ログアウト」を押すまで続く（念のため1年で切れる）
  const CLIENT_ID = (window.PORTAL_CONFIG || {}).GOOGLE_CLIENT_ID || "";
  const CACHE_PREFIX = "ijfa_portal_cache_"; // 前回のホーム表示（期生ごと。教材一覧だけで個人情報は入れない）
  const ID_PATTERN = /^[A-Z]{3}[0-9]{5}$/;   // 例 JKT16001
  const $ = id => document.getElementById(id);

  let pending = null;  // 確認待ちの生徒
  let portal = null;   // ホームの表示データ
  let prefetch = null; // 本人確認の画面で先に取りに行ったホームのデータ { cohortKey, promise }
  let openCat = null;  // 開いているカテゴリー { cat, group }（裏で更新されたら表示し直す）
  let current = null;  // いまホームに出している人（生徒・ゲスト・先生の確認用）

  // ---- 共通 ----
  function show(viewId) {
    document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== viewId));
    // 上のバー（名前・ログアウト）はホームとカテゴリーの画面だけに出す
    $("topbar").hidden = !["view-home", "view-category", "view-teacher"].includes(viewId);
    $("preview-banner").hidden = !(current && current.preview && viewId !== "view-teacher");
    window.scrollTo(0, 0);
  }
  function loading(on) { $("loading").hidden = !on; }
  function save(student) { try { localStorage.setItem(STORE_KEY, JSON.stringify(student)); } catch (e) {} }
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; } }
  function forget() {
    try {
      localStorage.removeItem(STORE_KEY);
      Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  }
  function loadCache(key) { try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + key)); } catch (e) { return null; } }
  function saveCache(key, data) { try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data)); } catch (e) {} }
  function status(text) { $("home-status").textContent = text || ""; $("home-status").hidden = !text; }
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
    if (m.type === "soon") {   // じゅんびちゅう：押せない
      const d = el("div", "item item-soon");
      twoLang(d, m.nameJa + "（じゅんびちゅう）", m.nameId ? m.nameId + " (Segera hadir)" : "Segera hadir");
      return d;
    }
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
      $("logout-done").hidden = true;
      // 先読み：「はい」を押す前に、裏でホームのデータを取りに行く
      prefetch = { cohortKey: s.cohortKey, promise: PortalData.getPortal(s.cohortKey) };
      prefetch.promise.catch(() => {});
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
  $("guest-btn").addEventListener("pointerdown", () => {   // 押した瞬間から先読み
    if (!prefetch) { prefetch = { cohortKey: "GUEST", promise: PortalData.getPortal("GUEST") }; prefetch.promise.catch(() => {}); }
  });

  // ---- 2. 本人確認 ----
  $("confirm-yes").addEventListener("click", () => { save(pending); openHome(pending); });
  $("confirm-no").addEventListener("click", () => {
    pending = null;
    prefetch = null;
    $("login-id").value = "";
    $("login-error").textContent = "IDを確認して、もう一度入れてください。わからないときは先生に聞いてください / Cek ID Anda atau tanya guru.";
    show("view-login");
  });

  // ---- 3. ホーム ----
  async function openHome(student) {
    current = student;
    show("view-home");
    openCat = null;
    const guest = !!student.guest;
    if (student.preview) {   // 先生が生徒の画面を確認しているとき
      $("top-name").textContent = "先生の確認用";
      $("top-cohort").textContent = guest ? "ゲストの画面" : student.cohortKey + " の画面";
    } else {
      $("top-name").textContent = guest ? "ゲスト / Tamu" : student.name + " さん";
      $("top-cohort").textContent = guest ? "" : student.cohort + "期 / Angkatan " + student.cohort;
    }
    $("guest-note").hidden = !guest;
    $("assigned-title").hidden = guest;
    $("assigned-list").hidden = guest;
    // 右上のボタン：ゲストは「IDを入れる」、先生の確認用は「先生の画面へ」、ほかは「ログアウト」
    $("logout-btn").replaceChildren();
    if (student.preview) twoLang($("logout-btn"), "先生の画面へ", "Menu Guru");
    else if (guest) twoLang($("logout-btn"), "IDを入れる", "Masukkan ID");
    else twoLang($("logout-btn"), "ログアウト", "Keluar");

    // 1) 前回の表示があれば、まずそれを出す
    const key = student.cohortKey;
    const cached = loadCache(key);
    if (cached) { portal = cached; renderHome(student); status("更新中… / Memperbarui…"); }
    else { loading(true); status(""); }

    // 2) 裏で最新を取りに行き、届いたら差しかえる（先読みがあればそれを使う）
    const p = (prefetch && prefetch.cohortKey === key) ? prefetch.promise : PortalData.getPortal(key);
    prefetch = null;
    try {
      const fresh = await p;
      if (!fresh || fresh.error || !fresh.categories) throw new Error("bad data");
      saveCache(key, fresh);
      if (!cached || JSON.stringify(cached) !== JSON.stringify(fresh)) {
        portal = fresh;
        renderHome(student);
        if (openCat) openCategory(openCat.cat, student, openCat.group, true);
      }
      status("");
    } catch (err) {
      if (cached) status("最新ではありません。電波を確認してください / Belum terbaru. Cek sinyal.");
      else $("assigned-list").replaceChildren(el("p", "error", "よみこめませんでした / Gagal memuat"));
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

    // ホームのボタン：中身が1つならそのまま開く／0なら押せない／2つ以上なら選ぶ画面へ
    const grid = $("category-list");
    grid.replaceChildren();
    portal.categories.forEach(c => {
      const items = itemsOf(c);
      let tile;
      if (items.length === 1 && !items[0].group && items[0].type !== "soon") {
        tile = el("a", "cat");
        tile.href = linkFor(items[0], student);
        tile.target = "_blank";
        tile.rel = "noopener";
        twoLang(tile, c.nameJa, c.nameId);
      } else if (items.length === 0) {
        tile = el("div", "cat cat-soon");
        const note = (student.guest && c.id === "nihongo") ? "（IDが必要 / Perlu ID）" : "（じゅんびちゅう / Segera hadir）";
        twoLang(tile, c.nameJa, c.nameId + " " + note);
      } else {
        tile = el("button", "cat cat-more");
        tile.type = "button";
        twoLang(tile, c.nameJa, c.nameId);
        tile.addEventListener("click", () => openCategory(c, student));
      }
      grid.append(tile);
    });
  }

  // カテゴリーの中で公開中の教材（表示順 → 名前の順）
  function itemsOf(cat) {
    return portal.materials.filter(m => m.categoryId === cat.id).sort(byOrderThenName);
  }

  // ---- ログアウト ----
  // 右上のボタン → 確認 →「ログアウトする」でID入力の画面へ。
  // ゲストは確認なしでID入力へ。先生の確認用の画面からは先生のホームへもどる
  function openSheet(on) { $("logout-sheet").hidden = !on; if (on) $("logout-no").focus(); }
  function logout() {
    openSheet(false);
    openCat = null;
    current = null;
    $("login-id").value = "";
    $("login-error").textContent = "";
    if (loadTeacher()) {   // 先生
      forgetTeacher();
      try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {}
      showLogin(true);
      return;
    }
    const s = load();
    forget();
    try { if (s && s.id) localStorage.setItem(LAST_ID_KEY, s.id); } catch (e) {}
    showLogin(!!(s && s.id));
  }
  $("logout-btn").addEventListener("click", () => {
    if (current && current.preview) { openTeacherHome(); return; }
    if (current && current.guest) { logout(); return; }
    const teacher = !current && loadTeacher();
    $("sheet-note").replaceChildren();
    if (teacher) twoLang($("sheet-note"), "つぎはGoogleアカウントで入ります", "Lain kali masuk lagi dengan akun Google");
    else twoLang($("sheet-note"), "つぎは生徒IDを入れて入ります", "Lain kali masuk lagi dengan ID siswa");
    openSheet(true);
  });
  $("logout-yes").addEventListener("click", logout);
  $("logout-no").addEventListener("click", () => openSheet(false));
  $("logout-sheet").addEventListener("click", e => { if (e.target.id === "logout-sheet") openSheet(false); }); // 外側を押したら閉じる
  document.addEventListener("keydown", e => { if (e.key === "Escape") openSheet(false); });

  // ID入力の画面。前にログアウトした人がいれば「〇〇〇でもう一度入る」を出す
  function showLogin(justLoggedOut) {
    $("logout-done").hidden = !justLoggedOut;
    let last = null;
    try { last = localStorage.getItem(LAST_ID_KEY); } catch (e) {}
    const again = $("again-btn");
    again.hidden = !last;
    if (last) {
      again.replaceChildren();
      twoLang(again, last + " でもう一度入る ", "Masuk lagi");
      again.onclick = () => { $("login-id").value = last; $("login-form").dispatchEvent(new Event("submit", { cancelable: true })); };
    }
    show("view-login");
  }

  // ---- 4. カテゴリー（例 いろどり → 入門／初級1 を選ぶ → テスト一覧） ----
  function openCategory(cat, student, group, refresh) {
    openCat = { cat, group: group || null };
    const title = $("category-title");
    title.replaceChildren();
    const list = $("material-list");
    list.replaceChildren();
    const items = itemsOf(cat);

    if (group) {   // グループの中の一覧
      const [ja, idn] = group.split(" / ");
      twoLang(title, ja, " " + (idn || ""));
      items.filter(m => m.group === group).forEach(m => list.append(materialItem(m, student, false)));
    } else {
      twoLang(title, cat.nameJa, " " + cat.nameId);
      if (items.length === 0) list.append(el("p", "empty", "じゅんびちゅう / Segera hadir"));
      // グループのない教材はそのまま、グループ（例 いろどり入門）は選ぶボタンにする
      items.filter(m => !m.group).forEach(m => list.append(materialItem(m, student, false)));
      const groups = [];
      // グループの順番は教材リストの順（入門が先に登録されていれば入門が上）
      portal.materials.filter(m => m.categoryId === cat.id && m.group)
        .forEach(m => { if (!groups.includes(m.group)) groups.push(m.group); });
      groups.forEach(g => {
        const b = el("button", "item item-group");
        b.type = "button";
        const [ja, idn] = g.split(" / ");
        twoLang(b, ja + "（" + items.filter(m => m.group === g).length + "）", idn);
        b.addEventListener("click", () => openCategory(cat, student, g));
        list.append(b);
      });
    }
    if (!refresh) show("view-category");
  }
  // もどる：グループの中 → カテゴリー → ホーム
  $("back-home").addEventListener("click", () => {
    if (openCat && openCat.group && current) { openCategory(openCat.cat, current); return; }
    openCat = null;
    show("view-home");
  });

  // ---- 先生用ログイン（Googleでログイン → GASが許可リスト「先生」シートと照らし合わせる） ----
  function loadTeacher() {
    try {
      const t = JSON.parse(localStorage.getItem(TEACHER_KEY));
      return t && t.until > Date.now() ? t : null;   // 期限切れならログインし直し
    } catch (e) { return null; }
  }
  function saveTeacher(t) { try { localStorage.setItem(TEACHER_KEY, JSON.stringify(t)); } catch (e) {} }
  function forgetTeacher() { try { localStorage.removeItem(TEACHER_KEY); } catch (e) {} }

  // Googleのログインボタンは、先生用ログインの画面を開いたときだけ読み込む（生徒の画面を重くしないため）
  let gsiLoading = null;
  function loadGsi() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (!gsiLoading) {
      gsiLoading = new Promise((ok, ng) => {
        const sc = document.createElement("script");
        sc.src = "https://accounts.google.com/gsi/client";
        sc.async = true;
        sc.onload = ok;
        sc.onerror = () => { gsiLoading = null; ng(new Error("gsi")); };
        document.head.append(sc);
      });
    }
    return gsiLoading;
  }

  // Googleのログインは「ページごとGoogleへ移動 → GASが確かめる → ポータルにもどる」方式。
  // （ポップアップ方式はiPhoneのSafariで途中で止まることがあるため使わない）
  async function openTeacherLogin(errText) {
    $("tl-error").textContent = errText || "";
    $("g-button").replaceChildren();
    show("view-teacher-login");
    if (!CLIENT_ID || PortalData.useSample) {
      $("tl-error").textContent = "先生用ログインはじゅんびちゅうです / Segera hadir";
      return;
    }
    try {
      await loadGsi();
      google.accounts.id.initialize({ client_id: CLIENT_ID, ux_mode: "redirect",
                                      login_uri: (window.PORTAL_CONFIG || {}).API_URL });
      google.accounts.id.renderButton($("g-button"), { theme: "outline", size: "large", text: "signin_with", width: 280, locale: "ja" });
    } catch (e) {
      $("tl-error").textContent = "Googleにつながりません。電波を確認してください / Gagal terhubung ke Google";
    }
  }

  // Googleからもどってきたとき（URLに ?t=合言葉 または ?tlerr=理由 がある）
  async function finishTeacherLogin(t, err) {
    history.replaceState(null, "", location.pathname);   // URLから合言葉を消す
    if (err) {
      openTeacherLogin(err === "not_allowed"
        ? "このアカウントは先生として登録されていません。坂井に連絡してください / Akun ini belum terdaftar sebagai guru"
        : "ログインできませんでした。もう一度ためしてください / Gagal masuk. Coba lagi");
      return;
    }
    loading(true);
    try {
      const r = await PortalData.teacherSession(t);
      if (!r.ok) { openTeacherLogin("時間切れです。もう一度ログインしてください / Waktu habis. Silakan masuk lagi"); return; }
      saveTeacher({ name: r.teacher.name, email: r.teacher.email, cohorts: r.cohorts || [],
                    until: Date.now() + TEACHER_DAYS * 86400000 });
      openTeacherHome();
    } catch (e) {
      openTeacherLogin("つながりません。あとでもう一度 / Gagal terhubung. Coba lagi nanti.");
    } finally {
      loading(false);
    }
  }

  function openTeacherHome() {
    const t = loadTeacher();
    if (!t) { showLogin(false); return; }
    current = null;
    openCat = null;
    $("top-name").textContent = t.name + " 先生";
    $("top-cohort").textContent = "先生用 / Guru";
    $("logout-btn").replaceChildren();
    twoLang($("logout-btn"), "ログアウト", "Keluar");
    // 期生の一覧（新しい期が上）＋ゲスト
    const sel = $("t-cohort");
    const keep = sel.value;
    sel.replaceChildren();
    t.cohorts.forEach(k => { const o = el("option", "", k + "（" + parseInt(k.slice(3), 10) + "期）"); o.value = k; sel.append(o); });
    const g = el("option", "", "ゲストの画面"); g.value = "GUEST"; sel.append(g);
    if (keep) sel.value = keep;
    show("view-teacher");
    refreshCohorts(t);
  }
  // 期生の一覧を裏で最新にする（新しい期が入ったとき用）。失敗したら前の一覧のまま
  async function refreshCohorts(t) {
    try {
      const r = await PortalData.getCohorts();
      if (!r || !Array.isArray(r.cohorts) || r.cohorts.length === 0) return;
      if (JSON.stringify(r.cohorts) === JSON.stringify(t.cohorts)) return;
      t.cohorts = r.cohorts;
      saveTeacher(t);
      if (!$("view-teacher").hidden) openTeacherHome();
    } catch (e) {}
  }
  // 選んだ期生の生徒の画面を見る（フォームのIDは空のまま）
  $("t-view").addEventListener("click", () => {
    const k = $("t-cohort").value;
    if (!k) return;
    const s = k === "GUEST"
      ? { id: "", name: "", guest: true, cohort: "", cohortKey: "GUEST", preview: true }
      : { id: "", name: "", cohort: String(parseInt(k.slice(3), 10)), cohortKey: k, preview: true };
    openHome(s);
  });
  $("teacher-link").addEventListener("click", () => openTeacherLogin());
  $("tl-back").addEventListener("click", () => showLogin(false));

  // ---- 起動 ----
  if (PortalData.useSample) $("sample-banner").hidden = false;
  const saved = load();
  const q = new URLSearchParams(location.search);
  if (q.get("t") || q.get("tlerr")) finishTeacherLogin(q.get("t"), q.get("tlerr"));
  else if (loadTeacher()) openTeacherHome();
  else if (saved && (saved.id || saved.guest) && saved.cohortKey) openHome(saved);
  else showLogin(false);
})();

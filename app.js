// 画面の切り替えと表示。データの取得は data.js に任せる。
(function () {
  const STORE_KEY = "ijfa_portal_student"; // このスマホでログイン中の生徒（名前・期生・生徒キー・期限。パスワードは入れない）
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
    $("topbar").hidden = !["view-home", "view-category", "view-password", "view-teacher", "view-teacher-assign"].includes(viewId);
    $("preview-banner").hidden = !(current && current.preview && viewId !== "view-teacher");
    // 意見フォームは生徒・ゲストのホームと先生のホームだけ（先生の確認用の画面では出さない）
    $("feedback").hidden = !((viewId === "view-home" && !(current && current.preview)) || viewId === "view-teacher");
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
    const url = material.url.split("{ID}").join(encodeURIComponent(student.id || ""));
    // 先生の確認用：みんなの日本語には期生を渡して、その期で受けられる課を見せる
    if (student.preview && !student.guest && /minna\.html/.test(url)) {
      return url + (url.includes("?") ? "&" : "?") + "c=" + encodeURIComponent(student.cohortKey);
    }
    return url;
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

  // ---- 1. ID・パスワード入力 ----
  // パスワードのはじめは生年月日8けた。確かめるのはGAS（このページには生年月日もパスワードも置かない）
  $("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const id = normalizeId($("login-id").value);
    const pw = toDigits($("login-pw").value);
    $("login-id").value = id;
    $("login-pw").value = pw;
    $("login-error").textContent = "";
    if (!ID_PATTERN.test(id)) {
      $("login-error").textContent = "IDの形がちがいます（例：JKT16001） / Format ID salah";
      return;
    }
    if (!/^[0-9]{4,20}$/.test(pw)) {
      $("login-error").textContent = "パスワードを数字で入れてください / Masukkan kata sandi (angka)";
      $("login-pw").focus();
      return;
    }
    loading(true);
    try {
      const r = await PortalData.studentLogin(id, pw);
      if (!r || !r.ok) {
        $("login-error").textContent = (r && r.reason === "locked")
          ? "5回まちがえたので、15分まってください / Salah 5 kali. Tunggu 15 menit."
          : "IDかパスワードがちがいます。わからないときは先生に聞いてください / ID atau kata sandi salah. Tanya guru jika lupa.";
        $("login-pw").value = "";
        return;
      }
      const s = r.student;
      pending = Object.assign({}, s, { key: r.key, until: r.until });
      $("login-pw").value = "";
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
  // 全角の数字・空白をなおす（例 "２００７ ０４１５" → "20070415"）
  function toDigits(text) {
    return (text || "").replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s\-\/ー－]/g, "");
  }
  // 「数字を見せる」
  function pwToggle(boxId, inputIds) {
    $(boxId).addEventListener("change", () => inputIds.forEach(i => { $(i).type = $(boxId).checked ? "text" : "password"; }));
  }
  pwToggle("login-show", ["login-pw"]);

  // ---- 1b. ゲスト（IDがまだない人）：フォームのテストは出さず、練習サイトだけ使える ----
  const GUEST = { id: "", name: "ゲスト", guest: true, cohort: "", cohortKey: "GUEST" };
  $("guest-btn").addEventListener("click", () => { save(GUEST); openHome(GUEST); });
  $("guest-btn").addEventListener("pointerdown", () => {   // 押した瞬間から先読み
    if (!prefetch) { prefetch = { cohortKey: "GUEST", promise: PortalData.getPortal("GUEST") }; prefetch.promise.catch(() => {}); }
  });

  // ---- 2. 本人確認 ----
  $("confirm-yes").addEventListener("click", () => { save(pending); openHome(pending); });
  $("confirm-no").addEventListener("click", () => {
    if (pending) PortalData.studentLogout(pending.key).catch(() => {});   // 作った生徒キーは使えなくする
    pending = null;
    prefetch = null;
    $("login-id").value = "";
    $("login-pw").value = "";
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
    $("pw-open").hidden = guest || !!student.preview;   // パスワード変更は生徒だけ
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
    $("login-pw").value = "";
    $("login-error").textContent = "";
    const lt = loadTeacher();
    if (lt) {   // 先生：先生キーも使えなくしておく（つながらなくても、ログアウトはそのまま進める）
      PortalData.teacherLogout(lt.key).catch(() => {});
      forgetTeacher();
      try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {}
      showLogin(true);
      return;
    }
    const s = load();
    if (s && s.key) PortalData.studentLogout(s.key).catch(() => {});   // 生徒キーも使えなくする
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
      again.onclick = () => { $("login-id").value = last; $("login-pw").focus(); };
    }
    show("view-login");
  }

  // ---- 3b. パスワード変更（生徒） ----
  function resetPwForm() {
    ["pw-old", "pw-new", "pw-new2"].forEach(i => { $(i).value = ""; $(i).type = "password"; });
    $("pw-show").checked = false;
    $("pw-error").textContent = "";
    $("pw-form").hidden = false;
    $("pw-done").hidden = true;
  }
  pwToggle("pw-show", ["pw-old", "pw-new", "pw-new2"]);
  $("pw-open").addEventListener("click", () => { resetPwForm(); show("view-password"); });
  $("pw-back").addEventListener("click", () => show("view-home"));
  $("pw-home").addEventListener("click", () => show("view-home"));
  $("pw-form").addEventListener("submit", async e => {
    e.preventDefault();
    const oldPw = toDigits($("pw-old").value), newPw = toDigits($("pw-new").value), newPw2 = toDigits($("pw-new2").value);
    const err = $("pw-error");
    err.textContent = "";
    if (!oldPw) { err.textContent = "いまのパスワードを入れてください / Masukkan kata sandi sekarang"; return; }
    if (!/^[0-9]{4,20}$/.test(newPw)) { err.textContent = "新しいパスワードは4けた以上の数字です / Kata sandi baru: angka, minimal 4 digit"; return; }
    if (newPw !== newPw2) { err.textContent = "新しいパスワードが2つでちがいます / Kata sandi baru tidak sama"; return; }
    const s = load();
    if (!s || !s.key) { needLogin(s && s.id); return; }
    $("pw-save").disabled = true;
    loading(true);
    try {
      const r = await PortalData.changePassword(s.key, oldPw, newPw);
      if (r && r.ok) {
        save(Object.assign({}, s, { key: r.key, until: r.until }));   // このスマホは新しいキーでそのまま使える
        current = load();
        $("pw-form").hidden = true;
        $("pw-done").hidden = false;
      } else if (r && r.reason === "auth") {
        needLogin(s.id);
      } else {
        err.textContent = (r && r.reason === "old") ? "いまのパスワードがちがいます / Kata sandi sekarang salah"
          : (r && r.reason === "locked") ? "5回まちがえたので、15分まってください / Salah 5 kali. Tunggu 15 menit."
          : (r && r.reason === "format") ? "新しいパスワードは4けた以上の数字です / Kata sandi baru: angka, minimal 4 digit"
          : "変更できませんでした / Gagal mengganti";
      }
    } catch (e2) {
      err.textContent = "つながりません。あとでもう一度 / Gagal terhubung. Coba lagi nanti.";
    } finally {
      $("pw-save").disabled = false;
      loading(false);
    }
  });

  // もう一度ログインしてもらう（10日たった・ほかのスマホでパスワードが変わった・前の版でログインしていた）
  function needLogin(id) {
    forget();
    current = null;
    try { if (id) localStorage.setItem(LAST_ID_KEY, id); } catch (e) {}
    showLogin(false);
    if (id) $("login-id").value = id;
    $("login-error").textContent = "もう一度パスワードを入れてください / Silakan masuk lagi dengan kata sandi";
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
      saveTeacher({ name: r.teacher.name, email: r.teacher.email, cohorts: r.cohorts || [], key: r.key || "",
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

  // ---- 5b. 指定テストを選ぶ（先生用） ----
  // いまの指定を上に出し、下の一覧から足す。「保存する」を押すまでシートは変わらない
  let asg = null;   // { cohort, data, list: [教材名], saved: [教材名], ver, leave }
  function taMsg(text, ok) { $("ta-msg").textContent = text || ""; $("ta-msg").classList.toggle("ta-msg-ok", !!ok); }
  function taDirty() { return !!asg && !!asg.data && JSON.stringify(asg.list) !== JSON.stringify(asg.saved); }
  function taNeedLogin(text) {
    taMsg(text);
    $("ta-relogin").hidden = false;
    $("ta-body").hidden = true;
  }

  function openAssign(cohortKey) {
    const t = loadTeacher();
    if (!t) { showLogin(false); return; }
    const sel = $("ta-cohort");
    sel.replaceChildren();
    t.cohorts.forEach(k => { const o = el("option", "", k + "（" + parseInt(k.slice(3), 10) + "期）"); o.value = k; sel.append(o); });
    const k = t.cohorts.includes(cohortKey) ? cohortKey : t.cohorts[0];
    if (k) sel.value = k;
    $("ta-search").value = "";
    show("view-teacher-assign");
    loadAssign(k);
  }

  async function loadAssign(cohortKey, note) {
    const t = loadTeacher();
    asg = { cohort: cohortKey, data: null, list: [], saved: [], ver: "", leave: false };
    $("ta-relogin").hidden = true;
    $("ta-body").hidden = true;
    taMsg(note || "");
    if (!cohortKey) { taMsg("期生がありません / Belum ada angkatan"); return; }
    // 先生キーは、この機能を入れる前にログインした人は持っていない → 1回だけログインしなおしてもらう
    if (!t || !t.key) { taNeedLogin("この機能を使うには、もう一度Googleでログインしてください / Silakan masuk lagi dengan Google"); return; }
    loading(true);
    try {
      const r = await PortalData.getAssign(t.key, cohortKey);
      if (!asg || asg.cohort !== cohortKey) return;   // 待っているあいだに別の期を選んだ
      if (!r || !r.ok) {
        if (r && r.reason === "auth") taNeedLogin("ログインの期限が切れたか、先生の登録が外れています。もう一度ログインしてください / Silakan masuk lagi");
        else taMsg("よみこめませんでした / Gagal memuat");
        return;
      }
      asg.data = r;
      asg.list = r.assigned.slice();
      asg.saved = r.assigned.slice();
      asg.ver = r.ver;
      $("ta-body").hidden = false;
      renderPool();
      renderAssign();
    } catch (e) {
      taMsg("つながりません。電波を確認してください / Gagal terhubung. Cek sinyal.");
    } finally {
      loading(false);
    }
  }

  function taMaterial(name) { return asg.data.materials.find(m => m.nameJa === name) || null; }
  function taCatName(id) { const c = asg.data.categories.find(x => x.id === id); return c ? c.nameJa : ""; }

  // いまの指定（上）
  function renderAssign() {
    const list = $("ta-list");
    list.replaceChildren();
    if (asg.list.length === 0) list.append(el("p", "empty", "まだ指定がありません。下から足してください / Belum ada. Tambahkan dari bawah."));
    asg.list.forEach((name, i) => {
      const m = taMaterial(name);
      const row = el("div", "ta-row" + (m ? "" : " ta-row-bad"));
      row.append(el("span", "ta-no", String(i + 1)));
      const nm = el("span", "ta-name", name);
      if (m && !m.public) nm.append(el("span", "ta-tag", m.categoryId === "minna" ? "🔓 ページで解放" : "指定のみ"));
      nm.append(el("span", "id-text", m ? [taCatName(m.categoryId), (m.group || "").split(" / ")[0]].filter(Boolean).join("・")
                                         : "教材リストにありません。はずしてください"));
      row.append(nm);
      const btns = el("span", "ta-btns");
      const mk = (label, aria, disabled, fn) => {
        const b = el("button", "ta-btn", label);
        b.type = "button"; b.disabled = disabled; b.setAttribute("aria-label", aria);
        b.addEventListener("click", fn);
        btns.append(b);
      };
      mk("↑", "上へ", i === 0, () => taMove(i, -1));
      mk("↓", "下へ", i === asg.list.length - 1, () => taMove(i, 1));
      mk("✕", "はずす", false, () => { asg.list.splice(i, 1); taChanged(); });
      row.append(btns);
      list.append(row);
    });
    // 下の一覧の「指定ずみ」をそろえる
    $("ta-pool").querySelectorAll("[data-name]").forEach(b => { b.disabled = asg.list.includes(b.dataset.name); });
    taState();
  }
  function taMove(i, d) {
    const [x] = asg.list.splice(i, 1);
    asg.list.splice(i + d, 0, x);
    taChanged();
  }
  function taChanged() { asg.leave = false; taMsg(""); renderAssign(); }
  function taState() {
    const dirty = taDirty();
    $("ta-state").textContent = dirty ? "保存していない変更があります / Belum disimpan" : "保存ずみ / Sudah disimpan";
    $("ta-state").classList.toggle("ta-state-dirty", dirty);
    $("ta-save").disabled = !dirty;
    $("ta-undo").hidden = !dirty;
  }

  // テストを足す（下）：カテゴリーごとに開く。グループ（例 いろどり入門）は見出しにする
  function renderPool() {
    const pool = $("ta-pool");
    pool.replaceChildren();
    asg.data.categories.forEach(c => {
      const items = asg.data.materials.filter(m => m.categoryId === c.id).sort(byOrderThenName);
      if (items.length === 0) return;
      const box = el("details", "group");
      box.dataset.cat = c.id;
      const sum = el("summary", "group-title");
      twoLang(sum, c.nameJa + "（" + items.length + "）", c.nameId);
      box.append(sum);
      const inner = el("div", "list");
      const groups = [""];
      items.forEach(m => { if (m.group && !groups.includes(m.group)) groups.push(m.group); });
      groups.forEach(g => {
        // グループ（例 いろどり入門・みんなの日本語）は、さらに押して開く箱にする
        let target = inner;
        if (g) {
          const sub = el("details", "ta-group");
          const [ja, idn] = g.split(" / ");
          const ss = el("summary", "ta-sub");
          twoLang(ss, ja + "（" + items.filter(m => m.group === g).length + "）", idn ? " " + idn : "");
          sub.append(ss);
          target = el("div", "list");
          sub.append(target);
          inner.append(sub);
        }
        items.filter(m => (m.group || "") === g).forEach(m => {
          const b = el("button", "item ta-add", m.nameJa);
          b.type = "button";
          b.dataset.name = m.nameJa;
          b.dataset.search = (m.nameJa + " " + (m.nameId || "") + " " + g).normalize("NFKC").toLowerCase();
          b.addEventListener("click", () => {
            if (asg.list.includes(m.nameJa)) return;
            asg.list.push(m.nameJa);
            taChanged();
          });
          target.append(b);
        });
      });
      box.append(inner);
      pool.append(box);
    });
    taFilter();
  }
  // さがす：入れた文字をふくむテストだけ出し、カテゴリーを開く
  function taFilter() {
    const q = $("ta-search").value.normalize("NFKC").toLowerCase().trim();
    $("ta-pool").querySelectorAll("details").forEach(box => {
      let hit = 0;
      box.querySelectorAll("[data-name]").forEach(b => { const on = !q || b.dataset.search.includes(q); b.hidden = !on; if (on) hit++; });
      box.querySelectorAll(".ta-group").forEach(sub => {
        const any = [...sub.querySelectorAll("[data-name]")].some(b => !b.hidden);
        sub.hidden = !any;
        if (q) sub.open = any;
      });
      box.hidden = hit === 0;
      if (q) box.open = hit > 0;
    });
  }
  $("ta-search").addEventListener("input", taFilter);
  // 保存しないままページを閉じようとしたら、ブラウザの確認を出す
  window.addEventListener("beforeunload", e => { if (taDirty()) { e.preventDefault(); e.returnValue = ""; } });

  $("ta-undo").addEventListener("click", () => { asg.list = asg.saved.slice(); taChanged(); });

  $("ta-save").addEventListener("click", async () => {
    const t = loadTeacher();
    if (!t || !t.key || !taDirty()) return;
    const save = $("ta-save");
    save.disabled = true;
    taMsg("");
    $("ta-state").textContent = "保存中… / Menyimpan…";
    try {
      const r = await PortalData.saveAssign(t.key, asg.cohort, asg.list, asg.ver);
      if (r && r.ok) {
        asg.saved = asg.list.slice();
        asg.ver = r.ver;
        try { localStorage.removeItem(CACHE_PREFIX + asg.cohort); } catch (e) {}   // 確認用の画面で古い表示を出さない
        taMsg("保存しました。生徒の画面に反映されました / Tersimpan", true);
        taState();
        return;
      }
      const why = r && r.reason;
      if (why === "auth") { taNeedLogin("ログインの期限が切れたか、先生の登録が外れています。もう一度ログインしてください / Silakan masuk lagi"); return; }
      if (why === "changed") { loadAssign(asg.cohort, "ほかの先生が先に変更していました。最新を読みこんだので、もう一度選んでください / Sudah diubah guru lain. Silakan pilih lagi."); return; }
      if (why === "unknown") taMsg("教材リストにないテストがあります。赤いわくのテストをはずしてください：" + (r.names || []).join("、"));
      else if (why === "too_many") taMsg("指定は50個までです / Maksimal 50 tes");
      else taMsg("保存できませんでした。もう一度ためしてください / Gagal menyimpan. Coba lagi.");
      taState();
    } catch (e) {
      taMsg("つながりません。電波を確認して、もう一度「保存する」を押してください / Gagal terhubung. Coba lagi.");
      taState();
    }
  });

  // 期生を変える：保存していない変更があるときは止める
  $("ta-cohort").addEventListener("change", () => {
    const k = $("ta-cohort").value;
    if (taDirty()) {
      $("ta-cohort").value = asg.cohort;
      taMsg("先に「保存する」か「元にもどす」を押してください / Simpan atau batalkan dulu");
      return;
    }
    $("ta-search").value = "";
    loadAssign(k);
  });

  // 先生のホームへ：保存していない変更があれば、1回目は注意だけ出す
  $("ta-back").addEventListener("click", () => {
    if (taDirty() && !asg.leave) {
      asg.leave = true;
      taMsg("保存していない変更があります。もう一度「先生のホームへ」を押すと、変更をすてて戻ります / Perubahan belum disimpan");
      return;
    }
    asg = null;
    openTeacherHome();
  });
  $("ta-relogin").addEventListener("click", () => { forgetTeacher(); openTeacherLogin(); });
  // この期の生徒の画面で確認（先生の確認用の画面。右上のボタンで先生のホームにもどる）
  $("ta-preview").addEventListener("click", () => {
    if (!asg || taDirty()) { taMsg("先に「保存する」か「元にもどす」を押してください / Simpan atau batalkan dulu"); return; }
    const k = asg.cohort;
    asg = null;
    openHome({ id: "", name: "", cohort: String(parseInt(k.slice(3), 10)), cohortKey: k, preview: true });
  });
  $("t-assign").addEventListener("click", () => {
    const k = $("t-cohort").value;
    openAssign(k && k !== "GUEST" ? k : "");
  });
  $("tl-back").addEventListener("click", () => showLogin(false));

  // ---- 意見・報告フォーム（ホームのいちばん下） ----
  function fbChecked(name) {
    const r = document.querySelector('#fb-form input[name="' + name + '"]:checked');
    return r ? r.value : "";
  }
  // 端末のだいたいの種類（直すときにいちばん役に立つ）
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android スマホ" : "Android タブレット";
    if (/Windows/.test(ua)) return "Windows";
    if (/Macintosh/.test(ua)) return "Mac";
    return "その他";
  }
  // 「エラー・こまったこと」のときだけ「いつも起きる？」を出す
  $("fb-form").addEventListener("change", e => {
    $("fb-error").textContent = "";
    if (e.target.name === "kind") $("fb-freq-set").hidden = fbChecked("kind") !== "error";
  });
  $("fb-form").addEventListener("submit", async e => {
    e.preventDefault();
    const kind = fbChecked("kind");
    const text = $("fb-text").value.trim();
    $("fb-error").textContent = "";
    if (!kind) { $("fb-error").textContent = "どんなことか選んでください / Pilih jenisnya dulu"; return; }
    if (text.length < 5) { $("fb-error").textContent = "もう少しくわしく書いてください / Tulis sedikit lebih rinci"; return; }

    // だれが送ったか（生徒はIDだけ送り、名前はGASが名簿から入れる）
    const t = !current ? loadTeacher() : null;
    const who = t ? { role: "teacher", name: t.name, email: t.email }
              : (current && current.guest) ? { role: "guest" }
              : { role: "student", id: current ? current.id : "" };
    const send = $("fb-send");
    send.disabled = true;
    try {
      const r = await PortalData.sendFeedback(Object.assign({
        kind: kind, text: text, freq: kind === "error" ? fbChecked("freq") : "",
        view: t ? "先生のホーム" : "ホーム", device: deviceName(),
        screen: window.innerWidth + "x" + window.innerHeight, ua: navigator.userAgent.slice(0, 300)
      }, who));
      if (!r || !r.ok) throw new Error((r && r.reason) || "ng");
      $("fb-form").reset();
      $("fb-freq-set").hidden = true;
      $("fb-form").hidden = true;
      $("fb-done").hidden = false;
    } catch (err) {
      $("fb-error").textContent = err.message === "limit"
        ? "たくさん送られたので、少し時間をおいてください / Terlalu banyak. Coba lagi nanti."
        : "送れませんでした。電波を確認して、もう一度 / Gagal mengirim. Cek sinyal dan coba lagi.";
    } finally {
      send.disabled = false;
    }
  });
  $("fb-again").addEventListener("click", () => {
    $("fb-done").hidden = true;
    $("fb-form").hidden = false;
    $("fb-text").focus();
  });

  // ---- 起動 ----
  if (PortalData.useSample) $("sample-banner").hidden = false;
  const saved = load();
  const q = new URLSearchParams(location.search);
  if (q.get("t") || q.get("tlerr")) finishTeacherLogin(q.get("t"), q.get("tlerr"));
  else if (loadTeacher()) openTeacherHome();
  else if (saved && saved.guest && saved.cohortKey) openHome(saved);
  else if (saved && saved.id && saved.key && saved.until > Date.now() && saved.cohortKey) {
    openHome(saved);
    // 裏で生徒キーがまだ使えるか確かめる（つながらないときはそのまま使う）
    PortalData.studentCheck(saved.key).then(r => {
      if (r && r.ok === false && r.reason === "auth" && current && current.id === saved.id) needLogin(saved.id);
    }).catch(() => {});
  }
  else if (saved && saved.id) needLogin(saved.id);   // 期限切れ、またはパスワードの仕組みより前にログインした人
  else showLogin(false);
})();

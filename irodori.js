// いろどり 課ごとのテスト（ウェブ版）
// 問題は GAS から受けとる（正解は入っていない）。送信すると GAS が採点し、1回目だけ成績（結果シート）に入る。
(function () {
  const API_URL = (window.PORTAL_CONFIG || {}).API_URL || "";
  const ASSET = "https://ijfa-tc.github.io/irodori-test/";   // 音声・画像の置き場（別リポジトリ）
  const MAX_PLAYS = 2;                                        // 聴解の音声は1問2回まで
  const STUDENT_KEY = "ijfa_portal_student";                  // ポータルでログインした生徒（app.js と同じ）
  const TEACHER_KEY = "ijfa_portal_teacher";                  // ポータルでログインした先生（確認用に全部見られる）
  const $ = id => document.getElementById(id);

  const formId = new URLSearchParams(location.search).get("f") || "";
  let student = null;   // { id, name, cohort, key, until }
  let test = null;      // GAS からの問題
  let draft = null;     // { aid, ans: { 順番: [答え] }, plays: { X05-01: 回数 }, started }
  const audios = {};    // 音声コード → Audio
  let playing = null;

  // ---- 小さな道具 ----
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  // 「水(みず)」→ 漢字の上にふりがな
  function ruby(s) {
    return esc(s)
      .replace(/([㐀-鿿々〆ヶ]+)[(（]([ぁ-ゟ゠-ヿー]+)[)）]/g, "<ruby>$1<rt>$2</rt></ruby>")
      .replace(/\n/g, "<br>");
  }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function msg(text) { $("it-msg").textContent = text || ""; }
  function loading(on) { $("loading").hidden = !on; }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); });
  }
  function draftKey() { return "ijfa_irodori_" + formId + "_" + (student ? student.id : "preview"); }
  function saveDraft() { if (!student) return; try { localStorage.setItem(draftKey(), JSON.stringify(draft)); } catch (e) {} }
  function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey())); } catch (e) { return null; } }
  function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) {} }

  // ---- はじめ ----
  async function start() {
    try { const s = JSON.parse(localStorage.getItem(STUDENT_KEY)); if (s && s.id && s.key && s.until > Date.now()) student = s; } catch (e) {}
    let teacherKey = "";
    try { const t = JSON.parse(localStorage.getItem(TEACHER_KEY)); if (t && t.key && t.until > Date.now()) teacherKey = t.key; } catch (e) {}
    if (!formId || !API_URL) { msg("テストが見つかりません / Tes tidak ditemukan"); return; }
    // 問題は、ログインした生徒（先生が指定したテストだけ）か先生だけが見られる
    if (!student && !teacherKey) { msg("ポータルでログインしてから、もう一度このテストを開いてください / Masuk dulu di portal, lalu buka tes ini lagi."); return; }
    $("preview-banner").hidden = !!student;
    $("it-who").textContent = student ? student.name + " さん（" + student.id + "）" : "";
    loading(true);
    try {
      const res = await fetch(API_URL, { method: "POST", body: new URLSearchParams({
        action: "itest", k: student ? student.key : teacherKey, f: formId }) });
      const r = await res.json();
      if (!r || !r.ok) {
        const why = r && r.reason;
        msg(why === "not_assigned" ? "🔒 このテストは、先生が指定したときだけ受けられます / Tes ini hanya bisa dikerjakan jika ditugaskan guru."
          : why === "auth" ? "ログインの期限が切れました。ポータルでログインしてから、もう一度このテストを開いてください / Sesi habis. Masuk lagi di portal, lalu buka tes ini lagi."
          : why === "not_web" ? "このテストはまだウェブ版がありません / Tes ini belum tersedia"
          : "テストを読みこめませんでした / Gagal memuat tes");
        return;
      }
      test = r;
    } catch (e) {
      msg("つながりません。電波を確認して、ページを読みこみなおしてください / Gagal terhubung. Cek sinyal lalu muat ulang.");
      return;
    } finally { loading(false); }
    document.title = test.title + " | IJFA";
    $("it-title").textContent = test.title;
    $("it-plays-n").textContent = $("it-plays-n2").textContent = MAX_PLAYS;

    const old = loadDraft();
    draft = old && old.aid ? old : { aid: uuid(), ans: {}, plays: {}, started: Date.now() };
    preloadAudio();
    if (old && Object.keys(old.ans || {}).length) { showTest(); return; }   // 途中だったら、つづきから
    $("it-intro").hidden = false;
  }

  // 音声を先に読みこむ（電波が弱くても止まりにくいように）
  function preloadAudio() {
    const codes = [];
    test.sections.forEach(s => s.items.forEach(it => { if (it.audio && !codes.includes(it.audio)) codes.push(it.audio); }));
    if (!codes.length) { $("it-preload").textContent = ""; return; }
    let ready = 0;
    const show = () => { $("it-preload").textContent = "音声の準備 " + ready + " / " + codes.length + (ready === codes.length ? " ✓" : "…") + " / Menyiapkan audio"; };
    show();
    codes.forEach(c => {
      const a = new Audio();
      a.preload = "auto";
      let counted = false;
      const done = () => { if (!counted) { counted = true; ready++; show(); } };
      a.addEventListener("canplaythrough", done, { once: true });
      a.addEventListener("error", done, { once: true });
      a.src = ASSET + c + ".mp3";
      a.load();
      audios[c] = a;
    });
  }

  // 音のテスト：ピッという音（ファイルを使わない）
  $("it-beep").addEventListener("click", () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 660; g.gain.value = 0.2;
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.8);
    } catch (e) {}
  });
  $("it-start").addEventListener("click", () => { draft.started = Date.now(); saveDraft(); showTest(); });

  // ---- 問題を出す ----
  function showTest() {
    $("it-intro").hidden = true;
    const body = $("it-body");
    body.replaceChildren();
    test.sections.forEach(sec => {
      const box = el("section", "it-sec");
      box.append(el("h2", "h2 it-sec-title", ruby(sec.name)));
      if (sec.help) box.append(el("p", "it-help", ruby(sec.help)));
      sec.items.forEach(it => box.append(itemView(it)));
      body.append(box);
    });
    $("it-form").hidden = false;
    $("it-send").hidden = !student;
    if (!student) $("it-send-msg").textContent = "ログインしていないので送信できません / Tidak bisa mengirim karena belum masuk";
    window.scrollTo(0, 0);
  }

  function itemView(it) {
    const box = el("div", "it-item it-k-" + it.k);
    if (it.text) box.append(el("p", "it-q", ruby(it.text)));
    if (it.help) box.append(el("p", "it-help", ruby(it.help)));
    if (it.audio) box.append(audioButton(it.audio));
    if (it.img) {
      const img = el("img", "it-img");
      img.src = ASSET + it.img + ".jpg";
      img.alt = "";
      img.loading = "lazy";
      box.append(img);
    }
    if (it.k === "video") box.append(el("p", "it-help", "（動画の問題です。先生に聞いてください / Soal video, tanya guru）"));
    if (it.choices) {
      const list = el("div", "it-choices");
      const chosen = draft.ans[it.n] || [];
      it.choices.forEach((c, i) => {
        const lab = el("label", "it-choice");
        const inp = document.createElement("input");
        inp.type = it.multi ? "checkbox" : "radio";
        inp.name = "q" + it.n;
        inp.value = c;
        inp.checked = chosen.includes(c);
        inp.addEventListener("change", () => {
          const vals = Array.from(document.querySelectorAll('input[name="q' + it.n + '"]:checked')).map(x => x.value);
          if (vals.length) draft.ans[it.n] = vals; else delete draft.ans[it.n];
          box.classList.remove("it-missing");
          saveDraft();
        });
        lab.append(inp, el("span", "", ruby(c)));
        list.append(lab);
      });
      box.append(list);
      box.dataset.n = it.n;
    }
    return box;
  }

  // 聴解の再生ボタン（2回まで。再生中はほかの音声を止める）
  function audioButton(code) {
    const b = el("button", "btn it-play");
    b.type = "button";
    const left = () => MAX_PLAYS - (draft.plays[code] || 0);
    const label = () => {
      if (playing === code) b.innerHTML = "■ 再生中… <span class=\"id-text\">Memutar…</span>";
      else if (left() <= 0) b.innerHTML = "もう聞けません <span class=\"id-text\">Sudah habis</span>";
      else b.innerHTML = "▶ 聞く（のこり " + left() + " 回）<span class=\"id-text\">Putar (sisa " + left() + "x)</span>";
      b.disabled = playing === code || left() <= 0;
    };
    label();
    b.addEventListener("click", () => {
      const a = audios[code];
      if (!a || left() <= 0 || playing) return;
      draft.plays[code] = (draft.plays[code] || 0) + 1;
      saveDraft();
      playing = code;
      label();
      a.currentTime = 0;
      const end = () => { playing = null; label(); refreshPlays(); };
      a.onended = end;
      a.onerror = () => { draft.plays[code]--; saveDraft(); end(); alertAudio(); };
      const pr = a.play();
      if (pr && pr.catch) pr.catch(() => { draft.plays[code]--; saveDraft(); end(); alertAudio(); });
    });
    b.dataset.code = code;
    b._label = label;
    return b;
  }
  function refreshPlays() { document.querySelectorAll(".it-play").forEach(b => b._label && b._label()); }
  function alertAudio() { $("it-send-msg").textContent = "音声を再生できませんでした。電波を確認してもう一度押してください（回数は減っていません） / Audio gagal diputar."; }

  // ---- 送信 ----
  function unanswered() {
    const out = [];
    test.sections.forEach(s => s.items.forEach(it => { if (it.choices && it.pts && !(draft.ans[it.n] || []).length) out.push(it.n); }));
    return out;
  }
  $("it-form").addEventListener("submit", e => {
    e.preventDefault();
    if (!student) return;
    const miss = unanswered();
    document.querySelectorAll(".it-item").forEach(x => x.classList.toggle("it-missing", miss.includes(Number(x.dataset.n))));
    $("it-check-text").innerHTML = miss.length
      ? "まだ答えていない問題が <b>" + miss.length + "</b> 問あります。<span class=\"id-text\">Masih ada " + miss.length + " soal yang belum dijawab.</span>"
      : "送信しますか？ 送信したら答えは変えられません。<span class=\"id-text\">Kirim jawaban? Setelah dikirim, jawaban tidak bisa diubah.</span>";
    $("it-check").hidden = false;
    $("it-send").hidden = true;
    $("it-check").scrollIntoView({ block: "center" });
  });
  $("it-cancel").addEventListener("click", () => {
    $("it-check").hidden = true;
    $("it-send").hidden = false;
    const first = document.querySelector(".it-missing");
    if (first) first.scrollIntoView({ block: "center" });
  });
  $("it-send2").addEventListener("click", send);

  async function send() {
    const btn = $("it-send2");
    btn.disabled = true;
    $("it-send-msg").textContent = "";
    loading(true);
    try {
      const res = await fetch(API_URL, { method: "POST", body: new URLSearchParams({
        action: "isubmit", k: student.key, f: formId, aid: draft.aid,
        ans: JSON.stringify(draft.ans), sec: String(Math.round((Date.now() - (draft.started || Date.now())) / 1000))
      }) });
      const r = await res.json();
      if (!r || !r.ok) {
        $("it-send-msg").textContent = (r && r.reason === "auth")
          ? "ログインの期限が切れました。答えはこのスマホに残っています。ポータルでログインしてから、もう一度このテストを開いてください / Sesi habis. Masuk lagi di portal, lalu buka tes ini lagi."
          : (r && r.reason === "not_assigned")
          ? "🔒 このテストの指定がはずれたので、送れませんでした。先生に聞いてください / Tugas tes ini sudah dibatalkan guru. Tanyakan ke guru."
          : "送れませんでした。もう一度「このまま送る」を押してください / Gagal mengirim. Tekan lagi.";
        return;
      }
      clearDraft();
      showResult(r);
    } catch (e) {
      $("it-send-msg").textContent = "送れませんでした。電波を確認して、もう一度「このまま送る」を押してください。答えはこのスマホに残っています / Gagal mengirim. Cek sinyal lalu tekan lagi.";
    } finally {
      btn.disabled = false;
      loading(false);
    }
  }

  // ---- 結果 ----
  function showResult(r) {
    Object.values(audios).forEach(a => { try { a.pause(); } catch (e) {} });
    $("it-form").hidden = true;
    $("it-total").textContent = r.total;
    $("it-max").textContent = r.max;
    $("it-kind").innerHTML = r.first
      ? "✔ 成績に入りました（1回目） <span class=\"id-text\">Tercatat sebagai nilai (percobaan ke-1)</span>"
      : r.attempt + "回目（練習）。成績は1回目の点数です <span class=\"id-text\">Percobaan ke-" + r.attempt + " (latihan). Nilai yang dipakai adalah percobaan pertama.</span>";
    const secs = $("it-secs");
    secs.replaceChildren();
    r.detail.forEach(d => secs.append(el("span", "it-sec-score", esc(d.sec) + " " + d.score + "/" + d.max)));
    $("it-receipt").textContent = "受付番号 / Nomor: " + r.receipt;

    const res = {};
    r.items.forEach(x => { res[x.n] = x; });
    const rv = $("it-review");
    rv.replaceChildren();
    test.sections.forEach(sec => {
      rv.append(el("h3", "it-rv-sec", ruby(sec.name)));
      sec.items.forEach(it => {
        if (!it.choices) {   // 見出し・画像はそのまま出す（答えあわせのときに問題がわかるように）
          if (it.text) rv.append(el("p", "it-q", (it.audio ? "🔊 " : "") + ruby(it.text)));
          if (it.img) { const img = el("img", "it-img"); img.src = ASSET + it.img + ".jpg"; img.alt = ""; rv.append(img); }
          return;
        }
        const x = res[it.n];
        if (!x) return;
        const box = el("div", "it-rv " + (x.ok ? "it-ok" : "it-ng"));
        box.append(el("p", "it-q", (x.ok ? "⭕ " : "❌ ") + ruby(it.text)));
        const mine = draft.ans[it.n] || [];
        box.append(el("p", "it-rv-line", "あなた / Anda：" + (mine.length ? mine.map(ruby).join("、") : "（なし）")));
        if (!x.ok) box.append(el("p", "it-rv-line it-rv-correct", "正解 / Benar：" + x.correct.map(ruby).join("、")));
        rv.append(box);
      });
    });
    $("it-result").hidden = false;
    window.scrollTo(0, 0);
  }

  start();
})();

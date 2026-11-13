// 読み方練習（yomi.html）の動き。
// メニュー（yomi.json）→ 練習の中のステージ（例 yomi-num.json）→ 10問 → 結果。
// 成績はどこにも送らない（画面に出すだけ）。
(function () {
  const $ = id => document.getElementById(id);
  let menu = null;     // yomi.json
  let mod = null;      // いま開いている練習のデータ（yomi-num.json など）
  let stage = null;    // いまのステージ
  let stages = [];     // いま開いている練習のステージ一覧
  let prompt = null;   // 問いの文（練習ごと）
  let qs = [];         // 出す問題 [{ show, a, choices:[{t, tag}], n, ni }]
  let pos = 0;         // 何問目か
  let wrong = [];      // まちがえた問題 { q, picked }

  // ---- 共通 ----
  function show(viewId) {
    document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== viewId));
    window.scrollTo(0, 0);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // 日本語＋インドネシア語（小さく）
  function twoLang(parent, ja, idn) {
    parent.append(document.createTextNode(ja));
    if (idn) parent.append(el("span", "id-text", idn));
  }
  function rand(n) { return Math.floor(Math.random() * n); }
  function pick(arr) { return arr[rand(arr.length)]; }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  async function getJson(file) {
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) throw new Error(file + " " + res.status);
    return res.json();
  }

  // =====================================================================
  // 数字の読み方：数 → ひらがな、と よくある まちがいの 作り方
  // =====================================================================
  const D = ["", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"];

  // 0〜9999 を読む。opt で わざと まちがえる（選択肢づくり用）
  //  opt.plain：音の変化をしない（さんひゃく・はちせん…）
  //  opt.ichi ：1 に「いち」を付ける（いちひゃく・いちせん…）
  //  opt.shiku：4 → し、9 → く
  //  big      ：うしろに 万・億 が付く（1000万 → いっせんまん）
  function read4(n, big, opt) {
    opt = opt || {};
    const t = Math.floor(n / 1000), h = Math.floor(n / 100) % 10, j = Math.floor(n / 10) % 10, o = n % 10;
    const d = x => (opt.shiku && x === 4 ? "し" : opt.shiku && x === 9 ? "く" : D[x]);
    let s = "";
    if (t) {
      if (t === 1) s += opt.ichi ? "いちせん" : big ? "いっせん" : "せん";
      else if (t === 3) s += opt.plain ? "さんせん" : "さんぜん";
      else if (t === 8) s += opt.plain ? "はちせん" : "はっせん";
      else s += d(t) + "せん";
    }
    if (h) {
      if (h === 1) s += opt.ichi ? "いちひゃく" : "ひゃく";
      else if (h === 3) s += opt.plain ? "さんひゃく" : "さんびゃく";
      else if (h === 6) s += opt.plain ? "ろくひゃく" : "ろっぴゃく";
      else if (h === 8) s += opt.plain ? "はちひゃく" : "はっぴゃく";
      else s += d(h) + "ひゃく";
    }
    if (j) s += (j === 1 ? (opt.ichi ? "いち" : "") : d(j)) + "じゅう";
    if (o) s += d(o);
    return s;
  }

  // 数を読む（1億 まで。それより大きい数は 出さない）
  function readNum(n, opt) {
    if (n === 0) return "ゼロ";
    const oku = Math.floor(n / 1e8), man = Math.floor(n / 1e4) % 1e4, rest = n % 1e4;
    let s = "";
    if (oku) s += read4(oku, true, opt) + "おく";
    if (man) s += read4(man, true, opt) + "まん";
    if (rest) s += read4(rest, false, opt);
    return s;
  }

  // インドネシア語の数え方（ribu＝千で くぎる）につられた まちがい：15,000 → じゅうごせん
  // 100万以上で juta が あるときは juta＋ribu：1,500,000 → ひゃくまん ごひゃくせん
  function readRibu(n) {
    const juta = Math.floor(n / 1e6), sisa = n % 1e6;
    if (juta && sisa && sisa % 1000 === 0) return readNum(juta * 1e6) + readNum(sisa / 1000) + "せん";
    const k = Math.floor(n / 1000), r = n % 1000;
    return readNum(k) + "せん" + (r ? read4(r, false) : "");
  }

  // 数に合う まちがいを 作る → [{ t, tag }]
  function numDistractors(n) {
    const right = readNum(n);
    const out = [];
    const add = (t, tag) => { if (t && t !== right && !out.some(o => o.t === t)) out.push({ t, tag }); };
    // 1万以上なら ribu（千で くぎる）を かならず 入れる（いちばん 多い まちがい）
    if (n >= 10000) add(readRibu(n), "ribu");
    // 音の変化・「いち」の まちがい（順番は ばらばら）
    shuffle([{ t: readNum(n, { plain: true }), tag: "oto" }, { t: readNum(n, { ichi: true }), tag: "ichi" }])
      .forEach(m => add(m.t, m.tag));
    // けたの まちがい（10倍・10分の1）
    const keta = shuffle([n * 10, n % 10 === 0 ? n / 10 : 0, n * 100, n % 100 === 0 ? n / 100 : 0]).filter(x => x > 0 && x <= 1e9);
    keta.forEach(x => add(readNum(x), "keta"));
    // のばす音
    if (right.includes("じゅう")) add(right.replace("じゅう", "じゅ"), "long");
    if (right.includes("きゅう")) add(right.replace("きゅう", "きゅ"), "long");
    add(readNum(n, { shiku: true }), "shiku");
    // 前から 3つ（add で 重なりと 正解は もう 消してある）
    return out.slice(0, 3);
  }

  // 1,234,000 のように カンマ付きで 表示
  function fmt(n) { return n.toLocaleString("en-US"); }

  // ステージごとに 数を作る（よく まちがえる 数が 出やすいように）
  const HARD = [1, 3, 6, 8];
  function genNumber(kind) {
    if (kind === "s1") {          // 100〜9,999
      const t = Math.random() < 0.6 ? pick(HARD) : rand(10);
      const h = Math.random() < 0.6 ? pick(HARD) : rand(10);
      const j = Math.random() < 0.3 ? rand(10) : 0;
      const n = t * 1000 + h * 100 + j * 10;
      return n >= 100 ? n : 300;
    }
    if (kind === "s2") {          // 1万〜99万
      const a = Math.random() < 0.5 ? 1 + rand(20) : 1 + rand(99);
      const b = rand(10);
      const c = Math.random() < 0.25 ? pick(HARD) : 0;
      return a * 10000 + b * 1000 + c * 100;
    }
    // s3：100万〜1億（ゼロが 多い 数）
    if (Math.random() < 0.2) return pick([1e8, 1e8, 1.2e8, 1.5e8, 3e8]);
    const sig = (1 + rand(9)) * 10 + (Math.random() < 0.6 ? rand(10) : 0);   // 10〜99
    return sig * pick([1e5, 1e6]);   // 100万〜9,900万
  }

  // 1問を作る（数字のステージ）
  function makeNumQ(kind) {
    for (let k = 0; k < 20; k++) {
      const n = genNumber(kind);
      const yen = Math.random() < 0.3;   // ときどき 値段（円）にする
      const xs = numDistractors(n);
      if (xs.length < 3) continue;
      const suf = yen ? "えん" : "";
      return {
        show: fmt(n) + (yen ? "円" : ""),
        key: String(n),
        a: readNum(n) + suf,
        choices: xs.map(x => ({ t: x.t + suf, tag: x.tag }))
      };
    }
    return null;
  }

  // 1問を作る（リストのステージ）
  function makeListQ(item) {
    return { show: item.q, key: item.q, sub: item.m, a: item.a, n: item.n, ni: item.ni,
             choices: item.x.map(x => ({ t: x[0], tag: x[1] })) };
  }

  // リストのステージの問題：list が true なら items、名前なら その名前のリスト（例 letters）
  function listOf(s) { return mod[s.list === true ? "items" : s.list] || []; }

  // ステージの問題を count 問 そろえる（同じ問題は なるべく 出さない）
  function buildQuestions(st, count) {
    const kinds = st.mix ? st.mix : [st.id];
    const out = [], keys = new Set();
    let guard = 0;
    while (out.length < count && guard++ < 200) {
      const kind = kinds[out.length % kinds.length];
      const s = stages.find(x => x.id === kind);
      const q = s.list ? makeListQ(pick(listOf(s)))
        : window.YomiKanji && YomiKanji.isGen(s.gen) ? YomiKanji.makeQ(s, mod)   // 漢字（yomi-kanji.js）
        : makeNumQ(s.gen);
      if (!q || keys.has(q.key)) continue;
      keys.add(q.key);
      out.push(q);
    }
    return shuffle(out);
  }

  // =====================================================================
  // 画面
  // =====================================================================

  // ---- メニュー ----
  function renderMenu() {
    const list = $("menu-list");
    list.innerHTML = "";
    menu.modules.forEach(m => {
      if (m.status !== "ready") {
        const d = el("div", "item item-soon");
        twoLang(d, m.nameJa + "（じゅんびちゅう）", m.nameId + " (Segera hadir)");
        list.append(d);
        return;
      }
      const b = el("button", "item item-group");
      b.type = "button";
      twoLang(b, m.nameJa, m.nameId + (m.desc ? "　" + m.desc : ""));
      b.addEventListener("click", () => openModule(m));
      list.append(b);
    });
    show("view-menu");
  }

  async function openModule(m) {
    $("loading").hidden = false;
    try { mod = await getJson(m.file); }
    catch (e) { $("loading").hidden = true; alert("よみこめませんでした / Gagal memuat"); return; }
    $("loading").hidden = true;
    // 1つのデータを2つの練習で使うときは mode で分ける（漢字の意味・漢字の読み方）
    const md = m.mode && mod.modes ? mod.modes[m.mode] : mod;
    stages = md.stages;
    prompt = md.prompt || null;
    $("stage-title").textContent = "";
    twoLang($("stage-title"), m.nameJa, m.nameId);
    const list = $("stage-list");
    list.innerHTML = "";
    stages.forEach(st => {
      const b = el("button", "item item-group");
      b.type = "button";
      twoLang(b, st.nameJa, st.nameId + (st.desc ? "　" + st.desc : ""));
      b.addEventListener("click", () => start(st));
      list.append(b);
    });
    show("view-stage");
  }

  // ---- 問題 ----
  function start(st, onlyThese) {
    stage = st;
    const pr = prompt || { ja: "よみかたは どれですか。", id: "Bagaimana cara membacanya?" };
    $("q-prompt").textContent = "";
    twoLang($("q-prompt"), pr.ja, pr.id);
    qs = onlyThese ? shuffle(onlyThese) : buildQuestions(st, mod.count || 10);
    pos = 0;
    wrong = [];
    renderQ();
    show("view-quiz");
  }

  function renderQ() {
    const q = qs[pos];
    $("q-progress").textContent = (pos + 1) + " / " + qs.length;
    $("q-number").textContent = q.show;
    $("q-number").classList.toggle("q-sign", q.style === "sign");   // 看板・表示は看板風に
    $("q-sub").textContent = q.sub || "";      // ことばの意味（インドネシア語）。ないときは出さない
    $("q-sub").hidden = !q.sub;
    $("q-feedback").hidden = true;
    $("q-next").hidden = true;
    const box = $("q-choices");
    box.innerHTML = "";
    const all = shuffle([{ t: q.a, ok: true }].concat(q.choices));
    all.forEach((c, i) => {
      const b = el("button", "choice");
      b.type = "button";
      b.append(el("span", "choice-no", String(i + 1)), el("span", "choice-text", c.t));
      b.addEventListener("click", () => answer(c, b));
      box.append(b);
    });
  }

  function answer(c, btn) {
    const q = qs[pos];
    const buttons = Array.from($("q-choices").children);
    buttons.forEach(b => {
      b.disabled = true;
      if (b.querySelector(".choice-text").textContent === q.a) b.classList.add("choice-ok");
    });
    const fb = $("q-feedback");
    fb.innerHTML = "";
    if (c.ok) {
      fb.className = "feedback feedback-ok";
      fb.append(el("p", "fb-head", "せいかい！ / Benar!"));
    } else {
      btn.classList.add("choice-ng");
      wrong.push({ q, picked: c.t, tag: c.tag });
      fb.className = "feedback feedback-ng";
      fb.append(el("p", "fb-head", "ざんねん / Salah"));
      fb.append(el("p", "fb-answer", q.show + " ＝ " + q.a));
      const tag = mod.tags[c.tag];
      if (tag) { const p = el("p", "fb-tip"); twoLang(p, tag.ja, tag.id); fb.append(p); }
    }
    if (q.n) { const p = el("p", "fb-tip"); twoLang(p, q.n, q.ni); fb.append(p); }
    // 漢字カード（読み方の一覧・ことば）。正解でも まちがいでも 出す
    (q.cards || []).forEach(c => fb.append(YomiKanji.renderCard(c, el, twoLang)));
    fb.hidden = false;
    $("q-next").textContent = "";
    twoLang($("q-next"), pos + 1 < qs.length ? "つぎへ" : "けっかを 見る", pos + 1 < qs.length ? " Lanjut" : " Lihat hasil");
    $("q-next").hidden = false;
    $("q-next").focus();
  }

  $("q-next").addEventListener("click", () => {
    pos++;
    if (pos < qs.length) { renderQ(); window.scrollTo(0, 0); }
    else renderResult();
  });

  // ---- 結果 ----
  function renderResult() {
    const right = qs.length - wrong.length;
    $("r-score").textContent = right + " / " + qs.length;
    $("r-stage").textContent = stage.nameJa;
    const list = $("r-wrong");
    list.innerHTML = "";
    $("r-wrong-title").hidden = wrong.length === 0;
    $("r-retry-wrong").hidden = wrong.length === 0;
    wrong.forEach(w => {
      const d = el("div", "item");
      d.append(el("span", "r-q", w.q.show + " ＝ " + w.q.a));
      d.append(el("span", "id-text", "あなたの こたえ / Jawaban Anda：" + w.picked));
      list.append(d);
    });
    // にがてな ポイント（まちがいの種類ごと）
    const count = {};
    wrong.forEach(w => { if (w.tag) count[w.tag] = (count[w.tag] || 0) + 1; });
    const tips = $("r-tips");
    tips.innerHTML = "";
    Object.keys(count).sort((a, b) => count[b] - count[a]).forEach(k => {
      const tag = mod.tags[k];
      if (!tag) return;
      const p = el("p", "fb-tip");
      twoLang(p, "（" + count[k] + "回）" + tag.ja, tag.id);
      tips.append(p);
    });
    $("r-tips-title").hidden = tips.children.length === 0;
    show("view-result");
  }

  $("r-again").addEventListener("click", () => start(stage));
  $("r-retry-wrong").addEventListener("click", () => start(stage, wrong.map(w => w.q)));
  $("r-stages").addEventListener("click", () => show("view-stage"));
  $("stage-back").addEventListener("click", () => show("view-menu"));
  $("q-quit").addEventListener("click", () => show("view-stage"));

  // ---- はじめ ----
  (async function init() {
    try { menu = await getJson("yomi.json"); renderMenu(); }
    catch (e) { $("loading").textContent = "よみこめませんでした / Gagal memuat"; }
  })();

  // 動作確認用（ブラウザの外から読み方を確かめるため）
  window.YomiNum = { readNum, numDistractors, readRibu };
})();

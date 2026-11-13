// 読み方練習の「漢字の意味」「漢字の読み方」の問題づくり。
// データは yomi-kanji.json（kanji：1字ずつ、signs：看板・表示）。画面は yomi.js が出す。
window.YomiKanji = (function () {
  let data = null, byK = {}, words = [];

  const rand = n => Math.floor(Math.random() * n);
  const pick = a => a[rand(a.length)];
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const isKanji = c => /[一-鿿々]/.test(c);
  const first = m => String(m).split(";")[0].trim();   // 意味の最初のひとつ（ヒント用）

  // データを受け取って、字 → データ と ことばの一覧 を作る（ことばは重ならないように）
  function init(mod) {
    if (data === mod) return;
    data = mod; byK = {}; words = [];
    const seen = new Set();
    mod.kanji.forEach(e => {
      byK[e.k] = e;
      e.w.forEach(w => {
        if (seen.has(w[0])) return;
        seen.add(w[0]);
        words.push({ w: w[0], r: w[1], m: w[2], lv: e.lv });
      });
    });
  }

  // 日本語として ありえない かな（っっ、さいごの っ、っ の あとの 母音 など）は 選択肢にしない
  const BAD = /っっ|^[っんー]|っ$|っ[あいうえおなにぬねのまみむめもやゆよらりるれろわをんゃゅょ]/;

  // 答えと重ならない選択肢を3つまで集める
  function collect(answer, lists) {
    const out = [], seen = new Set([answer]);
    lists.forEach(list => list.forEach(c => {
      if (out.length < 3 && c.t && !seen.has(c.t) && !BAD.test(c.t)) { seen.add(c.t); out.push(c); }
    }));
    return out;
  }

  // ---- 読み方のひっかけ ----
  // 同じ漢字のほかの読み方に入れかえる（例 先生 せんせい → せんしょう）
  function swapReadings(word, reading) {
    const out = [];
    [...word].forEach((c, i) => {
      const e = byK[c];
      if (!e || e.r.length < 2) return;
      const rs = e.r.slice().sort((a, b) => b.length - a.length);
      const last = i === word.length - 1;
      const r = rs.find(x => (i === 0 ? reading.startsWith(x) : last ? reading.endsWith(x) : reading.includes(x)));
      if (!r) return;
      e.r.forEach(r2 => {
        if (r2 === r) return;
        let t;
        if (i === 0) t = r2 + reading.slice(r.length);
        else if (last) t = reading.slice(0, reading.length - r.length) + r2;
        else t = reading.replace(r, r2);
        out.push({ t, tag: "yomi" });
      });
    });
    return shuffle(out);
  }

  // のばす音・っ・゛・ゃゅょ のまちがい
  const DAKU = { か: "が", き: "ぎ", く: "ぐ", け: "げ", こ: "ご", さ: "ざ", し: "じ", す: "ず", せ: "ぜ", そ: "ぞ",
    た: "だ", て: "で", と: "ど", は: "ば", ひ: "び", ふ: "ぶ", へ: "べ", ほ: "ぼ" };
  const UNDAKU = {}; Object.keys(DAKU).forEach(k => (UNDAKU[DAKU[k]] = k));
  Object.assign(UNDAKU, { ぱ: "ば", ぴ: "び", ぷ: "ぶ", ぺ: "べ", ぽ: "ぼ" });   // ぱ → ば も まちがいの例にする
  const SMALL = { ゃ: "や", ゅ: "ゆ", ょ: "よ" };
  // 位置を変えて いくつも作り、種類（tag）が かたよらないように 1つずつ順番に出す
  const O_ROW = "おこそとのほもよろごぞどぼぽょゅうくすつぬふむゆるぐずづぶぷ";
  const E_ROW = "えけせてねへめれげぜでべぺ";
  function mutations(r) {
    const by = { long: [], tsu: [], daku: [], ya: [] };
    const put = (tag, t) => { if (t && t !== r) by[tag].push({ t, tag }); };
    for (let i = 0; i < r.length; i++) {
      const c = r[i], next = r[i + 1];
      // のばす音：「う」「い」をとる／「う」を足す
      if (next === "う" && O_ROW.includes(c)) put("long", r.slice(0, i + 1) + r.slice(i + 2));
      else if (next === "い" && E_ROW.includes(c)) put("long", r.slice(0, i + 1) + r.slice(i + 2));
      else if ("こそとのほもよろごぞどぼょゅ".includes(c) && next !== "う") put("long", r.slice(0, i + 1) + "う" + r.slice(i + 1));
      // 小さい「っ」：とる／足す
      if (c === "っ") put("tsu", r.slice(0, i) + r.slice(i + 1));
      else if (i > 0 && "かきくけこさしすせそたちつてとぱぴぷぺぽ".includes(c) && r[i - 1] !== "っ" && r[i - 1] !== "ん") put("tsu", r.slice(0, i) + "っ" + r.slice(i));
      // 「゛」：とる／つける
      if (UNDAKU[c]) put("daku", r.slice(0, i) + UNDAKU[c] + r.slice(i + 1));
      else if (DAKU[c]) put("daku", r.slice(0, i) + DAKU[c] + r.slice(i + 1));
      // 小さい「ゃゅょ」を大きく
      if (SMALL[c]) put("ya", r.slice(0, i) + SMALL[c] + r.slice(i + 1));
    }
    const lists = shuffle(Object.values(by).map(shuffle)).filter(l => l.length);
    const out = [];
    for (let k = 0; lists.some(l => l[k]); k++) lists.forEach(l => l[k] && out.push(l[k]));
    return out;
  }

  // ---- カード（答えたあとに出す） ----
  function kanjiCard(e) { return { type: "kanji", k: e.k, m: e.m, r: e.r, w: e.w, h: e.h }; }
  function cardsFor(word) {
    return [...new Set([...word].filter(c => byK[c]))].slice(0, 3).map(c => kanjiCard(byK[c]));
  }

  // ---- 問題 ----
  function kmean(st) {
    const list = data.kanji.filter(e => e.lv === st.lv);
    const e = pick(list);
    const look = shuffle(e.look.filter(c => byK[c] && byK[c].m !== e.m).map(c => ({ t: byK[c].m, tag: "look" }))).slice(0, 2);
    const other = shuffle(list.filter(x => x !== e).map(x => ({ t: x.m, tag: "other" })));
    return { key: "m" + e.k, show: e.k, a: e.m, choices: collect(e.m, [look, other]), cards: [kanjiCard(e)] };
  }

  function kword(st) {
    const cand = words.filter(w => [...w.w].filter(isKanji).length >= 2 && [...w.w].every(c => !isKanji(c) || byK[c]));
    const w = pick(cand);
    const ks = [...w.w].filter(isKanji);
    const part = shuffle(words.filter(x => x !== w && ks.some(c => x.w.includes(c))).map(x => ({ t: x.m, tag: "part" })));
    const other = shuffle(cand.filter(x => x !== w).map(x => ({ t: x.m, tag: "other" })));
    const hint = st.hint ? [...new Set(ks)].map(c => c + " = " + first(byK[c].m)).join("　") : "";
    return { key: "w" + w.w, show: w.w, sub: hint, a: w.m, choices: collect(w.m, [part.slice(0, 2), other]), cards: cardsFor(w.w) };
  }

  function smean() {
    const s = pick(data.signs);
    const other = shuffle(data.signs.filter(x => x !== s).map(x => ({ t: x.m, tag: "other" })));
    return { key: "s" + s.w, show: s.w, style: "sign", a: s.m, choices: collect(s.m, [other]), cards: [{ type: "sign", w: s.w, r: s.r, m: s.m, where: s.where }] };
  }

  function kread(st) {
    const list = words.filter(w => w.lv === st.lv);
    const w = pick(list);
    const sw = swapReadings(w.w, w.r), mu = mutations(w.r);
    const other = shuffle(list.filter(x => x !== w && Math.abs(x.r.length - w.r.length) <= 1).map(x => ({ t: x.r, tag: "other" })));
    return { key: "r" + w.w, show: w.w, sub: w.m, a: w.r, choices: collect(w.r, [sw.slice(0, 2), mu, sw, other]), cards: cardsFor(w.w) };
  }

  function ksame() {
    // ほかの読み方に入れかえた選択肢が2つ以上できることばを選ぶ
    for (let k = 0; k < 50; k++) {
      const e = pick(data.kanji.filter(x => x.r.length >= 2 && x.w.length >= 2));
      const w = pick(e.w);
      const sw = swapReadings(w[0], w[1]).filter(x => x.t !== w[1]);
      if (sw.length < 2) continue;
      return { key: "x" + w[0], show: w[0], sub: w[2], a: w[1], choices: collect(w[1], [sw, mutations(w[1])]), cards: [kanjiCard(e)] };
    }
    return null;
  }

  function sread() {
    const s = pick(data.signs);
    const other = shuffle(data.signs.filter(x => x !== s && Math.abs(x.r.length - s.r.length) <= 2).map(x => ({ t: x.r, tag: "other" })));
    return { key: "t" + s.w, show: s.w, style: "sign", sub: s.m, a: s.r, choices: collect(s.r, [swapReadings(s.w, s.r).slice(0, 1), mutations(s.r), other]),
             cards: [{ type: "sign", w: s.w, r: s.r, m: s.m, where: s.where }] };
  }

  const GEN = { kmean, kword, smean, kread, ksame, sread };

  // 1問を作る。3つの選択肢がそろわないときは null（yomi.js が作り直す）
  function makeQ(st, mod) {
    init(mod);
    const q = GEN[st.gen](st);
    return q && q.choices.length === 3 ? q : null;
  }

  // カードの見た目を作る（el, twoLang は yomi.js から借りる）
  function renderCard(c, el, twoLang) {
    const box = el("div", "kcard");
    if (c.type === "sign") {
      const head = el("div", "kcard-head");
      head.append(el("span", "kcard-sign", c.w));
      const t = el("div");
      t.append(el("div", "kcard-m", c.r));
      t.append(el("div", "kcard-r", c.m));
      head.append(t);
      box.append(head);
      const p = el("p", "kcard-where");
      twoLang(p, "どこで 見る？ " + c.where, "");
      box.append(p);
      return box;
    }
    const head = el("div", "kcard-head");
    head.append(el("span", "kcard-k", c.k));
    const t = el("div");
    t.append(el("div", "kcard-m", c.m));
    const r = el("div", "kcard-r");
    twoLang(r, "読み方 " + c.r.length + "つ：" + c.r.join("・"), "Cara baca: " + c.r.length);
    t.append(r);
    head.append(t);
    box.append(head);
    const ul = el("ul", "kcard-w");
    c.w.forEach(w => {
      const li = el("li");
      li.append(el("b", "", w[0]), document.createTextNode("（" + w[1] + "）"), el("span", "kcard-wm", w[2]));
      ul.append(li);
    });
    box.append(ul);
    if (c.h) box.append(el("p", "kcard-h", c.h));
    return box;
  }

  return { makeQ, renderCard, isGen: g => !!GEN[g], _test: { swapReadings, mutations } };
})();

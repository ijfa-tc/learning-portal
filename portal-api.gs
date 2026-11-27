/**
 * IJFA Learning Portal「ポータルAPI」
 * ポータル（https://ijfa-tc.github.io/learning-portal/）からの問い合わせに答える窓口。
 *
 * ※ このファイルは控え（バックアップ）。実際に動いているのは「IJFA ポータル設定」スプレッドシートの Apps Script。
 *   直したら、両方を同じ内容にそろえること。
 *
 * できること
 *   POST action=slogin  id=JKT14001 pw=パスワード
 *                                → 生徒のログイン。はじめのパスワードは生年月日8けた（例 20070415）。
 *                                   合えば名前・期生と「生徒キー」（10日）を返す。5回まちがえると15分ロック
 *   POST action=scheck  k=生徒キー → 生徒キーがいまも使えるか（パスワード変更・期限切れで使えなくなる）
 *   POST action=spw     k=生徒キー old=いまのパスワード pw=新しいパスワード（4けた以上の数字）
 *                                → パスワードを変える。ほかのスマホのログインは切れ、このスマホには新しいキーを返す
 *   POST action=slogout k=生徒キー → 生徒キーを消す（ログアウト）
 *   ※ 生徒のパスワードは「生徒ログイン」シートに「印（ハッシュ）」だけ保存。行がない生徒は生年月日で入る。
 *     パスワードを忘れた生徒は、その行の B列・C列（印・ソルト）を消せば生年月日にもどる
 *   ?action=student              → 使わなくなった（IDだけで名前が出ないように、名前はログインのあとだけ返す）
 *   ?action=portal&cohort=JKT14  → カテゴリー・公開中の教材・その期生への指定テストを返す
 *   POST（Googleから）credential  → 先生か確かめ、ポータルへもどるボタンの画面を出す（合言葉 t つき）
 *   ?action=tsession&t=合言葉     → 先生の名前と期生の一覧を返す（合言葉は5分・1回だけ有効）
 *   ?action=cohorts              → 期生の一覧（例 JKT16）だけを返す。先生のホームの選択肢を最新にする用
 *   ?action=minna&id=JKT14001    → みんなの日本語で、その生徒の期に先生が指定している課（例 ["L03","M01"]）だけを返す
 *   ?action=minna&cohort=JKT14   → 同じものを期生で（先生の確認用の画面から）
 *   POST action=feedback         → ホームの「ご意見をお聞かせください」の内容を「報告・要望」シートに1行足す
 *                                   （シートがなければ自動で作る。メールは送らない）
 *   POST action=tassign  k=先生キー cohort=JKT16
 *                                → 先生の「指定テストを選ぶ」画面用：いまの指定・教材の一覧（公開OFFもふくむ）を返す
 *   POST action=tsave    k=先生キー cohort=JKT16 names=["教材名",…] ver=読みこんだときの印
 *                                → 指定テストシートのその期生の行を、画面で選んだ内容に入れかえる
 *   POST action=tlogout  k=先生キー → 先生キーを消す（ログアウト）
 *   ※ 先生キー：先生がGoogleでログインしたときに1つ作る合鍵（1年有効）。スクリプト プロパティに「印（ハッシュ）」だけ保存。
 *     使うたびに「先生」シートで、いまも有効な先生か確かめる（シートで有効を外せば、すぐ使えなくなる）
 *
 * 最初に1回だけ：setup を実行（シートの準備・フォーム一覧の取り込み・毎日の自動更新を設定）
 * 先生用ログインの準備：setupTeachers を1回実行（「先生」シートを作る＋外部への問い合わせを許可）
 * 生徒のパスワードの準備：setupStudentLogin を1回実行（「生徒ログイン」シートを作る＋原本の生年月日を確認）
 * コードを直したら：「デプロイ」→「デプロイを管理」→ 鉛筆 →「新バージョン」で公開し直す
 */

// ---- 設定（ふつうは変えない） ----
const FORM_FOLDER_ID = '13ubBplPb4-pdNW_DnucMHVG_Xp8YJTWl';           // 「IJFA テストフォーム」フォルダ（中のフォルダも全部見る）
const DB_ID = '12DTewBMLeAMChvtLLqSyjZVD7sm5-diTrq_3EAWWjVI';          // DATA BASE SISWA IJFA - UPDATE（原本）
const DB_RANGE = "'DATABASE SISWA・生徒データベース'!A5:G";            // 原本の範囲（B名前・D生徒ID・F出身TC・G期生）
const ID_RE = /^[A-Z]{3}[0-9]{5}$/;                                    // 生徒IDの形（例 JKT16001）
const SHEET = { roster: '名簿', cat: 'カテゴリー', mat: '教材リスト', asg: '指定テスト' };
const CACHE_SEC = 60;                                                  // 設定の変更がポータルに出るまで最大60秒
// 先生用ログイン：Google Cloud で作った「OAuth クライアントID」（公開してよい値）。ポータルの config.js と同じものを入れる
const TEACHER_CLIENT_ID = '104523748851-6vkdfmldttl2h96i03utphdr83eil1qt.apps.googleusercontent.com';
const PORTAL_URL = 'https://ijfa-tc.github.io/learning-portal/';     // 先生用ログインのあと、もどる先
const TEACHER_SHEET = '先生';                                          // 許可リスト（A メールアドレス / B 名前 / C 有効 / D メモ）
                                                                       // A列に「@lpkjapan.com」のように @から書くと、その会社アカウント全員を許可
const FEEDBACK_SHEET = '報告・要望';                                   // ホームの意見フォームの送り先
const FEEDBACK_MAX = 1000;                                             // 内容は1000文字まで
const FEEDBACK_LIMIT = 10;                                             // 同じ人から1時間に10件まで（いたずら・連打よけ。ゲストは全員で30件）
const TEACHER_KEY_DAYS = 365;                                          // 先生キーの有効期間（ポータルのログインと同じ1年）
const ASSIGN_MAX = 50;                                                 // 1つの期生に指定できるテストは50個まで
const STUDENT_SHEET = '生徒ログイン';                                  // 生徒のパスワード（A 生徒ID / B 印 / C ソルト / D 変更日時 / E 世代 / F メモ）
const DB_BIRTH_RANGE = "'DATABASE SISWA・生徒データベース'!D5:E";      // 原本の D 生徒ID・E 生年月日
const STUDENT_KEY_DAYS = 10;                                           // 生徒のログインは10日で切れる
const LOGIN_MAX_FAIL = 5;                                              // 5回まちがえたら…
const LOGIN_LOCK_SEC = 900;                                            // …15分入れない
const PW_RE = /^[0-9]{4,20}$/;                                         // パスワードは4けた以上の数字（生年月日・かんたんな並びもOK）
const PW_ROUNDS = 100;                                                 // 印（ハッシュ）を作るときにくり返す回数

// =====================================================================
// ポータルからの問い合わせ
// =====================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    if (p.action === 'student') out = { found: false, reason: 'login_required' };   // 名前はログインのあとだけ
    else if (p.action === 'portal') out = getPortal_(String(p.cohort || '').trim().toUpperCase());
    else if (p.action === 'tsession') out = teacherSession_(String(p.t || ''));
    else if (p.action === 'cohorts') out = { cohorts: cohorts_() };
    else if (p.action === 'minna') out = minnaOpen_(String(p.id || '').trim().toUpperCase(), String(p.cohort || '').trim().toUpperCase());
    else out = { error: 'unknown action' };
  } catch (err) {
    console.error(err);
    out = { error: 'server error' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Googleのログイン画面から、ここへ直接もどってくる（credential つき）。
// 先生か確かめたら、合言葉を作って「ポータルにもどる」ボタンの画面を出す
function doPost(e) {
  const p = (e && e.parameter) || {};
  // ホームの意見フォームから（ポータルが送ってくる）
  // ホームの意見フォーム・先生の「指定テストを選ぶ」画面から（ポータルが送ってくる）
  const api = { feedback: saveFeedback_, tassign: assignView_, tsave: assignSave_, tlogout: teacherLogout_,
                slogin: studentLogin_, scheck: studentCheck_, spw: studentPassword_, slogout: studentLogout_ }[p.action];
  if (api) {
    let out;
    try { out = api(p); }
    catch (err) { console.error(err); out = { ok: false, reason: 'server' }; }
    return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  }
  let back;
  try {
    const r = teacherLogin_(String(p.credential || ''));
    if (r.ok) {
      const t = Utilities.getUuid();
      CacheService.getScriptCache().put('tsession_' + t, JSON.stringify(r), 300);   // 5分だけ有効
      back = PORTAL_URL + '?t=' + t;
    } else {
      back = PORTAL_URL + '?tlerr=' + encodeURIComponent(r.reason);
    }
  } catch (err) {
    console.error(err);
    back = PORTAL_URL + '?tlerr=server';
  }
  return backPage_(back);
}

// 合言葉と引きかえに先生の情報を返す（1回使ったら消す）
function teacherSession_(t) {
  if (!/^[0-9a-f-]{36}$/i.test(t)) return { ok: false };
  const cache = CacheService.getScriptCache();
  const hit = cache.get('tsession_' + t);
  if (!hit) return { ok: false };
  cache.remove('tsession_' + t);
  return JSON.parse(hit);
}

// 「ポータルにもどる」画面。自動でもどれないブラウザのためにボタンも出す
function backPage_(url) {
  const u = JSON.stringify(url);
  const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:sans-serif;text-align:center;padding:48px 16px">' +
    '<p style="font-size:18px">ポータルにもどります / Kembali ke portal</p>' +
    '<a id="go" href="' + url.replace(/"/g, '&quot;') + '" target="_top" ' +
    'style="display:inline-block;margin-top:16px;padding:16px 28px;background:#1f5fa8;color:#fff;border-radius:12px;font-size:18px;text-decoration:none">' +
    'ポータルへ / Ke portal</a>' +
    '<script>try{window.top.location.href=' + u + ';}catch(e){}</script></body>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// 先生用ログイン：Googleの証明を確かめ、「先生」シートで有効になっているメールなら名前と期生の一覧を返す
// 1) メールアドレスが1人ずつ登録されていればその名前で入る
// 2) なければ「@lpkjapan.com」のような会社全体の行を見る。会社のGoogle Workspaceのアカウント（hd）だけ許可し、名前はGoogleの名前
function teacherLogin_(credential) {
  const g = verifyGoogle_(credential);
  if (!g) return { ok: false, reason: 'bad_token' };
  const name = teacherName_(g.email, g.hd, g.name);
  if (!name) {
    console.log('先生として未登録: ' + g.email);   // 実行ログで確認できる（シートに足すときの参考）
    return { ok: false, reason: 'not_allowed' };
  }
  const key = issueTeacherKey_(g.email, g.hd, name);   // 指定テストの変更などに使う合鍵
  return { ok: true, teacher: { name: name, email: g.email }, cohorts: cohorts_(), key: key };
}

// 「先生」シートで、いまも有効な先生か確かめる。有効なら名前を返す（だめなら ''）
function teacherName_(email, hd, googleName) {
  const rows = values_(TEACHER_SHEET).filter(r => r[2] === true);
  const person = rows.find(r => str_(r[0]).toLowerCase() === email);
  if (person) return str_(person[1]) || googleName || email;
  const domain = rows.find(r => {
    const a = str_(r[0]).toLowerCase();
    return a.charAt(0) === '@' && hd && a === '@' + hd;
  });
  return domain ? (googleName || email) : '';
}

// ---- 先生キー（合鍵） ----
// キーそのものは先生のスマホにだけ置き、こちらには「印（ハッシュ）」だけ保存する
function keyHash_(key) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(key)));
}
function issueTeacherKey_(email, hd, name) {
  const props = PropertiesService.getScriptProperties();
  // 期限切れのキーをそうじする
  const all = props.getProperties();
  Object.keys(all).filter(k => k.indexOf('tk_') === 0).forEach(k => {
    try { if (JSON.parse(all[k]).until < Date.now()) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('tk_' + keyHash_(key), JSON.stringify({ email: email, hd: hd || '', name: name || '', until: Date.now() + TEACHER_KEY_DAYS * 86400000 }));
  return key;
}
// キーから先生を確かめる。OKなら { email, name }、だめなら null
function teacherFromKey_(key) {
  if (!/^[0-9a-f]{64}$/.test(String(key || ''))) return null;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('tk_' + keyHash_(key));
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (s.until < Date.now()) { props.deleteProperty('tk_' + keyHash_(key)); return null; }
  const name = teacherName_(s.email, s.hd, s.name || '');
  return name ? { email: s.email, name: name } : null;
}
function teacherLogout_(p) {
  if (/^[0-9a-f]{64}$/.test(String(p.k || ''))) PropertiesService.getScriptProperties().deleteProperty('tk_' + keyHash_(p.k));
  return { ok: true };
}

// =====================================================================
// 先生の「指定テストを選ぶ」画面
// 「指定テスト」シート（A 期生 / B 教材（名前）/ C 指定 / D 表示順 / E メモ）を読み書きする。
// シートを直接さわってもよい（画面とシートは同じものを見ている）
// =====================================================================
// その期生の、いま指定ONのテスト名（表示順）
function assignedNames_(rows, cohortKey) {
  return rows.map((r, i) => ({ r: r, i: i }))
    .filter(x => str_(x.r[0]).toUpperCase() === cohortKey && x.r[2] === true && str_(x.r[1]))
    .sort((a, b) => (num_(a.r[3]) - num_(b.r[3])) || (a.i - b.i))
    .map(x => str_(x.r[1]));
}
// 読みこんだあとに、ほかの先生が変えていないかを見るための印
function assignVer_(names) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(names)));
}

function assignView_(p) {
  const t = teacherFromKey_(p.k);
  if (!t) return { ok: false, reason: 'auth' };
  const cohortKey = str_(p.cohort).toUpperCase();
  if (!/^[A-Z]{3}[0-9]{2}$/.test(cohortKey)) return { ok: false, reason: 'cohort' };
  const categories = values_(SHEET.cat)
    .filter(r => str_(r[0]))
    .map(r => ({ id: str_(r[0]), nameJa: str_(r[1]), nameId: str_(r[2]), order: num_(r[3]) }))
    .sort(byOrder_);
  // 公開OFFの教材も選べる（ただし「じゅんびちゅう」は除く）
  const materials = values_(SHEET.mat)
    .filter(r => str_(r[2]) && str_(r[5]) && str_(r[4]) !== 'soon')
    .map(r => ({ categoryId: str_(r[1]), nameJa: str_(r[2]), nameId: str_(r[3]), type: str_(r[4]),
                 public: r[6] === true, order: num_(r[7]), group: str_(r[9]) }));
  const names = assignedNames_(values_(SHEET.asg), cohortKey);
  return { ok: true, cohort: cohortKey, categories: categories, materials: materials, assigned: names, ver: assignVer_(names) };
}

function assignSave_(p) {
  const t = teacherFromKey_(p.k);
  if (!t) return { ok: false, reason: 'auth' };
  const cohortKey = str_(p.cohort).toUpperCase();
  if (!/^[A-Z]{3}[0-9]{2}$/.test(cohortKey)) return { ok: false, reason: 'cohort' };
  let names;
  try { names = JSON.parse(String(p.names || '[]')); } catch (e) { return { ok: false, reason: 'names' }; }
  if (!Array.isArray(names)) return { ok: false, reason: 'names' };
  names = names.map(str_).filter((n, i, a) => n && a.indexOf(n) === i);   // 空・重なりを消す
  if (names.length > ASSIGN_MAX) return { ok: false, reason: 'too_many' };
  const known = {};
  values_(SHEET.mat).forEach(r => { if (str_(r[2])) known[str_(r[2])] = true; });
  const unknown = names.filter(n => !known[n]);
  if (unknown.length) return { ok: false, reason: 'unknown', names: unknown };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_(SHEET.asg);
    const rows = values_(SHEET.asg);
    if (assignVer_(assignedNames_(rows, cohortKey)) !== str_(p.ver)) return { ok: false, reason: 'changed' };
    const width = Math.max(5, sh.getLastColumn());
    const mine = r => str_(r[0]).toUpperCase() === cohortKey;
    // 前からある行は、メモなどをそのまま使う
    const old = {};
    rows.filter(mine).forEach(r => { const n = str_(r[1]); if (n && !old[n]) old[n] = r; });
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
    const fresh = names.map((n, i) => {
      const r = old[n] ? old[n].slice() : new Array(width).fill('');
      while (r.length < width) r.push('');
      r[0] = cohortKey; r[1] = n; r[2] = true; r[3] = i + 1;
      if (!old[n]) r[4] = '画面で追加：' + safeCell_(t.name) + ' ' + stamp;
      return r;
    });
    // その期生の行は、最初に出てきた場所にまとめて入れかえる（ほかの期生の行はそのまま）
    const out = [];
    let placed = false;
    rows.forEach(r => {
      if (!mine(r)) { const c = r.slice(); while (c.length < width) c.push(''); out.push(c); return; }
      if (!placed) { fresh.forEach(f => out.push(f)); placed = true; }
    });
    if (!placed) fresh.forEach(f => out.push(f));
    if (out.length) sh.getRange(2, 1, out.length, width).setValues(out);
    if (rows.length > out.length) sh.getRange(2 + out.length, 1, rows.length - out.length, width).clearContent();
    CacheService.getScriptCache().remove('portal_' + cohortKey);   // 生徒の画面にすぐ出るように
    console.log('指定テスト変更: ' + cohortKey + ' ' + t.email + ' ' + JSON.stringify(names));
    return { ok: true, ver: assignVer_(names) };
  } finally {
    lock.releaseLock();
  }
}

// Googleの証明（IDトークン）が本物か、Googleに問い合わせて確かめる。
// 正しければ { email（小文字）, name, hd（会社のWorkspaceのドメイン。個人Gmailは空） } を返す。だめなら null
function verifyGoogle_(token) {
  if (!TEACHER_CLIENT_ID || !token) return null;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
                                { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const t = JSON.parse(res.getContentText());
  const okIssuer = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  const okTime = Number(t.exp) * 1000 > Date.now();
  if (t.aud !== TEACHER_CLIENT_ID || !okIssuer || !okTime || String(t.email_verified) !== 'true') return null;
  return { email: String(t.email || '').toLowerCase(), name: String(t.name || ''), hd: String(t.hd || '').toLowerCase() };
}

// 名簿にある期生の一覧（例 ["JKT16", "JKT15", "KLT16", ...]。新しい期が上）
function cohorts_() {
  const set = {};
  values_(SHEET.roster).forEach(r => { const id = str_(r[0]).toUpperCase(); if (ID_RE.test(id)) set[id.slice(0, 5)] = true; });
  return Object.keys(set).sort((a, b) => (b.slice(3) - a.slice(3)) || a.localeCompare(b));
}

// 生徒IDから名前と期生を返す。名簿シート（原本の4列だけを写したもの）を見る
function getStudent_(id) {
  if (!ID_RE.test(id)) return { found: false };
  const rows = values_(SHEET.roster);
  for (const r of rows) {
    if (str_(r[0]).toUpperCase() === id) {
      return {
        found: true,
        student: {
          id: id,
          name: str_(r[1]),
          cohort: String(parseInt(id.slice(3, 5), 10)),  // ID の4〜5文字目が期生
          cohortKey: id.slice(0, 5)                       // 例 JKT14
        }
      };
    }
  }
  return { found: false };
}

// 期生ごとのホーム表示データ
function getPortal_(cohortKey) {
  const guest = cohortKey === 'GUEST';   // ゲスト（IDがまだない人）：フォームのテストは出さず、指定もなし
  if (!guest && !/^[A-Z]{3}[0-9]{2}$/.test(cohortKey)) return { error: 'bad cohort' };
  const cache = CacheService.getScriptCache();
  const hit = cache.get('portal_' + cohortKey);
  if (hit) return JSON.parse(hit);

  const categories = values_(SHEET.cat)
    .filter(r => str_(r[0]))
    .map(r => ({ id: str_(r[0]), nameJa: str_(r[1]), nameId: str_(r[2]), order: num_(r[3]) }))
    .sort(byOrder_);

  const all = values_(SHEET.mat)
    .filter(r => str_(r[0]) && str_(r[5]))
    .map(r => ({
      id: str_(r[0]), categoryId: str_(r[1]), nameJa: str_(r[2]), nameId: str_(r[3]),
      type: str_(r[4]), url: str_(r[5]), public: r[6] === true, order: num_(r[7]),
      group: str_(r[9])   // J列「グループ」：カテゴリーの中のまとまり（例 いろどり入門）
    }));
  const materials = all.filter(m => m.public && !(guest && m.type === 'form')).sort(byOrder_);

  // 指定テストは「教材の名前」で選ぶ（先生がプルダウンで選びやすいように）。公開OFFでも指定はできる
  const byName = {};
  all.forEach(m => { byName[m.nameJa] = m; });
  const picked = guest ? [] : values_(SHEET.asg)
    .filter(r => str_(r[0]).toUpperCase() === cohortKey && r[2] === true)
    .map(r => ({ m: byName[str_(r[1])], order: num_(r[3]) }))
    .filter(x => x.m)
    .sort(byOrder_)
    .map(x => x.m);
  // みんなの日本語の課ごとの指定は、ホームの「先生からの指定」には出さない。
  // みんなの日本語のページで、その課だけ受けられるようにする（minna に 課の記号 L03・M01 を入れる）
  const MINNA_RE = /^minna-((?:L|M)\d{2})$/;
  const assigned = picked.filter(m => !MINNA_RE.test(m.id));
  const minna = picked.filter(m => MINNA_RE.test(m.id)).map(m => m.id.match(MINNA_RE)[1]);

  const out = { categories, materials, assigned, minna };
  cache.put('portal_' + cohortKey, JSON.stringify(out), CACHE_SEC);
  return out;
}

// みんなの日本語のページ用：その生徒の期に指定されている課（名前や成績は返さない）
function minnaOpen_(id, cohortKey) {
  if (!id && /^[A-Z]{3}[0-9]{2}$/.test(cohortKey)) return { ok: true, open: getPortal_(cohortKey).minna || [] };
  const s = getStudent_(id);
  if (!s.found) return { ok: false };
  return { ok: true, open: getPortal_(s.student.cohortKey).minna || [] };
}

// =====================================================================
// 生徒のログイン（生徒ID＋パスワード）
// はじめのパスワードは原本の生年月日8けた（例 20070415）。変えた生徒は「生徒ログイン」シートに印（ハッシュ）がある。
// 生徒キー：ログインしたときに作る合鍵（10日）。キーそのものは生徒のスマホにだけ置き、
//           こちら（スクリプト プロパティ）には印だけ保存する
// =====================================================================
function studentLogin_(p) {
  const id = str_(p.id).toUpperCase();
  const pw = str_(p.pw);
  if (!ID_RE.test(id)) return { ok: false, reason: 'bad' };
  const cache = CacheService.getScriptCache();
  const failKey = 'slf_' + id;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAIL) return { ok: false, reason: 'locked' };
  const s = getStudent_(id);
  // IDがない・パスワードがちがう、どちらも同じ答え（IDがあるかどうかを当てられないように）
  const ok = s.found && /^[0-9]{1,20}$/.test(pw) && passwordMatches_(id, pw);
  if (!ok) {
    cache.put(failKey, String(fails + 1), LOGIN_LOCK_SEC);
    return { ok: false, reason: fails + 1 >= LOGIN_MAX_FAIL ? 'locked' : 'bad' };
  }
  cache.remove(failKey);
  const login = loginRow_(id);
  const k = issueStudentKey_(id, login ? login.gen : 0);
  return { ok: true, student: s.student, key: k.key, until: k.until };
}

// 生徒キーがいまも使えるか（ポータルを開いたときに裏で確かめる）
function studentCheck_(p) {
  const r = studentFromKey_(p.k);
  return r ? { ok: true, student: r.student, until: r.until } : { ok: false, reason: 'auth' };
}

// パスワードを変える：いまのパスワードを確かめてから、新しい印を「生徒ログイン」シートに書く。
// 世代を1つ上げるので、ほかのスマホの生徒キーは使えなくなる。このスマホには新しいキーを返す
function studentPassword_(p) {
  const r = studentFromKey_(p.k);
  if (!r) return { ok: false, reason: 'auth' };
  const id = r.student.id;
  const pw = str_(p.pw);
  if (!PW_RE.test(pw)) return { ok: false, reason: 'format' };
  const cache = CacheService.getScriptCache();
  const failKey = 'slf_' + id;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAIL) return { ok: false, reason: 'locked' };
  if (!passwordMatches_(id, str_(p.old))) {
    cache.put(failKey, String(fails + 1), LOGIN_LOCK_SEC);
    return { ok: false, reason: fails + 1 >= LOGIN_MAX_FAIL ? 'locked' : 'old' };
  }
  cache.remove(failKey);

  let gen;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(STUDENT_SHEET) || makeLoginSheet_();
    const row = loginRow_(id);
    gen = (row ? row.gen : 0) + 1;
    const salt = Utilities.getUuid().replace(/-/g, '');
    const rowNo = row ? row.rowNo : lastRow_(sh) + 1;
    sh.getRange(rowNo, 1, 1, 5).setValues([[id, pwHash_(salt, pw), salt, new Date(), gen]]);
  } finally {
    lock.releaseLock();
  }
  PropertiesService.getScriptProperties().deleteProperty('sk_' + keyHash_(p.k));
  const k = issueStudentKey_(id, gen);
  console.log('パスワード変更: ' + id);
  return { ok: true, key: k.key, until: k.until };
}

function studentLogout_(p) {
  if (/^[0-9a-f]{64}$/.test(String(p.k || ''))) PropertiesService.getScriptProperties().deleteProperty('sk_' + keyHash_(p.k));
  return { ok: true };
}

// パスワードが合っているか。シートに印があればそれと、なければ原本の生年月日8けたと比べる
function passwordMatches_(id, pw) {
  const row = loginRow_(id);
  if (row && row.hash && row.salt) return pwHash_(row.salt, pw) === row.hash;
  const b = births_()[id];
  return !!b && b === pw;
}

// 「生徒ログイン」シートのその生徒の行 { rowNo, hash, salt, gen }。なければ null
function loginRow_(id) {
  if (!SpreadsheetApp.getActive().getSheetByName(STUDENT_SHEET)) return null;
  const rows = values_(STUDENT_SHEET);
  for (let i = 0; i < rows.length; i++) {
    if (str_(rows[i][0]).toUpperCase() === id) {
      return { rowNo: i + 2, hash: str_(rows[i][1]), salt: str_(rows[i][2]), gen: Number(rows[i][4]) || 0 };
    }
  }
  return null;
}

// 印（ハッシュ）：ソルト＋パスワードを何回もまぜる。シートを見ても元のパスワードはわからない
function pwHash_(salt, pw) {
  let h = salt + ':' + pw;
  for (let i = 0; i < PW_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h));
  }
  return h;
}

// 原本の生年月日を { 生徒ID: '20070415' } にする（10分だけ覚えておく。ポータルには出さない）
function births_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('births');
  if (hit) return JSON.parse(hit);
  const ss = SpreadsheetApp.openById(DB_ID);
  const tz = ss.getSpreadsheetTimeZone();   // 原本の時間帯で日付を読む（1日ずれないように）
  const map = {};
  ss.getRange(DB_BIRTH_RANGE).getValues().forEach(r => {
    const id = str_(r[0]).toUpperCase();
    if (!ID_RE.test(id)) return;
    const b = toBirth8_(r[1], tz);
    if (b) map[id] = b;
  });
  cache.put('births', JSON.stringify(map), 600);
  return map;
}

// 生年月日のセル → '20070415'。日付でも文字（2007/04/15・15/04/2007・04/15/2007）でも読む。読めなければ ''
function toBirth8_(v, tz) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const f = Utilities.formatDate(v, tz, 'yyyy-M-d').split('-');
    return ymd_(f[0], f[1], f[2]);
  }
  const s = str_(v);
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return ymd_(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    // インドネシアの書き方（日/月/年）がふつう。2つめが13以上なら 月/日/年 と考える
    return Number(m[2]) > 12 ? ymd_(m[3], m[1], m[2]) : ymd_(m[3], m[2], m[1]);
  }
  if (/^\d{8}$/.test(s)) return ymd_(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8));
  return '';
}
function ymd_(y, mo, d) {
  y = Number(y); mo = Number(mo); d = Number(d);
  if (y < 1950 || y > 2030 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';   // 3005年のような入力ミスは使わない
  return String(y) + ('0' + mo).slice(-2) + ('0' + d).slice(-2);
}

// ---- 生徒キー（合鍵） ----
function issueStudentKey_(id, gen) {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const until = Date.now() + STUDENT_KEY_DAYS * 86400000;
  PropertiesService.getScriptProperties()
    .setProperty('sk_' + keyHash_(key), JSON.stringify({ id: id, gen: gen, until: until }));
  return { key: key, until: until };
}
// キーから生徒を確かめる。OKなら { student, until }、だめなら null
// （期限切れ・パスワードが変わって世代がちがう・名簿にいない、のどれかなら使えない）
function studentFromKey_(key) {
  if (!/^[0-9a-f]{64}$/.test(String(key || ''))) return null;
  const props = PropertiesService.getScriptProperties();
  const pk = 'sk_' + keyHash_(key);
  const raw = props.getProperty(pk);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (s.until < Date.now()) { props.deleteProperty(pk); return null; }
  const login = loginRow_(s.id);
  if ((login ? login.gen : 0) !== s.gen) { props.deleteProperty(pk); return null; }
  const st = getStudent_(s.id);
  return st.found ? { student: st.student, until: s.until } : null;
}
// 期限切れの生徒キーをそうじする（毎朝の syncForms で実行）
function cleanStudentKeys_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).filter(k => k.indexOf('sk_') === 0).forEach(k => {
    try { if (JSON.parse(all[k]).until < Date.now()) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

// 「生徒ログイン」シートを作る
function makeLoginSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ensure_(ss, STUDENT_SHEET, ['生徒ID', 'パスワードの印', 'ソルト', '変更日時', '世代', 'メモ']);
  sh.getRange('D2:D3000').setNumberFormat('yyyy/MM/dd HH:mm');
  sh.setColumnWidth(2, 200); sh.setColumnWidth(3, 120); sh.setColumnWidth(4, 130); sh.setColumnWidth(6, 260);
  sh.protect().setDescription('生徒のパスワード（印だけ）。忘れた生徒は B列・C列を消すと生年月日にもどる').setWarningOnly(true);
  return sh;
}

// 生徒のパスワードの準備：1回だけ実行。
// 「生徒ログイン」シートを作り、原本の生年月日が読めるか確かめて、読めない生徒を実行ログに出す
// （実行すると、原本を読むための許可を聞かれるので「許可」する）
function setupStudentLogin() {
  if (!SpreadsheetApp.getActive().getSheetByName(STUDENT_SHEET)) makeLoginSheet_();
  CacheService.getScriptCache().remove('births');
  const births = births_();
  const ids = values_(SHEET.roster).map(r => str_(r[0]).toUpperCase()).filter(id => ID_RE.test(id));
  const missing = ids.filter(id => !births[id]);
  console.log('生年月日で入れる生徒：' + (ids.length - missing.length) + '人 / 名簿 ' + ids.length + '人');
  console.log('生年月日が読めない生徒（原本の直しが必要）：' + (missing.length ? missing.join(', ') : 'なし'));
}

// 動作確認用：生徒IDを1つ入れて実行すると、そのIDでログインできるかが実行ログに出る（生年月日は出さない）
function testStudentLogin() {
  const id = 'JKT14001';
  console.log(id + '：生年月日 ' + (births_()[id] ? 'あり' : 'なし') + '／パスワード変更 ' + (loginRow_(id) && loginRow_(id).hash ? 'あり' : 'なし'));
}

// =====================================================================
// 意見・報告（ホームの「ご意見をお聞かせください」）
// 「報告・要望」シートに1行足す。状況（未対応／確認中／対応済み／見送り）は先生がシートで変える
// =====================================================================
const FEEDBACK_HEADERS = ['受付日時', '種類', '内容', 'いつも起きる？', '状況', '担当', 'メモ',
                          '名前', '生徒ID・メール', '区分', '端末', '画面サイズ', '送った画面', 'ブラウザ情報'];
const FEEDBACK_KINDS = { error: 'エラー・こまったこと', idea: 'こんな機能がほしい', other: 'その他' };
const FEEDBACK_FREQ = { always: 'いつも', sometimes: 'ときどき', once: '1回だけ' };

function saveFeedback_(p) {
  const kind = FEEDBACK_KINDS[str_(p.kind)];
  const text = str_(p.text).slice(0, FEEDBACK_MAX);
  if (!kind) return { ok: false, reason: 'kind' };
  if (text.length < 2) return { ok: false, reason: 'text' };

  // だれから？ 生徒は名簿で確かめて、名前は名簿のものを使う（ポータルから来た名前は使わない）
  const role = str_(p.role);
  let name = '', who = '', group = '';
  if (role === 'student') {
    const s = getStudent_(str_(p.id).toUpperCase());
    if (!s.found) return { ok: false, reason: 'id' };
    name = s.student.name; who = s.student.id; group = s.student.cohortKey;
  } else if (role === 'teacher') {
    name = str_(p.name).slice(0, 60); who = str_(p.email).slice(0, 100); group = '先生';
  } else {
    name = 'ゲスト'; group = 'ゲスト';
  }

  // 送りすぎよけ（1時間あたり）
  const cache = CacheService.getScriptCache();
  const key = 'fb_' + (who || 'guest');
  const count = Number(cache.get(key) || 0);
  if (count >= (who ? FEEDBACK_LIMIT : FEEDBACK_LIMIT * 3)) return { ok: false, reason: 'limit' };
  cache.put(key, String(count + 1), 3600);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = feedbackSheet_();
    const row = [new Date(), kind, text, FEEDBACK_FREQ[str_(p.freq)] || '', '未対応', '', '',
                 name, who, group, str_(p.device).slice(0, 30), str_(p.screen).slice(0, 20),
                 str_(p.view).slice(0, 30), str_(p.ua).slice(0, 300)];
    sh.getRange(lastRow_(sh) + 1, 1, 1, row.length).setValues([row.map(safeCell_)]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

// 「報告・要望」シート。なければ作る（見出し・状況のプルダウン・列の幅）
function feedbackSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(FEEDBACK_SHEET);
  if (sh) return sh;
  sh = ensure_(ss, FEEDBACK_SHEET, FEEDBACK_HEADERS);
  sh.getRange('A2:A2000').setNumberFormat('yyyy/MM/dd HH:mm');
  sh.getRange('E2:E2000').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['未対応', '確認中', '対応済み', '見送り'], true).build());
  sh.getRange('C2:C2000').setWrap(true);
  sh.setColumnWidth(1, 130); sh.setColumnWidth(2, 150); sh.setColumnWidth(3, 360);
  sh.setColumnWidth(5, 90); sh.setColumnWidth(14, 200);
  return sh;
}

// = + - @ で始まる文字は、シートで計算式にならないように ' をつける
function safeCell_(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}

// 動作確認用：「報告・要望」シートにテストの1行が入る（確かめたら行を消してOK）
function testFeedback() {
  console.log(JSON.stringify(saveFeedback_({ kind: 'other', text: 'テストです', role: 'guest', view: 'テスト' })));
}

// =====================================================================
// フォーム一覧の自動取り込み（毎日1回＋手動でも実行可）
// 「IJFA テストフォーム」フォルダの新しいフォームを教材リストに足す。
// 生徒ID欄が埋まった「事前入力URL」を作る。公開ONで追加し、グループ・表示順・インドネシア語名も自動で入れる
// =====================================================================
function syncForms() {
  try { syncMinna(); } catch (e) { console.error('みんなの日本語の取り込み: ' + e); }   // 課ごとのテストも毎日いっしょに確かめる
  try { cleanStudentKeys_(); } catch (e) { console.error('生徒キーのそうじ: ' + e); }    // 期限切れの生徒キーを消す
  const sh = sheet_(SHEET.mat);
  const known = new Set(values_(SHEET.mat).map(r => str_(r[0])));
  const files = listForms_(DriveApp.getFolderById(FORM_FOLDER_ID), []);
  const add = [];
  for (const f of files) {
    const fid = f.getId();
    if (known.has(fid)) continue;
    let url;
    try { url = prefillUrl_(FormApp.openById(fid)); }
    catch (e) { url = 'https://docs.google.com/forms/d/' + fid + '/viewform'; }
    const meta = formMeta_(f.getName());
    add.push([fid, 'nihongo', f.getName(), meta.nameId, 'form', url, true, meta.order, '自動追加', meta.group]);
  }
  if (add.length === 0) return;
  add.sort((a, b) => a[2].localeCompare(b[2], 'ja'));
  sh.getRange(lastRow_(sh) + 1, 1, add.length, add[0].length).setValues(add);
}

// =====================================================================
// みんなの日本語テストを「課ごと」に教材リストへ足す（先生が課ごとに指定できるように）
// ポータルの minna-course.json を見て、できている課・まとめテストのうち、まだない行だけ足す。
// カテゴリー「みんなの日本語」に、公開OFFで足す（生徒の一覧には今までどおり「みんなの日本語 テスト」1つだけが出る。指定したときだけホームに出る）
// 手で実行してもよい（何回実行しても同じ行は増えない）
// =====================================================================
function syncMinna() {
  const res = UrlFetchApp.fetch(PORTAL_URL + 'minna-course.json?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('minna-course.json が読めません（' + res.getResponseCode() + '）');
  const course = JSON.parse(res.getContentText());
  const sh = sheet_(SHEET.mat);
  const rows = values_(SHEET.mat);
  // カテゴリー「みんなの日本語」（ID minna）に入れる。なければ nihongo
  const cat = values_(SHEET.cat).some(r => str_(r[0]) === 'minna') ? 'minna' : 'nihongo';
  // 先生の画面で開く箱：N5段階（1〜25課）／N4段階（26〜50課）
  const groupOf = lastNo => lastNo <= 25 ? 'N5段階（1〜25課） / Tahap N5' : 'N4段階（26〜50課） / Tahap N4';

  // すでにある自動の行は、カテゴリーと箱だけそろえる（前の版で「いろどり」に入った行を直す）
  const want = {};
  (course.lessons || []).forEach(l => { want['minna-L' + ('0' + l.no).slice(-2)] = groupOf(l.no); });
  (course.matome || []).forEach(m => { want['minna-' + m.id] = groupOf((m.range || [0, 0])[1]); });
  let fixed = 0;
  rows.forEach((r, i) => {
    const g = want[str_(r[0])];
    if (!g) return;
    if (str_(r[1]) !== cat) { sh.getRange(i + 2, 2).setValue(cat); fixed++; }
    if (str_(r[9]) !== g) sh.getRange(i + 2, 10).setValue(g);
  });

  const known = new Set(rows.map(r => str_(r[0])));
  const add = [];
  (course.lessons || []).filter(l => l.ready).forEach(l => {
    const id = 'minna-L' + ('0' + l.no).slice(-2);
    if (known.has(id)) return;
    add.push([id, cat, 'みんなの日本語 ' + l.no + '課 テスト', 'Tes Minna no Nihongo Bab ' + l.no, 'site',
              'minna.html?id={ID}&L=' + l.no, false, l.no * 10, '自動追加（みんなの日本語）', groupOf(l.no)]);
  });
  (course.matome || []).filter(m => m.ready).forEach(m => {
    const id = 'minna-' + m.id;
    if (known.has(id)) return;
    const r = m.range || [0, 0];
    add.push([id, cat, 'みんなの日本語 ' + m.title + '（まとめテスト）', 'Tes Rangkuman Minna no Nihongo Bab ' + r[0] + '-' + r[1], 'site',
              'minna.html?id={ID}&M=' + m.id, false, r[1] * 10 + 5, '自動追加（みんなの日本語）', groupOf(r[1])]);
  });
  if (add.length) {
    add.sort((a, b) => a[7] - b[7]);
    sh.getRange(lastRow_(sh) + 1, 1, add.length, add[0].length).setValues(add);
  }
  console.log('みんなの日本語：' + add.length + '行を足しました／カテゴリーを直した行 ' + fixed);
}

// フォルダの中（入門・初級1などのサブフォルダも含む）のフォームを全部集める
function listForms_(folder, out) {
  const it = folder.getFilesByType(MimeType.GOOGLE_FORMS);
  while (it.hasNext()) out.push(it.next());
  const subs = folder.getFolders();
  while (subs.hasNext()) listForms_(subs.next(), out);
  return out;
}

// フォーム名からグループ・表示順・インドネシア語名を決める
//   入門5課 テスト → 表示頠50 / 入門1-6課 テスト → 65（6課のあと）/ 入門1-6課 言葉テスト → 66
function formMeta_(title) {
  const g = title.match(/^(入門|初級1)/);
  const groups = { '入門': 'いろどり入門 / Irodori Pemula', '初級1': 'いろどり初級1 / Irodori Dasar 1' };
  const group = g ? groups[g[1]] : '';
  let m = title.match(/(\d+)-(\d+)課/);
  if (m) {
    const word = /言葉|ことば/.test(title);
    return { group, order: Number(m[2]) * 10 + (word ? 6 : 5),
             nameId: (word ? 'Tes Kosakata Bab ' : 'Tes Rangkuman Bab ') + m[1] + '-' + m[2] };
  }
  m = title.match(/(\d+)課/);
  if (m) return { group, order: Number(m[1]) * 10, nameId: 'Tes Bab ' + m[1] };
  if (title.indexOf('教室のことば') >= 0) return { group, order: 1, nameId: 'Tes Bahasa Kelas' };
  return { group, order: 999, nameId: '' };
}

// 生徒ID欄を {ID} にした事前入力URL。ポータルが生徒IDに置きかえる
function prefillUrl_(form) {
  const PH = 'ZZZ99999';
  const item = form.getItems(FormApp.ItemType.TEXT).find(i => /ID/i.test(i.getTitle()));
  if (!item) return form.getPublishedUrl();
  const url = form.createResponse().withItemResponse(item.asTextItem().createResponse(PH)).toPrefilledUrl();
  return url.replace(PH, '{ID}');
}

// =====================================================================
// 最初に1回だけ実行
// =====================================================================
function setup() {
  const ss = SpreadsheetApp.getActive();
  const cb = SpreadsheetApp.newDataValidation().requireCheckbox().build();

  // 名簿：原本から 生徒ID・名前・出身TC・期生 の4列だけを自動で写す
  const roster = ensure_(ss, SHEET.roster, ['生徒ID', '名前', '出身TC', '期生']);
  roster.getRange('A2').setFormula(
    '=IFERROR(QUERY(IMPORTRANGE("' + DB_ID + '","' + DB_RANGE.replace(/"/g, '""') +
    '"),"select Col4, Col2, Col6, Col7 where Col4 is not null",0),"")');
  roster.protect().setDescription('原本から自動表示。直接編集しない').setWarningOnly(true);

  // カテゴリー
  const cat = ensure_(ss, SHEET.cat, ['カテゴリーID', '名前（日本語）', '名前（インドネシア語）', '表示順']);
  if (lastRow_(cat) < 2) {
    cat.getRange(2, 1, 5, 4).setValues([
      ['nihongo', '日本語を学ぶ', 'Belajar Bahasa Jepang', 1],
      ['shigoto', '仕事と生活', 'Kerja & Kehidupan', 2],
      ['kaiwa', '会話・面接', 'Percakapan & Wawancara', 3],
      ['math', '数学・IQ', 'Matematika & Tes IQ', 4],
      ['challenge', '記録に挑戦！', 'Tantangan Rekor', 5]
    ]);
  }
  cat.protect().setDescription('変更は坂井まで').setWarningOnly(true);

  // 教材リスト
  const mat = ensure_(ss, SHEET.mat,
    ['教材ID', 'カテゴリーID', '名前（日本語）', '名前（インドネシア語）', '種類', 'URL', '公開', '表示順', 'メモ', 'グループ']);
  if (lastRow_(mat) < 2) {
    mat.getRange(2, 1, 4, 9).setValues([
      ['moji', 'nihongo', 'もじ練習（ひらがな・カタカナ）', 'Latihan menulis huruf', 'site', 'https://ijfa-tc.github.io/hiragana/', true, 1, ''],
      ['jft', 'nihongo', 'JFT-Basic 練習', 'Latihan JFT-Basic', 'site', 'https://jft-ijfa-cbt.netlify.app/', true, 2, ''],
      ['ssw-kensetsu', 'shigoto', '特定技能 建設 練習', 'Latihan SSW Konstruksi', 'site', 'https://ijfa-ssw-kensetsu.netlify.app/', true, 1, ''],
      ['math-iq', 'math', '数学・IQ練習', 'Latihan Matematika & Tes IQ', 'site', 'https://ijfa-tc.github.io/math-iq/?id={ID}', true, 1, '']
    ]);
  }
  mat.getRange('G2:G1000').setDataValidation(cb);
  mat.getRange('B2:B1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(cat.getRange('A2:A50'), true).build());
  mat.getRange('E2:E1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['form', 'site'], true).build());

  // 指定テスト（先生が触るのはここだけ）
  const asg = ensure_(ss, SHEET.asg, ['期生（例 JKT16）', '教材（名前）', '指定', '表示順', 'メモ']);
  asg.getRange('B2:B1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(mat.getRange('C2:C1000'), true).build());
  asg.getRange('C2:C1000').setDataValidation(cb);
  if (lastRow_(asg) < 2) asg.getRange(2, 1, 1, 5).setValues([['JKT14', 'JFT-Basic 練習', true, 1, '例：14期は練習用']]);

  // 初回のフォーム取り込みと、毎日の自動更新
  syncForms();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncForms')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncForms').timeBased().everyDays(1).atHour(6).create();

  const extra = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (extra && ss.getSheets().length > 1 && lastRow_(extra) === 0) ss.deleteSheet(extra);
}

// 先生用ログインの準備：1回だけ実行。「先生」シートを作り、坂井を最初の1人として入れる。
// （実行すると「外部サービスへの接続」の許可を聞かれるので「許可」する）
function setupTeachers() {
  const ss = SpreadsheetApp.getActive();
  const sh = ensure_(ss, TEACHER_SHEET, ['メールアドレス', '名前', '有効', 'メモ']);
  sh.getRange('C2:C200').setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  if (lastRow_(sh) < 2) sh.getRange(2, 1, 1, 4).setValues([[Session.getEffectiveUser().getEmail(), '坂井', true, '管理者']]);
  sh.protect().setDescription('先生の許可リスト。変更は坂井まで').setWarningOnly(true);
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', { muteHttpExceptions: true });   // 許可をもらうための空の問い合わせ
  console.log('先生シートOK。期生：' + JSON.stringify(cohorts_()));
}

// 動作確認用：実行ログに結果が出る
function testApi() {
  console.log(JSON.stringify(getStudent_('JKT14001')));
  console.log(JSON.stringify(getPortal_('JKT14')).slice(0, 1000));
}

// =====================================================================
// 小さな道具
// =====================================================================
function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('シートがありません: ' + name);
  return sh;
}
function values_(name) {
  const sh = sheet_(name);
  const last = lastRow_(sh);
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
}
// A列で最後にデータがある行（チェックボックスだけの行は数えない）
function lastRow_(sh) {
  const n = sh.getMaxRows();
  const col = sh.getRange(1, 1, n, 1).getValues();
  for (let i = n - 1; i >= 0; i--) if (str_(col[i][0])) return i + 1;
  return 0;
}
function ensure_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function num_(v) { const n = Number(v); return v === '' || isNaN(n) ? 999 : n; }
function byOrder_(a, b) { return a.order - b.order; }

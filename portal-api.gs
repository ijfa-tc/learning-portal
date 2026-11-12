/**
 * IJFA Learning Portal「ポータルAPI」
 * ポータル（https://ijfa-tc.github.io/learning-portal/）からの問い合わせに答える窓口。
 *
 * ※ このファイルは控え（バックアップ）。実際に動いているのは「IJFA ポータル設定」スプレッドシートの Apps Script。
 *   直したら、両方を同じ内容にそろえること。
 *
 * できること
 *   ?action=student&id=JKT14001  → 名前と期生だけを返す（成績や生年月日は返さない）
 *   ?action=portal&cohort=JKT14  → カテゴリー・公開中の教材・その期生への指定テストを返す
 *   POST（Googleから）credential  → 先生か確かめ、ポータルへもどるボタンの画面を出す（合言葉 t つき）
 *   ?action=tsession&t=合言葉     → 先生の名前と期生の一覧を返す（合言葉は5分・1回だけ有効）
 *
 * 最初に1回だけ：setup を実行（シートの準備・フォーム一覧の取り込み・毎日の自動更新を設定）
 * 先生用ログインの準備：setupTeachers を1回実行（「先生」シートを作る＋外部への問い合わせを許可）
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

// =====================================================================
// ポータルからの問い合わせ
// =====================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    if (p.action === 'student') out = getStudent_(String(p.id || '').trim().toUpperCase());
    else if (p.action === 'portal') out = getPortal_(String(p.cohort || '').trim().toUpperCase());
    else if (p.action === 'tsession') out = teacherSession_(String(p.t || ''));
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
  const rows = values_(TEACHER_SHEET).filter(r => r[2] === true);
  const person = rows.find(r => str_(r[0]).toLowerCase() === g.email);
  const domain = person ? null : rows.find(r => {
    const a = str_(r[0]).toLowerCase();
    return a.charAt(0) === '@' && g.hd && a === '@' + g.hd;
  });
  if (!person && !domain) {
    console.log('先生として未登録: ' + g.email);   // 実行ログで確認できる（シートに足すときの参考）
    return { ok: false, reason: 'not_allowed' };
  }
  const name = person ? (str_(person[1]) || g.name || g.email) : (g.name || g.email);
  return { ok: true, teacher: { name: name, email: g.email }, cohorts: cohorts_() };
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
  const assigned = guest ? [] : values_(SHEET.asg)
    .filter(r => str_(r[0]).toUpperCase() === cohortKey && r[2] === true)
    .map(r => ({ m: byName[str_(r[1])], order: num_(r[3]) }))
    .filter(x => x.m)
    .sort(byOrder_)
    .map(x => x.m);

  const out = { categories, materials, assigned };
  cache.put('portal_' + cohortKey, JSON.stringify(out), CACHE_SEC);
  return out;
}

// =====================================================================
// フォーム一覧の自動取り込み（毎日1回＋手動でも実行可）
// 「IJFA テストフォーム」フォルダの新しいフォームを教材リストに足す。
// 生徒ID欄が埋まった「事前入力URL」を作る。公開ONで追加し、グループ・表示順・インドネシア語名も自動で入れる
// =====================================================================
function syncForms() {
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

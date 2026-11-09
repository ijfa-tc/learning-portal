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
 *
 * 最初に1回だけ：setup を実行（シートの準備・フォーム一覧の取り込み・毎日の自動更新を設定）
 * コードを直したら：「デプロイ」→「デプロイを管理」→ 鉛筆 →「新バージョン」で公開し直す
 */

// ---- 設定（ふつうは変えない） ----
const FORM_FOLDER_ID = '1Hv6XlESEV3Ns5Q6wVDaR_3ZGm9_tNf8B';           // 「IJFA テストフォーム」フォルダ
const DB_ID = '12DTewBMLeAMChvtLLqSyjZVD7sm5-diTrq_3EAWWjVI';          // DATA BASE SISWA IJFA - UPDATE（原本）
const DB_RANGE = "'DATABASE SISWA・生徒データベース'!A5:G";            // 原本の範囲（B名前・D生徒ID・F出身TC・G期生）
const ID_RE = /^[A-Z]{3}[0-9]{5}$/;                                    // 生徒IDの形（例 JKT16001）
const SHEET = { roster: '名簿', cat: 'カテゴリー', mat: '教材リスト', asg: '指定テスト' };
const CACHE_SEC = 60;                                                  // 設定の変更がポータルに出るまで最大60秒

// =====================================================================
// ポータルからの問い合わせ
// =====================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    if (p.action === 'student') out = getStudent_(String(p.id || '').trim().toUpperCase());
    else if (p.action === 'portal') out = getPortal_(String(p.cohort || '').trim().toUpperCase());
    else out = { error: 'unknown action' };
  } catch (err) {
    console.error(err);
    out = { error: 'server error' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
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
  if (!/^[A-Z]{3}[0-9]{2}$/.test(cohortKey)) return { error: 'bad cohort' };
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
      type: str_(r[4]), url: str_(r[5]), public: r[6] === true, order: num_(r[7])
    }));
  const materials = all.filter(m => m.public).sort(byOrder_);

  // 指定テストは「教材の名前」で選ぶ（先生がプルダウンで選びやすいように）。公開OFFでも指定はできる
  const byName = {};
  all.forEach(m => { byName[m.nameJa] = m; });
  const assigned = values_(SHEET.asg)
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
// 生徒ID欄が埋まった「事前入力URL」を作る。公開はOFFで追加（指定すれば表示される）
// =====================================================================
function syncForms() {
  const sh = sheet_(SHEET.mat);
  const known = new Set(values_(SHEET.mat).map(r => str_(r[0])));
  const files = DriveApp.getFolderById(FORM_FOLDER_ID).getFilesByType(MimeType.GOOGLE_FORMS);
  const add = [];
  while (files.hasNext()) {
    const f = files.next();
    const fid = f.getId();
    if (known.has(fid)) continue;
    let url;
    try { url = prefillUrl_(FormApp.openById(fid)); }
    catch (e) { url = 'https://docs.google.com/forms/d/' + fid + '/viewform'; }
    add.push([fid, 'nihongo', f.getName(), '', 'form', url, false, 999, '自動追加']);
  }
  if (add.length === 0) return;
  add.sort((a, b) => a[2].localeCompare(b[2], 'ja'));
  sh.getRange(lastRow_(sh) + 1, 1, add.length, add[0].length).setValues(add);
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
    ['教材ID', 'カテゴリーID', '名前（日本語）', '名前（インドネシア語）', '種類', 'URL', '公開', '表示順', 'メモ']);
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

// データの読み込み担当。画面（app.js）はここの関数だけを使う。
// サンプル（sample.json）と本番（GAS）の切り替えはここで吸収する。
window.PortalData = (function () {
  const API_URL = (window.PORTAL_CONFIG || {}).API_URL || "";
  const useSample = API_URL === "";
  let sampleCache = null;

  async function loadSample() {
    if (!sampleCache) {
      const res = await fetch("sample.json", { cache: "no-store" });
      sampleCache = await res.json();
    }
    return sampleCache;
  }

  async function callApi(params) {
    const url = API_URL + "?" + new URLSearchParams(params).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error("API error " + res.status);
    return res.json();
  }

  // 生徒IDから { id, name, cohort, cohortKey } を返す。見つからなければ null。
  async function getStudent(id) {
    if (useSample) {
      const data = await loadSample();
      return data.students.find(s => s.id === id) || null;
    }
    const r = await callApi({ action: "student", id: id });
    return r.found ? r.student : null;
  }

  // 期生（例 JKT14）用のホーム表示データ { categories, materials, assigned } を返す。
  async function getPortal(cohortKey) {
    if (useSample) {
      const data = await loadSample();
      const guest = cohortKey === "GUEST";
      const materials = data.materials
        .filter(m => m.public && !(guest && m.type === "form"))   // ゲストにはフォームのテストを出さない
        .sort((a, b) => a.order - b.order);
      const assigned = data.assignments
        .filter(a => a.cohort === cohortKey && a.on)
        .sort((a, b) => a.order - b.order)
        .map(a => materials.find(m => m.id === a.materialId))
        .filter(Boolean);
      const categories = data.categories.slice().sort((a, b) => a.order - b.order);
      return { categories, materials, assigned };
    }
    return callApi({ action: "portal", cohort: cohortKey });
  }

  // 先生用ログイン：Googleから戻ってきたときの合言葉（t）をGASに見せて、先生の情報を受け取る（1回だけ使える）
  // 返り値 { ok, teacher: { name, email }, cohorts: ["JKT16", ...] } / { ok: false, reason }
  async function teacherSession(t) {
    if (useSample) return { ok: false, reason: "sample" };
    return callApi({ action: "tsession", t: t });
  }

  // 期生の一覧 { cohorts: ["JKT16", ...] }（先生のホームの選択肢用。個人情報は入っていない）
  async function getCohorts() {
    if (useSample) return { cohorts: [] };
    return callApi({ action: "cohorts" });
  }

  // GASへPOSTで送る（先生キーなど、URLに出したくないものはこちら）
  async function post(params) {
    const res = await fetch(API_URL, { method: "POST", body: new URLSearchParams(params) });
    if (!res.ok) throw new Error("API error " + res.status);
    return res.json();
  }

  // ホームの意見フォーム：GASの「報告・要望」シートへ送る。返り値 { ok } / { ok: false, reason }
  async function sendFeedback(params) {
    if (useSample) return { ok: true, sample: true };
    return post(Object.assign({ action: "feedback" }, params));
  }

  // 先生の「指定テストを選ぶ」画面：いまの指定と教材の一覧
  // 返り値 { ok, cohort, categories, materials, assigned: ["教材名", ...], ver } / { ok: false, reason }
  async function getAssign(key, cohortKey) {
    if (useSample) return { ok: false, reason: "sample" };
    return post({ action: "tassign", k: key, cohort: cohortKey });
  }
  // 指定テストを保存（names は上から順の教材名）。返り値 { ok, ver } / { ok: false, reason }
  async function saveAssign(key, cohortKey, names, ver) {
    if (useSample) return { ok: false, reason: "sample" };
    return post({ action: "tsave", k: key, cohort: cohortKey, names: JSON.stringify(names), ver: ver });
  }
  // 先生のログアウト：先生キーを使えなくする
  async function teacherLogout(key) {
    if (useSample || !key) return { ok: true };
    return post({ action: "tlogout", k: key });
  }

  return { getStudent, getPortal, teacherSession, getCohorts, sendFeedback, getAssign, saveAssign, teacherLogout, useSample };
})();

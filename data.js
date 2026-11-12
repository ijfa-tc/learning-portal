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

  // 先生用ログイン：Googleでログインした証明（credential）をGASに送り、許可リストにあるか確かめてもらう。
  // 返り値 { ok, teacher: { name, email }, cohorts: ["JKT16", ...] } / { ok: false, reason }
  // ※ text/plain で送るのは、GASがブラウザからのPOSTを受け取れるようにするため
  async function teacherLogin(credential) {
    if (useSample) return { ok: false, reason: "sample" };
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "teacher", credential: credential })
    });
    if (!res.ok) throw new Error("API error " + res.status);
    return res.json();
  }

  return { getStudent, getPortal, teacherLogin, useSample };
})();

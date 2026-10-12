// 模型拒答（stop_reason: "refusal"）的處理（批次 134）。
//
// 新一代模型（Sonnet 5.5、Haiku 5.5…）有安全分類器，判定「可能造成傷害」的請求會被攔下：
// HTTP 照樣是 200，但 stop_reason 是 "refusal"，stop_details.category 是 cyber／bio／
// frontier_llm／reasoning_extraction／general_harms，或是 null。content 可能是空陣列（輸出前
// 就攔下），串流中途攔下則只有一半。工研院的生醫、資安題材正是分類器可能誤判的領域。
//
// 批次 134 之前，repo 對這件事零處理：content 是空的，各處的出口就退成「抱歉，無法取得回應。」，
// 記者看到的像是「米亞答不出來」，伺服器 log 完全乾淨——跟 CLAUDE.md 第 4 條說的是同一個形狀
// （「送出成功」不等於「使用者看得到」）。更糟的是只有一半的內容：路由、職員判斷都會拿一半的 JSON
// 去解析，萬一剛好是完整的一個物件，被攔下的回應就會被當成正常的判斷結果執行。
//
// 這支只放「純邏輯＋一個 fetch 包裝」，不碰任何呼叫端：
//   - 判斷與記錄：isRefusal()／refusalCategory()／logRefusal()
//   - 給使用者的固定句：refusalReply()——不經模型，所以不會再被攔一次，也不會講錯話
//   - 伺服器端備援：FALLBACK_BETA／withRefusalFallbacks()／postAnthropic()（只給 Sonnet 5.5 這類支援的模型）
//   - 網頁問答 Haiku 被攔下時改用 Sonnet 重答：buildSonnetRetryBody()
//
// ⚠️ 官方文件的原話：看 stop_reason、不要靠 stop_details（stop_details 可能是 null，category 也可能是
// 日後新增的值）。所以這裡一律只用 stop_reason 判斷，category 只拿來寫 log。

const API_URL = 'https://api.anthropic.com/v1/messages';

export function isRefusal(data) {
  return data?.stop_reason === 'refusal';
}

// stop_details 可能是 null、也可能整個沒有（舊版回應）；category 本身也可以是 null。全部都當「不知道」。
export function refusalCategory(data) {
  const c = data?.stop_details?.category;
  return typeof c === 'string' && c ? c : null;
}

// log 只記「在哪一條路、哪個模型、什麼分類、哪一場」，**不記任何內容**——提問可能是記者的原話、
// 回應可能是未發布的新聞稿片段（跟 lib/zh-tw.js 的 [zh-tw-leak] 只記字不記全文同一個道理）。
// 在 Vercel Logs 搜「[ai-refusal]」就能看出哪一條路、哪一類題目常被攔。
const oneLine = (v, max = 60) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function logRefusal(where, model, data, { eventId } = {}) {
  console.warn(`[ai-refusal] where=${oneLine(where) || '-'} model=${oneLine(model) || '-'} category=${oneLine(refusalCategory(data)) || 'null'} event=${oneLine(eventId) || '-'}`);
}

// 給使用者的固定句。不經模型：模型剛剛才拒絕了這題，再問一次多半還是拒絕，而且這句話
// 要保證是台灣繁體、沒有 Markdown、沒有「我不能幫你做 XXX」這種可能被截圖的措辭。
// contact：活動的新聞聯絡人（events!O，最多 100 字）；沒有就只講「洽新聞聯絡人」。
//
// 聯絡人字串的整理：多行的用「、」接起來（LINE 一句話裡不要換行）、拿掉結尾的句點／頓號
// （後面我們自己會補「。」，不然變成「。。」）、拿掉會被當成 Markdown 的 * ` ~。
function tidyContact(contact) {
  const parts = String(contact ?? '')
    .split(/[\r\n]+/)
    .map(s => s.replace(/[*`~]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return parts.join('、').replace(/[。.、，,；;\s]+$/, '').slice(0, 120);
}

const ZH_LEAD = '這一題我這邊沒辦法回答';
const EN_LEAD = "I'm unable to answer this one.";

export function refusalReply({ contact = '', english = false } = {}) {
  const who = tidyContact(contact);
  if (english) {
    return who
      ? `${EN_LEAD} Please contact the press contact directly: ${who}.`
      : `${EN_LEAD} Please contact the press contact directly.`;
  }
  return who
    ? `${ZH_LEAD}，建議直接洽新聞聯絡人：${who}。`
    : `${ZH_LEAD}，建議洽新聞聯絡人。`;
}

// 認得「這是 refusalReply() 產生的那句」。為什麼需要：LINE 有幾條次要路線（官網新聞補查、兜底引導…）
// 是靠辨認 askAnthropic() 失敗時的那幾句話（「抱歉，目前無法取得回應」）來決定「這次沒答成，退回只附連結」。
// 拒答的固定句如果從 askAnthropic() 流出去，那些守門認不得它，就會把「這一題我這邊沒辦法回答」當成答案接在
// 「我在工研院官網新聞中心找到了：」後面——前後文自相矛盾，跟 lib/line-nodata.js 註解裡講的是同一種事故。
// 那些守門在原本的判斷旁邊加一個 isRefusalReply(reply) 就接得住。
export function isRefusalReply(text) {
  const t = String(text ?? '').trim();
  return t.startsWith(ZH_LEAD) || t.startsWith(EN_LEAD);
}

// ── 伺服器端備援（server-side fallback）─────────────────────────────────────
// 官方文件（claude-api 的 model-migration.md，Migrating to Claude Opus 5 的 New API features 與
// Migrating to Claude Sonnet 5.5 的 Safeguards and fallback）：
//   POST /v1/messages
//   anthropic-beta: server-side-fallback-2026-07-01
//   { "model": "...", "fallbacks": "default", ... }
// "default" 由 Anthropic 依「被拒的分類」挑替代模型，不用自己指定、也不用等舊模型下架才來改。
//
// 限制（都是官方文件寫的，不是我們猜的）：
//   - Sonnet 5.5 只認 "default" 這種寫法（陣列寫法是另一個 beta 標頭，兩個混用會 400），只在 Claude API 上。
//   - 只會替 "cyber"、"frontier_llm" 兩類重試；"bio"、"reasoning_extraction"、"general_harms" 不會——
//     所以生醫題材被誤判時，備援救不了，一樣會拿到 refusal，呼叫端的拒答處理不能省。
//   - Haiku 5.5 沒有伺服器端備援：帶 "default" 只是被拒的照樣被拒，帶陣列會 400。所以 postAnthropic()
//     碰到 Haiku 一律不帶，不靠呼叫端記得。
//   - 備援真的發生時，回應的 model 是實際回答的那個模型，content 裡可能多一塊 type:"fallback"
//     （標記切換點），呼叫端挑 type:"text" 的區塊就不受影響。
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function supportsServerFallback(model) {
  return !/haiku/i.test(String(model || ''));
}

const findKey = (obj, name) => Object.keys(obj || {}).find(k => k.toLowerCase() === name);

// 純函式：回傳新的 { headers, body }，不改傳進來的東西。
// anthropic-beta 已經有別的值（呼叫端自己開了別的 beta）就用逗號接在後面，不覆蓋。
export function withRefusalFallbacks({ headers = {}, body = {} } = {}) {
  const out = { ...headers };
  const key = findKey(out, 'anthropic-beta');
  const betas = key ? String(out[key]).split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!betas.includes(FALLBACK_BETA)) betas.push(FALLBACK_BETA);
  if (key) delete out[key];
  out['anthropic-beta'] = betas.join(',');
  return { headers: out, body: { ...body, fallbacks: 'default' } };
}

// 行程內的停用旗標。Vercel 的 serverless 執行個體各自一份：參數寫錯時，每個冷啟動的執行個體
// 第一次會多吃一次 400＋重送（400 是請求格式被退回，不會跑模型，很快），之後就不再帶。要連這一次都省，直接設環境變數
// AI_REFUSAL_FALLBACKS=off。
let selfDisabled = false;

export function fallbacksEnabled() {
  if (selfDisabled) return false;
  return !/^(off|0|false)$/i.test(String(process.env.AI_REFUSAL_FALLBACKS || '').trim());
}

// 測試用：把行程內的停用旗標歸零。
export function resetRefusalFallbacks() { selfDisabled = false; }

// 400 的訊息提到備援、beta 標頭，或「不支援／不認得的參數」這一類——都當成「是我們多帶的備援參數惹的」。
// 故意寬鬆：寧可多重送一次（400 不會跑模型），也不要因為訊息措辭跟猜的不一樣就讓整個問答壞掉。
// 寬鬆的代價由 postAnthropic() 的「重送後還是 400 就把旗標恢復」接住，不會因此永久關掉備援。
const FALLBACK_REJECTED_RE = /fallback|server-side|anthropic-beta|\bbeta\b|extra inputs? (are|is) not permitted|unknown (field|parameter|param|argument|request)|unrecogni[sz]ed|unexpected (field|parameter|keyword|value)|unsupported|not supported|not permitted|不支援|未知|不認得/i;

// 讀 400 的錯誤訊息，但不能把回應讀走——不是我們的問題時，要原封不動還給呼叫端，
// 它照舊 response.json() 取自己的錯誤訊息、照舊 reportAiFailure()。
// 真的 Response 用 clone()。沒有 clone() 的（測試用的假回應 {ok,status,json}）讀完補一個讀得到同樣內容的。
async function peekErrorMessage(res) {
  try {
    if (typeof res.clone === 'function') {
      const j = await res.clone().json();
      return { message: String(j?.error?.message || ''), res };
    }
    const j = await res.json();
    return {
      message: String(j?.error?.message || ''),
      res: { ok: res.ok, status: res.status, headers: res.headers, json: async () => j, text: async () => JSON.stringify(j) }
    };
  } catch {
    return { message: '', res };
  }
}

// 取代各處直接的 fetch('https://api.anthropic.com/v1/messages', …)。
//   apiKey    必填
//   body      請求內容（物件；給 JSON 字串也可以）
//   signal    AbortSignal，原樣傳給 fetch（重送也用同一個，死線不會被重送拉長）
//   fallbacks true 才會帶伺服器端備援；沒開（預設）就是一個純粹的 fetch，body 與 headers 一個字都不多
//   headers   額外的標頭（例如呼叫端自己的 anthropic-beta；跟預設同名的以這裡為準）
// 回傳的是 fetch 的 Response，呼叫端照舊 response.ok／response.status／response.json()。
//
// ⚠️ 自癒（為什麼要有）：這個環境沒有 ANTHROPIC_API_KEY，beta 請求的形狀沒辦法對真的 API 驗證過。
// 參數萬一寫錯，沒有保險的話 LINE 問答會整個變成 400——為了一個「錦上添花」的備援把主流程弄壞，
// 不划算。所以：帶著備援送出去、拿到 400、而且訊息提到備援／beta／不支援的參數 → 記一次 log、
// 旗標設成停用、立刻不帶備援重送一次；之後的呼叫都不再帶。
// 例外（旗標會恢復）：重送仍然是 400，代表問題不在備援（訊息措辭只是剛好撞上關鍵字）——不為別人的錯永久關掉備援。
// 其餘狀況（非 400、400 但跟備援無關）原封不動還給呼叫端，不重送。
export async function postAnthropic({ apiKey, body, signal, fallbacks = false, headers = {} } = {}) {
  const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
  const base = {
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...headers },
    body: payload
  };
  const send = (req) => fetch(API_URL, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    ...(signal ? { signal } : {})
  });

  const useFallbacks = !!fallbacks && fallbacksEnabled() && supportsServerFallback(payload.model);
  if (!useFallbacks) return send(base);

  const res = await send(withRefusalFallbacks(base));
  if (res.status !== 400) return res;

  const { message, res: replayable } = await peekErrorMessage(res);
  if (!FALLBACK_REJECTED_RE.test(message)) return replayable;

  console.warn(`[ai-refusal] 伺服器端備援被 API 以 400 退回，改不帶 fallbacks 重送；本行程之後不再帶（要一開始就關掉請設 AI_REFUSAL_FALLBACKS=off）。API 訊息：${oneLine(message, 200)}`);
  selfDisabled = true;
  let retry;
  try {
    retry = await send(base); // base 從頭到尾沒被改過：沒有 fallbacks、沒有我們加的 beta，呼叫端自己的別的 beta 還在
  } catch (e) {
    selfDisabled = false; // 重送沒有結果，沒辦法證明是備援的問題——下一次再試
    throw e;
  }
  if (retry.status === 400) {
    // 不帶備援一樣 400：問題在別的地方，不是備援。旗標恢復，不要為了別人的錯永久關掉備援。
    selfDisabled = false;
    console.warn('[ai-refusal] 不帶 fallbacks 重送仍然是 400，問題不在備援，備援維持開啟');
  }
  return retry;
}

// ── 網頁問答：Haiku 被攔下時，改用 Sonnet 5.5 重答 ──────────────────────────
// 純函式。Haiku 5.5 的請求內容不能原樣丟給 Sonnet 5.5，會 400 的地方（官方文件）：
//   - thinking：Haiku 用 {type:'disabled'} 關思考，Sonnet 5.5 不收 disabled，最低的是 {type:'between_tools'}，
//     而且 between_tools 裡面不能有別的欄位（display、budget_tokens 都會 400）
//   - temperature／top_p／top_k：非預設值一律 400，整個拿掉
//   - fallbacks：Haiku 那邊本來就不該有；Sonnet 重答要不要備援，由呼叫端用 postAnthropic({ fallbacks: true }) 另外決定，
//     不從原請求繼承
// stream 設成 false：重答是在 Haiku「輸出前就被攔下」之後才發生的，這時串流還沒開始往使用者送字，
// 用非串流一次拿完整答案最單純（串流中途才被攔的不在這裡處理：字已經送出去了，收不回來）。
// system、messages、max_tokens 等其餘欄位原樣保留。
export const SONNET_RETRY_MODEL = 'claude-sonnet-5-5';

export function buildSonnetRetryBody(originalBody) {
  const body = { ...(originalBody || {}) };
  for (const k of ['temperature', 'top_p', 'top_k', 'budget_tokens', 'fallbacks']) delete body[k];
  body.model = SONNET_RETRY_MODEL;
  body.thinking = { type: 'between_tools' };
  body.stream = false;
  return body;
}

// Patreon API v2 → docs/patrons.json 生成（NEXT Round 支援者名簿の自動同期・2026-08-31）
//
// 実行: PATREON_ACCESS_TOKEN=... node sync_patreon.mjs
//   - Node 20+（fetch 内蔵・依存パッケージなし）
//   - active_patron のみ採用（退会・失効は自動で名簿から消える）
//   - ティアは金額で判定（$10+ = ultra / $5+ = super / $3+ = supporter）
//     → Patreon 側でティア名を変えても壊れない
//   - mapping.json（member id → VRChat 表示名）に無い加入者は
//     「未紐付け」としてログに出す（名簿には載せない）
//   - 名簿の中身が前回と同じなら patrons.json を書き換えない（無駄コミットを作らない）
//
// ⚠ mapping.json のキーは Patreon の member id を使うこと（public リポジトリに
//   メールアドレスを書かない）。member id は本スクリプトの「未紐付け」ログに出る。

import fs from "node:fs";

const TOKEN = process.env.PATREON_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("PATREON_ACCESS_TOKEN が未設定です（リポジトリの Actions secret に登録）");
  process.exit(1);
}

const API = "https://www.patreon.com/api/oauth2/v2";
const OUT = "docs/patrons.json";

async function api(path) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    console.error(`Patreon API ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

// ---- 1. 自分のキャンペーン id ----
const campaigns = await api("/campaigns");
if (!campaigns.data?.length) {
  console.error("キャンペーンが見つかりません（トークンの権限を確認）");
  process.exit(1);
}
const campaignId = campaigns.data[0].id;

// ---- 2. アクティブ加入者をページングで全取得（ティア金額込み）----
const members = [];
const tierCents = new Map(); // tier id → amount_cents
let url =
  `/campaigns/${campaignId}/members` +
  `?include=currently_entitled_tiers` +
  `&fields%5Bmember%5D=full_name,patron_status` +
  `&fields%5Btier%5D=title,amount_cents` +
  `&page%5Bcount%5D=100`;
while (url) {
  const page = await api(url);
  for (const inc of page.included ?? [])
    if (inc.type === "tier") tierCents.set(inc.id, inc.attributes.amount_cents ?? 0);
  for (const m of page.data ?? []) members.push(m);
  const next = page.links?.next;
  url = next ? next.replace(API, "") : null;
}

// ---- 3. ティア判定（金額ベース）と mapping 適用 ----
const mappingRaw = JSON.parse(fs.readFileSync("mapping.json", "utf8"));
const mapping = Object.fromEntries(
  Object.entries(mappingRaw).filter(([k]) => !k.startsWith("_"))
);

const out = { ultra: [], super: [], supporter: [] };
const unmapped = [];
for (const m of members) {
  if (m.attributes.patron_status !== "active_patron") continue;
  const tiers = m.relationships?.currently_entitled_tiers?.data ?? [];
  let cents = 0;
  for (const t of tiers) cents = Math.max(cents, tierCents.get(t.id) ?? 0);
  if (cents < 300) continue; // ティア未満（フォロワー等）は対象外
  const bucket = cents >= 1000 ? "ultra" : cents >= 500 ? "super" : "supporter";
  const vrcName = mapping[m.id];
  if (!vrcName) {
    unmapped.push(`  未紐付け: member id=${m.id} (${m.attributes.full_name ?? "?"}) → mapping.json に追記してください`);
    continue;
  }
  out[bucket].push(vrcName);
}
for (const k of Object.keys(out)) out[k].sort((a, b) => a.localeCompare(b));

if (unmapped.length) {
  console.log("⚠ VRChat 名が未登録の加入者がいます:");
  for (const line of unmapped) console.log(line);
}

// ---- 4. 変化があったときだけ書き出す ----
const body = {
  updated: new Date().toISOString(),
  tiers: [
    { id: "ultra", label: "ultra supporter" },
    { id: "super", label: "super supporter" },
    { id: "supporter", label: "supporter" },
  ],
  ultra: out.ultra,
  super: out.super,
  supporter: out.supporter,
};

let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
const same =
  prev &&
  JSON.stringify([prev.ultra, prev.super, prev.supporter]) ===
    JSON.stringify([body.ultra, body.super, body.supporter]);

if (same) {
  console.log(`変更なし（ultra ${out.ultra.length} / super ${out.super.length} / supporter ${out.supporter.length}）`);
} else {
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(body, null, 2) + "\n");
  console.log(`更新: ultra ${out.ultra.length} / super ${out.super.length} / supporter ${out.supporter.length} → ${OUT}`);
}

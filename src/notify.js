import { SETTINGS, liveTradingAllowed } from "./config.js";
import { safeErrorMessage } from "./safety.js";

const VERDICT = {
  green: "🟢 可小仓试",
  review: "🟡 人工复核",
  skip: "🔴 回避",
  watch: "⚪ 观察",
};

export function formatAlert(report) {
  const { meta, facts, score, verdict, red, checks, links, token, venue, creator } = report;
  const lines = [];
  lines.push(`${VERDICT[verdict] || verdict}  <b>${esc(meta.symbol)}</b>  ${score}/100`);
  lines.push(`${esc(meta.name || "")}`);
  lines.push("");
  lines.push(`<b>CA</b> <code>${token}</code>`);
  lines.push(`<b>池</b> ${esc(venue)} / ${esc(report.dex?.quoteSymbol || "WETH")}`);
  lines.push(
    `<b>年龄</b> ${Number.isFinite(facts.ageMinutes) ? `${facts.ageMinutes.toFixed(1)} 分钟` : "未知"}`
  );
  lines.push(
    `<b>市值</b> $${fmt(facts.mcapUsd)}  ·  <b>流动性</b> $${fmt(facts.liquidityUsd)}` +
      (facts.mcapUsd ? `  (liq/mc ${((facts.liquidityUsd / facts.mcapUsd) * 100).toFixed(0)}%)` : "")
  );
  lines.push(
    `<b>成交 5m</b> $${fmt(facts.volume5m)}  买 ${facts.buys5m} / 卖 ${facts.sells5m}`
  );
  lines.push(
    `<b>社交</b> ${facts.hasTwitter ? "Twitter✅" : "Twitter❌"} ${facts.hasTelegram ? "TG✅" : "TG❌"}` +
      (facts.narrativeHits?.length ? `  叙事: ${facts.narrativeHits.join(", ")}` : "")
  );
  lines.push(
    `<b>持仓</b> 前10 ${facts.top10Pct == null ? "?" : facts.top10Pct.toFixed(1) + "%"}  ·  ${facts.holderCount ?? "?"} 人`
  );
  lines.push(
    `<b>创建者</b> ${creator ? `<code>${short(creator)}</code>` : "?"} 持仓 ${facts.creatorPct?.toFixed(1) ?? "?"}%  · 历史发币 ${facts.deployerTokens ?? "未知"}`
  );
  const buyTax = Number.isFinite(facts.buyTaxBps) ? facts.buyTaxBps : "未知";
  const sellTax = Number.isFinite(facts.sellTaxBps) ? facts.sellTaxBps : "未知";
  const lpStatus = facts.lpUnknown
    ? "未验证"
    : Number.isFinite(facts.lpBurnedPct)
      ? `已烧 ${facts.lpBurnedPct.toFixed(0)}%`
      : "未验证";
  lines.push(
    `<b>安全</b> 蜜罐 ${facts.honeypot === false ? "通过" : facts.honeypot === true ? "失败" : "未完成"}  税 ${buyTax}/${sellTax}bps  LP ${lpStatus}`
  );
  if (red.length) {
    lines.push("");
    lines.push("<b>红旗</b>");
    for (const r of red) lines.push(`• ${esc(r)}`);
  }
  lines.push("");
  lines.push("<b>清单</b>");
  for (const c of checks) {
    lines.push(`${c.ok ? "✓" : "·"} ${esc(c.key)} ${esc(c.detail)} ${c.pts ? `(+${c.pts})` : ""}`);
  }
  lines.push("");
  lines.push(`<a href="${links.dex}">DexScreener</a> · <a href="${links.explorer}">Blockscout</a> · <a href="${links.gmgn}">GMGN</a>`);
  if (!liveTradingAllowed()) {
    lines.push("");
    lines.push("<i>默认只报警，不自动买入。任何操作请使用独立小额钱包。</i>");
  }
  return lines.join("\n");
}

export async function sendTelegram(text) {
  if (!SETTINGS.telegramToken || !SETTINGS.telegramChat) {
    console.log("\n--- telegram (not configured) ---\n" + text.replace(/<[^>]+>/g, "") + "\n");
    return false;
  }
  const url = `https://api.telegram.org/bot${SETTINGS.telegramToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: SETTINGS.telegramChat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram ${res.status}: ${body}`);
  }
  return true;
}

export async function alertReport(report) {
  const text = formatAlert(report);
  console.log(
    `[${report.verdict}] ${report.meta.symbol} ${report.score}/100 ${report.token} red=${report.red.length}`
  );
  try {
    await sendTelegram(text);
  } catch (err) {
    console.error("telegram failed:", safeErrorMessage(err));
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function short(addr) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmt(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number(n).toFixed(0);
}

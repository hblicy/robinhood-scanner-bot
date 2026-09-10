import { SETTINGS } from "./config.js";
import { safeErrorMessage } from "./safety.js";
import { normalizeSellabilityEvidence } from "./sellability.js";
import { normalizeWalletSignals } from "./wallet-labels.js";

const VERDICT = {
  green: "🟢 可小仓试",
  review: "🟡 人工复核",
  skip: "🔴 回避",
  watch: "⚪ 观察",
};

export function formatAlert(report) {
  const { meta, facts, score, verdict, red, checks, links, token, venue, creator } = report;
  const sellability = normalizeSellabilityEvidence(report.sellability, report.honeypot?.honeypot);
  const walletSignals = normalizeWalletSignals(report.walletSignals || sellability.walletSignals);
  const sellabilityReason = formatSellabilityReason(sellability.status, sellability.reason);
  const lines = [];
  const chainName = report.chainName || report.chain || "Robinhood Chain";
  lines.push(`${verdictIcon(verdict)} [${esc(chainName)}] ${verdictText(verdict)}  <b>${esc(meta.symbol)}</b>  ${score}/100`);
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
  const referenceRestrictions = [...new Set(
    Array.isArray(report.referenceRestrictions) ? report.referenceRestrictions : []
  )];
  if (report.referenceAssetKind === "stock" && referenceRestrictions.length > 0) {
    lines.push(`<b>股票底池限制</b> ${referenceRestrictions.map(esc).join("、")}`);
  }
  lines.push(
    `<b>卖出安全</b> ${sellabilityLabel(sellability.status)}  原因 ${sellabilityReason}  买家样本 ${sellability.buyerSamples}  额度样本 ${sellability.ladderSamples}  真实卖家 ${sellability.meaningfulSellers}`
  );
  const walletSignalText = walletSignals.status !== "known"
    ? "标签未配置"
    : walletSignals.count === 0
      ? "未命中"
      : `命中 ${walletSignals.count}：${walletSignals.matches
        .map((item) => `${esc(item.label)}(${item.type === "kol" ? "KOL" : "聪明钱"})`)
        .join("、")}`;
  lines.push(`<b>聪明钱</b> ${walletSignalText}`);
  const buyTax = Number.isFinite(facts.buyTaxBps) ? facts.buyTaxBps : "未知";
  const sellTax = Number.isFinite(facts.sellTaxBps) ? facts.sellTaxBps : "未知";
  const lpStatus = facts.lpUnknown
    ? "未验证"
    : Number.isFinite(facts.lpBurnedPct)
      ? `已烧 ${facts.lpBurnedPct.toFixed(0)}%`
      : "未验证";
  lines.push(
    `<b>安全</b> ${honeypotRiskLabel(sellability.status)}  税 ${buyTax}/${sellTax}bps  LP ${lpStatus}`
  );
  if (report.errorSources?.length) {
    const sources = [...new Set(report.errorSources.map(({ source }) => String(source)))];
    lines.push(`<b>数据异常</b> ${sources.map(esc).join(", ")}`);
  }
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
  lines.push([
    safeHttpLink("DexScreener", links.dex),
    safeHttpLink(report.chain === "solana" ? "Solscan" : "Blockscout", links.explorer),
    safeHttpLink("GMGN", links.gmgn),
  ].join(" · "));
  lines.push("");
  lines.push("<i>本程序只扫描报警，不包含模拟或实盘交易功能。</i>");
  return lines.join("\n");
}

const LIFECYCLE_LABELS = {
  new_launch: "🆕 Pons V2 新币",
  hard_kill: "⛔ 硬淘汰",
  graduated: "🎓 链上毕业",
  market_ready: "✅ 市场已就绪",
  rescued: "🛟 Factory 已救援",
  green: "🟢 三线通过",
  swept: "⏳ Curve 已 Sweep",
  phase_changed: "🔄 链上阶段变化",
  heat_change: "🌡️ 市场温度变化",
};

export function formatLifecycleNotification(notification) {
  const type = String(notification?.transitionType || "unknown");
  const label = LIFECYCLE_LABELS[type] || "Pons V2 状态变化";
  const reason = notification?.reason || "链上状态变化";
  const [icon, ...words] = label.split(" ");
  const chainName = notification?.chainName || notification?.chain || "Robinhood Chain";
  return [
    `${icon} [${esc(chainName)}] ${words.join(" ")} [${esc(type)}]`,
    `<b>CA</b> <code>${esc(notification?.token)}</code>`,
    `<b>原因</b> ${esc(reason)}`,
    `<b>ID</b> <code>${esc(notification?.id)}</code>`,
  ].join("\n");
}

function verdictIcon(verdict) {
  return String(VERDICT[verdict] || verdict).split(" ")[0];
}

function verdictText(verdict) {
  return String(VERDICT[verdict] || verdict).split(" ").slice(1).join(" ");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendTelegramWith(text, {
  settings = SETTINGS,
  fetchImpl = fetch,
  sleep = delay,
  log = console.log,
  timeoutMs = 10000,
} = {}) {
  if (!settings.telegramToken || !settings.telegramChat) {
    log("\n--- telegram (not configured) ---\n" + text.replace(/<[^>]+>/g, "") + "\n");
    return false;
  }
  const url = `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          chat_id: settings.telegramChat,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) throw new Error(`telegram ${res.status}`);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(200 * (2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`telegram send failed after 3 attempts: ${safeErrorMessage(lastError)}`, { cause: lastError });
}

export async function sendTelegram(text) {
  return sendTelegramWith(text);
}

export async function alertReport(report) {
  const text = formatAlert(report);
  console.log(
    `[${report.verdict}] ${report.meta.symbol} ${report.score}/100 ${report.token} red=${report.red.length}`
  );
  return sendTelegram(text);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeHttpLink(label, value) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(value));
  } catch {
    return esc(label);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return esc(label);
  return `<a href="${escAttribute(parsedUrl.href)}">${esc(label)}</a>`;
}

function escAttribute(value) {
  return esc(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sellabilityLabel(status) {
  if (status === "confirmed") return "已确认";
  if (status === "blocked") return "已阻断";
  return "未确认";
}

function formatSellabilityReason(status, reason) {
  if (reason == null || reason === "") {
    return status === "confirmed" ? "无" : "evidence-unavailable";
  }
  return esc(reason);
}

function honeypotRiskLabel(sellabilityStatus) {
  if (sellabilityStatus === "blocked") return "风险 已阻断";
  if (sellabilityStatus === "confirmed") return "风险 未发现阻断";
  return "风险 未确认";
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

// ============================================================
//  ChaddyBot — Public Bridge Server (Production)
//  Deployable to Railway / Render / VPS
//
//  Environment variables to set on your host:
//    OPENAI_API_KEY   = sk-...
//    BRIDGE_API_KEY   = any secret password you choose
//                       (MT5 must send this in every request)
//    PORT             = (set automatically by Railway/Render)
// ============================================================

const express = require("express");
const app     = express();
app.use(express.json({ limit: "1mb" }));

const PORT          = process.env.PORT          || 3000;
const OPENAI_KEY    = process.env.OPENAI_API_KEY || "";
const BRIDGE_SECRET = process.env.BRIDGE_API_KEY || "1234"; // ← set this!
const MODEL         = "gpt-4o";

// ── Security: reject requests without the correct secret key ──
// MT5 sends this in the X-API-Key header on every request
function requireAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== BRIDGE_SECRET) {
    console.warn(`[${new Date().toISOString()}] ❌ Unauthorised request from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

const SYSTEM_PROMPT = `You are an XAU/USD (Gold) MT5 trading bot. At each decision cycle you receive: 
current price, open trade status, entry price, current P&L in pips, and last 
3 candle directions on M15.

SESSIONS: Only trade during these windows (GMT):
- London open: 07:00–10:00 (highest gold liquidity)
- NY open overlap: 12:00–15:00 (strongest momentum moves)
- AVOID: 20:00–00:00 GMT (thin liquidity, stop hunts common)

ENTRY RULES:
- BUY: EMA8 crosses above EMA21 + RSI between 45–65 + last 2 M15 candles bullish 
  + price above EMA50
- SELL: EMA8 crosses below EMA21 + RSI between 35–55 + last 2 M15 candles bearish 
  + price below EMA50
- Never enter if RSI above 75 or below 25 (overextended, fade risk high)
- Never enter within 10 minutes of a red-folder news event (NFP, CPI, FOMC, Fed speakers)

TRADE PARAMETERS:
- Stop Loss: 150 pips from entry (accounts for gold spread and wick noise)
- Take Profit: 300 pips from entry (2:1 RR minimum)
- On strong trending days (ATR14 above 1800 pips): extend TP to 450 pips
- Position size: risk exactly 1% of account balance per trade

TRADE MANAGEMENT:
- If trade reaches +150 pips profit: activate trailing stop at 80 pips
- If trade reaches +300 pips: move SL to breakeven and trail at 100 pips
- If trade moves 80 pips adverse AND momentum has reversed on M15: CLOSE immediately
- If price stalls 4+ candles with no progress toward TP: CLOSE
- If a major news spike occurs against your position: CLOSE immediately, 
  do not wait for SL

REVERSAL RULE:
- If trade closed at a loss and price continues strongly in that direction:
  open new trade in that direction at 50% normal position size
- Require 2 confirmed M15 candles closing in new direction before reversing
- RSI must confirm new direction (above 50 for buys, below 50 for sells)
- If reversal trade also stops out: HOLD minimum 3 candles, reassess trend 
  on H1 before any new entry
- Maximum 2 reversals per session — after that, HOLD only

CAPITAL PROTECTION (NON-NEGOTIABLE):
- Max loss per trade: 1% of account balance
- If session drawdown reaches 2.5% of opening balance: halt all trading, 
  ACTION = HOLD for remainder of session
- Never average down on a losing position
- Never widen SL once set
- After 3 consecutive losses in any session: HOLD, session is done

TREND BIAS FILTER:
- Check H1 chart direction before any M15 entry
- Only take BUY signals if H1 trend is up or neutral
- Only take SELL signals if H1 trend is down or neutral
- Counter-trend M15 trades are forbidden

OUTPUT FORMAT — one line per field, every cycle:
ACTION: [BUY / SELL / CLOSE / CLOSE_AND_REVERSE_BUY / CLOSE_AND_REVERSE_SELL / HOLD]
REASON: [one sentence]
ENTRY: [price]
SL: [price]
TP: [price]
TRAIL_ACTIVE: [YES / NO]
LOT_SIZE: [calculated from 1% risk rule]
SESSION_DRAWDOWN: [current % from session opening balance].`;

function parseDecision(content) {
  const lines  = content.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const upper  = (lines[0] || "").toUpperCase();

  // Direction: always BUY or SELL — default to whichever word appears first if ambiguous
  let decision = "BUY";
  if (upper.includes("SELL")) decision = "SELL";
  else if (upper.includes("BUY")) decision = "BUY";
  else {
    // Fallback: scan all lines for first occurrence
    const allUpper = content.toUpperCase();
    const buyIdx  = allUpper.indexOf("BUY");
    const sellIdx = allUpper.indexOf("SELL");
    if (sellIdx !== -1 && (buyIdx === -1 || sellIdx < buyIdx)) decision = "SELL";
    else decision = "BUY";
  }

  // Extract TP levels
  function extractTP(label) {
    const regex = new RegExp(label + "\\s*:\\s*([\\d.]+)", "i");
    for (const line of lines) {
      const m = line.match(regex);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  const tp1 = extractTP("TP1");
  const tp2 = extractTP("TP2");
  const tp3 = extractTP("TP3");

  // Extract reason
  let reason = "";
  for (const line of lines) {
    if (/^reason\s*:/i.test(line)) {
      reason = line.replace(/^reason\s*:\s*/i, "").trim();
      break;
    }
  }
  // Fallback: last non-TP, non-direction line
  if (!reason) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!/^(BUY|SELL|TP\d)/i.test(l)) { reason = l; break; }
    }
  }

  return { decision, tp1, tp2, tp3, reason };
}

async function getAIDecision(marketContext) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  120,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: marketContext  },
      ],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const content = data?.choices?.[0]?.message?.content;
  if (!content)  throw new Error("Empty content from OpenAI");
  return { ...parseDecision(content), usage: data.usage };
}

// ── Public health check (no auth needed — just confirms server is up)
app.get("/health", (req, res) => {
  res.json({ status: "ok", model: MODEL, time: new Date().toISOString() });
});

// ── Signal endpoint (auth required)
app.post("/signal", requireAuth, async (req, res) => {
  const marketData = req.body?.market_data;
  if (!marketData) {
    return res.status(400).json({ decision: "HOLD", reason: "No market_data provided" });
  }

  console.log(`[${new Date().toISOString()}] /signal from ${req.ip} (${marketData.length} chars)`);

  try {
    const result = await getAIDecision(marketData);
    console.log(`  → ${result.decision} | TP1:${result.tp1} TP2:${result.tp2} TP3:${result.tp3} | ${result.reason}`);
    if (result.usage) console.log(`  → Tokens: ${result.usage.total_tokens}`);
    res.json({
      decision: result.decision,
      tp1:      result.tp1,
      tp2:      result.tp2,
      tp3:      result.tp3,
      reason:   result.reason
    });
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ decision: "HOLD", reason: "Server error: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`  ChaddyBot AI Bridge (Public)`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Model: ${MODEL}`);
  if (!OPENAI_KEY)    console.warn("  ⚠️  OPENAI_API_KEY not set!");
  if (BRIDGE_SECRET === "changeme123") console.warn("  ⚠️  Using default BRIDGE_API_KEY — change it!");
  console.log("=".repeat(50));
});



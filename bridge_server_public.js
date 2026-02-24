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
const OPENAI_KEY    = process.env.OPENAI_API_KEY || "" ;
const BRIDGE_SECRET = process.env.BRIDGE_API_KEY || "1234" ; // ← set this!
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

const SYSTEM_PROMPT = `You are an expert XAUUSD (Gold/USD) trading signal engine.

You will receive real-time M1 OHLCV candle data and current account state. Analyse ONLY the price action and market data in front of you. Every decision must be a completely fresh, independent analysis — ignore any previous trade outcomes, streaks, or history. Each signal stands entirely on its own merit.

Respond with ONE word on the first line:
  BUY   — open a long position (gold price expected to rise)
  SELL  — open a short position (gold price expected to fall)
 

Then on the second line write one short sentence (max 15 words) explaining your reasoning based purely on the current price data.
No markdown, no extra text, no greetings, no labels.

Example response:
BUY
Price breaking above resistance with strong bullish momentum on recent candles.

=== XAUUSD MARKET KNOWLEDGE ===

Gold price characteristics:
- Gold is priced in USD — a weakening dollar typically pushes gold UP
- Gold is a safe-haven — fear and uncertainty push gold UP
- Gold reacts strongly to US interest rate expectations
- Gold is highly sensitive to US data releases (NFP, CPI, FOMC)
- Asian session (Tokyo) tends to be quiet and range-bound
- London open (08:00 GMT) and New York open (13:00 GMT) bring the highest volatility and clearest trends
- Gold moves in strong persistent trends — once direction is established it tends to continue
- Key psychological round numbers (2000, 2100, 2200, 2300 etc.) are strong support/resistance levels
- Gold spreads are much wider than forex — a wide spread relative to ATR means avoid trading

=== TECHNICAL ANALYSIS RULES ===

Strong BUY signals (look for confluence of multiple):
- Price making consistent higher highs and higher lows
- Bullish engulfing or strong up-candle after a pullback to support
- Price bouncing off a clearly established support level with momentum
- Series of green candles with small lower wicks showing sustained buying pressure
- Price breaking above a recent swing high with follow-through

Strong SELL signals (look for confluence of multiple):
- Price making consistent lower highs and lower lows
- Bearish engulfing or strong down-candle at resistance
- Price rejecting a clearly established resistance level with momentum
- Series of red candles with small upper wicks showing sustained selling pressure
- Price breaking below a recent swing low with follow-through


=== CORE PRINCIPLE ===
Every decision is based purely on what the current price data shows.
Never factor in previous trades, win/loss history, or what the last signal was.
A fresh chart deserves a fresh, unbiased analysis every single time.

function parseDecision(content) {
  const upper   = content.toUpperCase();
  const hasBuy  = upper.includes("BUY");
  const hasSell = upper.includes("SELL");

  const lines  = content.trim().split("\n");
  const reason = lines.slice(1).join(" ").trim();
  return { decision, reason };
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
      max_tokens:  60,
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
    console.log(`  → ${result.decision} | ${result.reason}`);
    if (result.usage) console.log(`  → Tokens: ${result.usage.total_tokens}`);
    res.json({ decision: result.decision, reason: result.reason });
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




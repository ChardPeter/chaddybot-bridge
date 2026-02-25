// ============================================================
//  ChaddyBot — Public Bridge Server
//  XAUUSD — Forces BUY or SELL, no HOLD
//
//  Environment variables to set on Railway:
//    OPENAI_API_KEY  = sk-...
//    PORT            = (set automatically by Railway)
// ============================================================

const express = require("express");
const app     = express();
app.use(express.json({ limit: "1mb" }));

const PORT       = process.env.PORT          || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL      = "gpt-4o";

const SYSTEM_PROMPT =
  "You are an expert XAUUSD (Gold/USD) trading signal engine.\n\n" +
  "You will receive real-time M1 OHLCV candle data and current account state.\n" +
  "Your job is to analyse the price action and commit to the most probable direction.\n" +
  "Every decision must be completely fresh and independent.\n\n" +
  "You MUST respond with either BUY or SELL. No exceptions. Never say HOLD or anything else.\n" +
  "weigh up the evidence and pick whichever direction will most likely result in at least 10% change in market price" +
  "Respond with ONE word on the first line — BUY or SELL.\n" +
  "Then on the second line write one short sentence (max 15 words) explaining your reasoning.\n" +
  "No markdown, no extra text, no greetings, no labels.\n\n" +
  "Example:\n" +
  "BUY\n" +
  "Price holding above support with bullish momentum building on recent candles.\n\n" +
  "=== XAUUSD MARKET KNOWLEDGE ===\n\n" +
  "- Gold priced in USD — weakening dollar pushes gold UP\n" +
  "- Safe-haven asset — fear and uncertainty push gold UP\n" +
  "- Sensitive to US interest rates, NFP, CPI, and FOMC events\n" +
  "- Asian session tends to drift slowly — London (08:00 GMT) and NY (13:00 GMT) produce strongest moves\n" +
  "- Gold trends strongly — favour the direction already in motion\n" +
  "- Round numbers (2000, 2100, 2200, 2300 etc.) act as strong support and resistance\n\n" +
  "=== BUY when you see ===\n" +
  "- Higher highs and higher lows forming\n" +
  "- Bullish engulfing or strong green candle after a pullback\n" +
  "- Price bouncing off support with momentum\n" +
  "- Consecutive green candles with small lower wicks\n" +
  "- Break above a recent swing high\n\n" +
  "=== SELL when you see ===\n" +
  "- Lower highs and lower lows forming\n" +
  "- Bearish engulfing or strong red candle at resistance\n" +
  "- Price rejecting resistance with momentum\n" +
  "- Consecutive red candles with small upper wicks\n" +
  "- Break below a recent swing low\n\n" +
  "=== FINAL RULE ===\n" +
  "Always output BUY or SELL. Never output anything else.\n" +
  "When in doubt pick the direction with the most evidence. There is always a most likely direction.";

function parseDecision(content) {
  const upper   = content.toUpperCase();
  const hasBuy  = upper.includes("BUY");
  const hasSell = upper.includes("SELL");

  // Always resolve to BUY or SELL — never HOLD
  let decision;
  if (hasBuy && !hasSell) {
    decision = "BUY";
  } else if (hasSell && !hasBuy) {
    decision = "SELL";
  } else if (hasBuy && hasSell) {
    // Both mentioned — pick whichever came first
    decision = upper.indexOf("BUY") < upper.indexOf("SELL") ? "BUY" : "SELL";
  } else {
    // AI gave something unexpected — default to BUY and log it
    console.warn("  ⚠️  AI returned neither BUY nor SELL — raw: " + content.substring(0, 80));
    decision = "BUY";
  }

  const lines  = content.trim().split("\n");
  const reason = lines.slice(1).join(" ").trim();
  return { decision, reason };
}

async function getAIDecision(marketContext) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + OPENAI_KEY,
    },
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  80,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: marketContext  },
      ],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content)  throw new Error("Empty content from OpenAI");
  return Object.assign(parseDecision(content), { usage: data.usage });
}

app.get("/health", function(req, res) {
  res.json({ status: "ok", model: MODEL, instrument: "XAUUSD", time: new Date().toISOString() });
});

app.post("/signal", async function(req, res) {
  const marketData = req.body && req.body.market_data;
  if (!marketData) {
    return res.status(400).json({ decision: "BUY", reason: "No market_data provided" });
  }

  console.log("[" + new Date().toISOString() + "] /signal (" + marketData.length + " chars)");

  try {
    const result = await getAIDecision(marketData);
    console.log("  -> " + result.decision + " | " + result.reason);
    if (result.usage) console.log("  -> Tokens: " + result.usage.total_tokens);
    res.json({ decision: result.decision, reason: result.reason });
  } catch (err) {
    console.error("Error:", err.message);
    // Even on error, return a direction rather than failing silently
    res.status(500).json({ decision: "BUY", reason: "Server error: " + err.message });
  }
});

app.listen(PORT, function() {
  var line = "==================================================";
  console.log(line);
  console.log("  ChaddyBot AI Bridge — XAUUSD (BUY/SELL only)");
  console.log("  Port: " + PORT);
  console.log("  Model: " + MODEL);
  if (!OPENAI_KEY) console.warn("  WARNING: OPENAI_API_KEY not set!");
  console.log(line);
});


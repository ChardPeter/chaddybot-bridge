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

const SYSTEM_PROMPT = `You are a professional XAUUSD trading signal engine.
Analyse the market data and respond with ONE word on the first line:
  BUY   — if the setup favours a long entry
  SELL  — if the setup favours a short entry
  HOLD  — if there is no clear edge


Rules:
- Prefer HOLD when trend is unclear or spread is large vs ATR.
- If Recovery Mode is YES, only signal OPPOSITE to last losing direction.
- Never signal the same direction as an already-open position.`;

function parseDecision(content) {
  const upper   = content.toUpperCase();
  const hasBuy  = upper.includes("BUY");
  const hasSell = upper.includes("SELL");

  let decision = "HOLD";
  if      (hasBuy && !hasSell)  decision = "BUY";
  else if (hasSell && !hasBuy)  decision = "SELL";
  else if (hasBuy && hasSell)
    decision = upper.indexOf("BUY") < upper.indexOf("SELL") ? "BUY" : "SELL";

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


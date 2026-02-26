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
const BRIDGE_SECRET = process.env.BRIDGE_API_KEY || ""; // ← set this!
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

const SYSTEM_PROMPT = `You are a professional forex trading signal engine. Your job is to always determine the best trade direction and precise take profit levels based on the market data provided.

You MUST always respond with either BUY or SELL — never HOLD or any other word. There is always a better direction, even in ranging markets. Analyse price action, momentum, structure, and context to determine it.

Respond in EXACTLY this format (4 lines, no markdown, no extra text):
BUY
TP1: 1.23456
TP2: 1.23789
TP3: 1.24100
Reason: One sentence explaining the setup.

Rules:
- Line 1: BUY or SELL only. Nothing else.
- Lines 2-4: TP1, TP2, TP3 as exact price levels (same decimal precision as the symbol). TP levels must be in the correct direction from current price (above entry for BUY, below entry for SELL). TP1 < TP2 < TP3 for BUY; TP1 > TP2 > TP3 for SELL.
- Line 5: Reason starting with "Reason: " followed by one concise sentence.
- Base TP levels on key support/resistance, recent swing highs/lows, and ATR. TP1 = conservative (0.5–1x ATR), TP2 = moderate (1.5–2x ATR), TP3 = extended (2.5–3x ATR).
- If Recovery Mode is YES, strongly prefer the OPPOSITE direction to the last losing trade.
- Never signal the same direction as an already-open position unless clearly justified.
- You MUST always provide a BUY or SELL signal. Uncertainty is not a reason to avoid a direction — pick the higher-probability side.`;

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

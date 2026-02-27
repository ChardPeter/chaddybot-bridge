'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  ChaddyBot Bridge Server — JavaScript / Node.js
//  Receives market data from MT5, calls OpenAI, returns a trade decision.
//
//  Deploy on Railway:
//    1. Push this folder to GitHub
//    2. Create new Railway project → Deploy from GitHub repo
//    3. Set environment variables (see .env.example)
//    4. Railway auto-detects Node and runs: node server.js
// ─────────────────────────────────────────────────────────────────────────────

const http    = require('http');
const https   = require('https');
const { URL } = require('url');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT               = process.env.PORT          || 3000;
const BRIDGE_API_KEY     = process.env.BRIDGE_API_KEY || '1234';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || '';
const MODEL              = 'gpt-4o';
const MAX_TOKENS         = 1024;
const REQUEST_TIMEOUT_MS = 12000;  // Must be less than MT5 Bridge_Timeout_Sec (15s)

// ── System prompt (your trading rules) ───────────────────────────────────────
const SYSTEM_PROMPT = `You are an XAU/USD (Gold) MT5 trading bot. Each bar you receive live market data and must
return a JSON decision object. Your JSON is parsed directly by MT5 — formatting errors cause
missed trades.

REQUIRED OUTPUT FORMAT — return ONLY valid JSON, nothing else, no markdown fences:

{"decision":"HOLD","sl":0.0,"tp":0.0,"lot_size":0.0,"trail_active":false,"reason":"one sentence"}

CRITICAL RULES FOR THE JSON:
- "decision" must be EXACTLY one of: BUY / SELL / CLOSE / CLOSE_AND_REVERSE_BUY / CLOSE_AND_REVERSE_SELL / HOLD
- When decision is HOLD or CLOSE: set sl, tp, lot_size to 0.0
- When decision is BUY or SELL: sl, tp, lot_size MUST be non-zero real numbers
- trail_active: true only when an open trade has reached +10 pips profit
- No extra fields, no markdown, no explanation outside the JSON object
- You MUST always pick the best possible action given ALL available data — never default to HOLD out of uncertainty alone

NO-TRADE RULE — CRITICAL:
- When the market data shows "Open Positions: None" under the === OPEN POSITIONS === section, you are FLAT and MUST enter a trade.
- HOLD is only acceptable when flat if session drawdown >= 2.5% — in all other flat states you MUST pick BUY or SELL.
- Uncertainty is never a reason to HOLD when flat. If signals are mixed, pick the dominant direction.
- The only valid response when flat is BUY or SELL with fully populated sl, tp, lot_size.
- Do not wait for perfect conditions — act on the best available signal right now.

SESSIONS — trade 24/7. There are no restricted hours. Enter trades at any time of day or night.

ENTRY RULES — at least 2 of the following conditions must be true simultaneously:
BUY when:
  - EMA8 crosses above EMA21 (confirmed on closed candle)
  - RSI between 45 and 65
  - Last 2 M1 candles are bullish (close > open)
  - Price is above EMA50
  - H1 trend is UP or NEUTRAL (no counter-trend trades)

SELL when:
  - EMA8 crosses below EMA21 (confirmed on closed candle)
  - RSI between 35 and 55
  - Last 2 M1 candles are bearish (close < open)
  - Price is below EMA50
  - H1 trend is DOWN or NEUTRAL

TRADE PARAMETERS — calculate and return exact prices:
lot_size:  Risk exactly 1% of account balance per trade.
           Formula: lot_size = (balance * 0.01) / (sl_distance_in_pips * pip_value)
           For XAU/USD: pip_value = $1 per 0.01 lot per pip. Round to 2 decimal places.

sl:  Absolute price, 50 pips from entry.
     For XAU/USD: 1 pip = 0.10 price units, so 50 pips = 5.0 price units.
     BUY:  sl = ask - 5.0
     SELL: sl = bid + 5.0

tp:  Absolute price, 300 pips from entry (2:1 RR minimum).
     If ATR14 > 180.0 price units (= 1800 pips): extend TP to 450 pips (45.0 units).
     BUY:  tp = ask + 30.0  (or ask + 45.0 on strong trend days)
     SELL: tp = bid - 30.0  (or bid - 45.0)

Example: ask = 2950.00 → sl = 2945.00, tp = 2980.00

TRADE MANAGEMENT — check on every bar with an open position:
- If open trade P&L pips >= 15:  set trail_active: true
- If open trade P&L pips >= 300:  return HOLD (trail handles it)
- If open trade moves 80 pips adverse AND M1 momentum reversed: decision = CLOSE
- If price stalls 10+ candles with no progress toward TP: decision = CLOSE
- If major news spike occurs against position: decision = CLOSE immediately

CAPITAL PROTECTION — NON-NEGOTIABLE:
- Max loss per trade: 1% of account balance

- Never average down. Never widen SL once set.

LOSS PROTECTION RULE — CRITICAL:
- The EA will NEVER close a position that is currently at a loss.
- If you return CLOSE or CLOSE_AND_REVERSE_BUY/SELL while "Close Allowed: NO" appears
  in the market data, the EA will ignore the close and wait.
- When a position is in loss and you detect an opposite signal, do NOT return CLOSE.
  Instead return BUY or SELL in the new direction WITHOUT closing — the EA will hold
  the losing trade until it recovers to profit, then close it automatically.
- Always check "Close Allowed" and "Floating P&L" fields in the market data before
  deciding to close. Only return CLOSE or CLOSE_AND_REVERSE when Close Allowed = YES.
- When Close Allowed = NO: focus on managing the existing losing trade back to profit.
  You may still open a new position in the opposite direction if conditions are strong.

EXAMPLES OF CORRECT OUTPUT:

Valid BUY: {"decision":"BUY","sl":2945.00,"tp":2980.00,"lot_size":0.08,"trail_active":false,"reason":"EMA8 crossed above EMA21, RSI 52, last 2 candles bullish, price above EMA50, H1 uptrend confirmed."}

Trail on: {"decision":"HOLD","sl":0.0,"tp":0.0,"lot_size":0.0,"trail_active":true,"reason":"Trade at +12 pips, trailing stop now active."}

Close:    {"decision":"CLOSE","sl":0.0,"tp":0.0,"lot_size":0.0,"trail_active":false,"reason":"Price moved 80 pips adverse and M1 momentum reversed bearish."}`;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(level, msg, data) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg}`;
    console.log(data ? `${line} ${JSON.stringify(data)}` : line);
}

// ── Safe JSON response writer ─────────────────────────────────────────────────
function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

// ── Error fallback — only used when the server itself errors, not for AI logic ─
function errorResponse(reason) {
    return {
        decision:     'HOLD',
        sl:           0.0,
        tp:           0.0,
        lot_size:     0.0,
        trail_active: false,
        reason,
    };
}

// ── Call OpenAI API ───────────────────────────────────────────────────────────
function callOpenAI(marketData) {
    return new Promise((resolve, reject) => {
        if (!OPENAI_API_KEY) {
            return reject(new Error('OPENAI_API_KEY is not set'));
        }

        const payload = JSON.stringify({
            model:      MODEL,
            max_tokens: MAX_TOKENS,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role:    'user',
                    content: `Here is the current market data. Analyse it and return your JSON decision:\n\n${marketData}`,
                },
            ],
        });

        const options = {
            hostname: 'api.openai.com',
            path:     '/v1/chat/completions',
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization':  `Bearer ${OPENAI_API_KEY}`,
            },
            timeout: REQUEST_TIMEOUT_MS,
        };

        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    log('ERROR', `OpenAI API returned HTTP ${res.statusCode}`, { body: raw.slice(0, 300) });
                    return reject(new Error(`OpenAI API HTTP ${res.statusCode}`));
                }
                try {
                    const parsed = JSON.parse(raw);
                    const text = parsed?.choices?.[0]?.message?.content ?? '';
                    resolve(text.trim());
                } catch (e) {
                    reject(new Error(`Failed to parse OpenAI response: ${e.message}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('OpenAI API request timed out'));
        });

        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

// ── Parse and validate the AI's JSON text into a trade decision ───────────────
// The AI decides everything — this function only validates structure, never overrides
function parseDecision(text) {
    // Strip any accidental markdown fences
    let clean = text.replace(/```json|```/gi, '').trim();

    // Extract first JSON object from the response
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in AI response');
    clean = clean.slice(start, end + 1);

    const obj = JSON.parse(clean);

    const VALID_DECISIONS = new Set([
        'BUY', 'SELL', 'CLOSE',
        'CLOSE_AND_REVERSE_BUY', 'CLOSE_AND_REVERSE_SELL', 'HOLD',
    ]);

    const decision = (obj.decision ?? '').toUpperCase().trim();
    if (!VALID_DECISIONS.has(decision)) {
        throw new Error(`Invalid decision value: "${obj.decision}"`);
    }

    // Return exactly what the AI decided — no overrides
    return {
        decision,
        sl:           Number(obj.sl           ?? 0),
        tp:           Number(obj.tp           ?? 0),
        lot_size:     Number(obj.lot_size     ?? 0),
        trail_active: Boolean(obj.trail_active ?? false),
        reason:       String(obj.reason       ?? ''),
    };
}

// ── Authentication ────────────────────────────────────────────────────────────
function checkAuth(req) {
    return (req.headers['x-api-key'] ?? '') === BRIDGE_API_KEY;
}

// ── Request router ────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
    const url    = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method.toUpperCase();

    // ── GET /health ──────────────────────────────────────────────────────────
    if (method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
            status:      'ok',
            model:       MODEL,
            timestamp:   new Date().toISOString(),
            api_key_set: Boolean(OPENAI_API_KEY),
        });
    }

    // ── POST /signal ─────────────────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/signal') {
        if (!checkAuth(req)) {
            log('WARN', 'Rejected request — bad API key');
            return sendJson(res, 401, { error: 'Unauthorized' });
        }

        // Read body
        let body = '';
        req.on('data', chunk => { body += chunk; });
        await new Promise(resolve => req.on('end', resolve));

        let marketData = '';
        try {
            const parsed = JSON.parse(body);
            marketData = parsed.market_data ?? body;
        } catch {
            marketData = body;
        }

        if (!marketData) {
            return sendJson(res, 400, errorResponse('Empty market_data received'));
        }

        log('INFO', `Signal request received (${marketData.length} chars)`);

        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Bridge-level timeout')), REQUEST_TIMEOUT_MS)
            );

            const aiText   = await Promise.race([callOpenAI(marketData), timeoutPromise]);
            log('INFO', 'OpenAI raw response', { text: aiText.slice(0, 300) });

            const decision = parseDecision(aiText);
            log('INFO', 'Parsed decision', decision);

            return sendJson(res, 200, decision);

        } catch (err) {
            log('ERROR', `Signal handler error: ${err.message}`);
            return sendJson(res, 200, errorResponse(`Server error: ${err.message}`));
        }
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return sendJson(res, 404, { error: 'Not found' });
}

// ── Startup ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        await handleRequest(req, res);
    } catch (err) {
        log('ERROR', `Unhandled error: ${err.message}`);
        try { sendJson(res, 200, errorResponse('Unhandled server error')); } catch (_) {}
    }
});

server.listen(PORT, () => {
    log('INFO', `ChaddyBot bridge listening on port ${PORT}`);
    log('INFO', `Model: ${MODEL}`);
    log('INFO', `OpenAI API key configured: ${Boolean(OPENAI_API_KEY)}`);
    if (!OPENAI_API_KEY) {
        log('WARN', 'OPENAI_API_KEY is not set — all /signal calls will fail!');
    }
});


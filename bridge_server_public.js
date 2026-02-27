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
const MAX_TOKENS         = 3000;
const REQUEST_TIMEOUT_MS = 25000;

// ── System prompt (your trading rules) ───────────────────────────────────────
const SYSTEM_PROMPT = `You are an XAU/USD (Gold) MT5 trading bot. Each bar you receive live market data and must
return a JSON decision object. Your JSON is parsed directly by MT5 — formatting errors cause
missed trades.

REQUIRED OUTPUT FORMAT — return ONLY valid JSON, nothing else, no markdown fences:

{"decision":"","sl":,"tp":,"lot_size":,"trail_active":,"reason":""}

CRITICAL RULES FOR THE JSON:
- never say hold
- "decision" must be EXACTLY one of: BUY / SELL / CLOSE / CLOSE_AND_REVERSE_BUY / CLOSE_AND_REVERSE_SELL 
- When decision is CLOSE: set sl, tp, lot_size to 0.0
- When decision is BUY or SELL: sl, tp, lot_size MUST be non-zero real numbers
- trail_active: true only when an open trade has reached +15 pips profit
- No extra fields, no markdown, no explanation outside the JSON object
- You MUST always pick the best possible action given ALL available data — never default to HOLD out of uncertainty alone

SESSIONS — only trade during these GMT windows:
- London open:     00:00–23:59 GMT  (highest gold liquidity)



ENTRY RULES — any 2 conditions must be true simultaneously:
BUY when:
  - EMA8 crosses above EMA21 (confirmed on closed candle)
  - RSI between 45 and 65
  - Last 2 M15 candles are bullish (close > open)
  - Price is above EMA50
  - H1 trend is UP or NEUTRAL (no counter-trend trades)

SELL when:
  - EMA8 crosses below EMA21 (confirmed on closed candle)
  - RSI between 35 and 55
  - Last 2 M15 candles are bearish (close < open)
  - Price is below EMA50
  - H1 trend is DOWN or NEUTRAL


TRADE PARAMETERS — calculate and return exact prices:
lot_size:  Risk exactly 1% of account balance per trade.
           Formula: lot_size = (balance * 0.01) / (sl_distance_in_pips * pip_value)
           For XAU/USD: pip_value = $1 per 0.01 lot per pip. Round to 2 decimal places.

sl:  Absolute price, 150 pips from entry.
     For XAU/USD: 1 pip = 0.10 price units, so 150 pips = 15.0 price units.
     BUY:  sl = ask - 15.0
     SELL: sl = bid + 15.0

tp:  Absolute price, 300 pips from entry (2:1 RR minimum).
     If ATR14 > 180.0 price units (= 1800 pips): extend TP to 450 pips (45.0 units).
     BUY:  tp = ask + 30.0  (or ask + 45.0 on strong trend days)
     SELL: tp = bid - 30.0  (or bid - 45.0)

Example: ask = 2950.00 → sl = 2935.00, tp = 2980.00

TRADE MANAGEMENT — check on every bar with an open position:
- If open trade P&L pips >= 150:  set trail_active: true
- If open trade P&L pips >= 300:  return HOLD (trail handles it)
- If open trade moves 80 pips adverse AND M15 momentum reversed: decision = CLOSE
- If price stalls 4+ candles with no progress toward TP: decision = CLOSE
- If major news spike occurs against position: decision = CLOSE immediately

REVERSAL RULES:
- After a loss where price continues strongly in the losing direction
- Require 2 confirmed M15 candles closing in new direction
- RSI must confirm (>50 for buys, <50 for sells)
- Use 50% of normal lot size
- decision = CLOSE_AND_REVERSE_BUY or CLOSE_AND_REVERSE_SELL
- Maximum 2 reversals per session 

CAPITAL PROTECTION — NON-NEGOTIABLE:
- Max loss per trade: 1% of account balance

- Never average down. Never widen SL once set.

EXAMPLES OF CORRECT OUTPUT:

signal: {"decision":"","sl":,"tp":,"lot_size":0.01,"trail_active":,"reason":""}`;

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


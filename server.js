const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const DAILY_FREE_LIMIT = 10;
const anonymousUsage = {};
const PAYPAL_MODE = process.env.PAYPAL_MODE === "live" ? "live" : "sandbox";
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_API_BASE = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

console.log("Ollama Base URL:", OLLAMA_BASE_URL);

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "guai-hub" });
});

app.get("/api/paypal/config", (req, res) => {
  res.json({
    enabled: Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET),
    clientId: PAYPAL_CLIENT_ID,
    mode: PAYPAL_MODE
  });
});

async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal credentials are not configured");
  }
  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status})`);
  return (await response.json()).access_token;
}

app.post("/api/paypal/orders", async (req, res) => {
  try {
    const { plan } = req.body || {};
    const prices = { pro: "9.99", team: "24.99" };
    if (!prices[plan]) return res.status(400).json({ error: "Invalid plan" });
    const token = await getPayPalAccessToken();
    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          description: `GuAI Hub ${plan === "pro" ? "Pro" : "Team"} monthly plan`,
          amount: { currency_code: "USD", value: prices[plan] }
        }]
      })
    });
    const body = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: body.message || "PayPal order creation failed" });
    res.json({ id: body.id });
  } catch (err) {
    console.error("PayPal order error:", err.message);
    res.status(503).json({ error: "PayPal is not configured or unavailable" });
  }
});

app.post("/api/paypal/orders/:orderId/capture", async (req, res) => {
  try {
    const token = await getPayPalAccessToken();
    const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(req.params.orderId)}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    const body = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: body.message || "PayPal capture failed" });
    res.json({ status: body.status, orderId: body.id });
  } catch (err) {
    console.error("PayPal capture error:", err.message);
    res.status(503).json({ error: "PayPal is not configured or unavailable" });
  }
});

let users = {};

// Load users from storage
async function loadUsers() {
  try {
    const data = await fs.readFile(path.join(__dirname, "users.json"), "utf8");
    users = JSON.parse(data);
  } catch (e) {
    users = {};
  }
}

// Save users to storage
async function saveUsers() {
  await fs.writeFile(path.join(__dirname, "users.json"), JSON.stringify(users, null, 2), "utf8");
}

function getUsage(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (!user || user.usageDate !== today) {
    return { date: today, count: 0 };
  }
  return { date: today, count: Number(user.dailyMessageCount) || 0 };
}

function getAnonymousUsage(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const usage = anonymousUsage[ip];
  if (!usage || usage.date !== today) {
    anonymousUsage[ip] = { date: today, count: 0 };
  }
  return anonymousUsage[ip];
}

async function consumeFreeMessage(username, ip) {
  const userKey = username && username.toLowerCase().trim();
  if (!userKey || !users[userKey]) {
    const usage = getAnonymousUsage(ip);
    if (usage.count >= DAILY_FREE_LIMIT) {
      return { allowed: false, count: usage.count, remaining: 0 };
    }
    usage.count += 1;
    return { allowed: true, count: usage.count, remaining: DAILY_FREE_LIMIT - usage.count };
  }

  const user = users[userKey];
  const usage = getUsage(user);
  if (usage.count >= DAILY_FREE_LIMIT) {
    return { allowed: false, count: usage.count, remaining: 0 };
  }

  user.usageDate = usage.date;
  user.dailyMessageCount = usage.count + 1;
  await saveUsers();
  return {
    allowed: true,
    count: user.dailyMessageCount,
    remaining: DAILY_FREE_LIMIT - user.dailyMessageCount
  };
}

// Password hashing helper functions
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return hash === checkHash;
}

// Helper function to extract response text from streamed Ollama chunks
function parseOllamaResponse(fullText) {
  const lines = fullText.split("\n");
  let responseText = "";
  for (const line of lines) {
    if (line.trim()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.response) {
          responseText += parsed.response;
        }
      } catch (e) {}
    }
  }
  return responseText;
}

// Helper function to append to chat log history associated with username
async function logChat(username, prompt, response) {
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    username: username || "anonymous",
    prompt,
    response
  }) + "\n";
  await fs.appendFile(path.join(__dirname, "chat_logs.jsonl"), logEntry, "utf8");
}

// Endpoint for User Signup
app.post("/api/signup", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).send("Username and password are required");
    }
    const userLower = username.toLowerCase().trim();
    if (users[userLower]) {
      return res.status(400).send("Username already exists");
    }
    const { salt, hash } = hashPassword(password);
    users[userLower] = { username, salt, hash };
    await saveUsers();
    res.json({ success: true, username });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).send("Signup failed");
  }
});

// Endpoint for User Login
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).send("Username and password are required");
    }
    const userLower = username.toLowerCase().trim();
    const user = users[userLower];
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      return res.status(400).send("Invalid username or password");
    }
    res.json({ success: true, username: user.username });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Login failed");
  }
});

// Endpoint to fetch history for specific user
app.get("/history", async (req, res) => {
  try {
    const username = req.query.username;
    if (!username) {
      return res.status(400).send("Username query parameter is required");
    }
    const filePath = path.join(__dirname, "chat_logs.jsonl");
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (e) {
      return res.json([]);
    }
    const lines = content.split("\n").filter(line => line.trim() !== "");
    const history = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(item => item !== null && item.username && item.username.toLowerCase() === username.toLowerCase());
    
    res.json(history);
  } catch (err) {
    console.error("Error reading history:", err);
    res.status(500).send("Error reading history");
  }
});

// Endpoint for the current user's daily free-message usage
app.get("/usage", (req, res) => {
  const username = (req.query.username || "").toLowerCase().trim();
  const user = users[username];
  const usage = user ? getUsage(user) : getAnonymousUsage(req.ip);
  res.json({
    limit: DAILY_FREE_LIMIT,
    used: usage.count,
    remaining: Math.max(DAILY_FREE_LIMIT - usage.count, 0)
  });
});

// Endpoint to fetch installed Ollama models with fallback
app.get("/models", async (req, res) => {
  const defaultModels = ["minimax-m3:cloud", "phi3:mini", "llama3:latest", "gemma:2b"];
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
      return res.json(defaultModels);
    }
    const data = await response.json();
    let models = Array.isArray(data.models) ? data.models.map(m => m.name) : [];
    if (models.length === 0) {
      models = defaultModels;
    } else if (!models.includes("minimax-m3:cloud")) {
      models.unshift("minimax-m3:cloud");
    }
    res.json(models);
  } catch (err) {
    console.error("Error fetching models:", err.message);
    res.json(defaultModels);
  }
});

// Endpoint for AI Audio/Video & Script Dubbing Pipeline
app.post("/api/dub", async (req, res) => {
  try {
    const { sourceText, targetLanguage, voiceStyle } = req.body;
    if (!sourceText) {
      return res.status(400).json({ error: "sourceText is required" });
    }

    const langMap = {
      gu: "Gujarati (ગુજરાતી)",
      hi: "Hindi (हिंदी)",
      en: "English",
      es: "Spanish",
      fr: "French",
      de: "German",
      ja: "Japanese",
      zh: "Chinese",
      mr: "Marathi"
    };

    const targetLangName = langMap[targetLanguage] || targetLanguage || "Gujarati";

    res.json({
      success: true,
      targetLanguage: targetLangName,
      originalText: sourceText,
      dubbedText: sourceText,
      voiceStyle: voiceStyle || "natural"
    });
  } catch (err) {
    console.error("Dubbing API error:", err);
    res.status(500).json({ error: "Dubbing pipeline failed" });
  }
});

// Endpoint to manually log a chat
app.post("/log", async (req, res) => {
  try {
    const { username, prompt, response } = req.body;
    await logChat(username, prompt, response);
    res.json({ success: true });
  } catch (err) {
    console.error("Log error:", err);
    res.status(500).send("Error logging chat");
  }
});

// Endpoint to ask Ollama
app.post("/ask", async (req, res) => {
  try {
    const { username, model, prompt, documents } = req.body;
    console.log("Ask:", model, prompt ? prompt.substring(0, 30) : "");

    const usage = await consumeFreeMessage(username, req.ip);
    if (!usage.allowed) {
      return res.status(429).json({
        error: "Daily free limit reached",
        limit: DAILY_FREE_LIMIT,
        used: usage.count,
        remaining: 0
      });
    }

    const fullPrompt = documents
      ? `Use these docs:\n${documents}\n\nUser: ${prompt}`
      : prompt;

    const payload = { model, prompt: fullPrompt };

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error("Ollama status:", response.status);
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error || "Ollama server returned an error";
      res.status(response.status).send(errMsg);
      return;
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      res.write(chunk);
    }
    res.end();

    const parsed = parseOllamaResponse(fullText);
    logChat(username, prompt, parsed).catch(e => console.error("Log error:", e.message));

  } catch (err) {
    console.error("Error:", err.message);
    if (!res.headersSent) {
      res.status(500).send("Error processing request");
    }
  }
});

loadUsers().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`Server is running at http://${HOST}:${PORT}`);
  });
});

const express = require("express");
const https = require("https");
const { GoogleAuth } = require("google-auth-library");

// ─── Сервис-аккаунт из env ────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
const PROJECT_ID = serviceAccount.project_id;

console.log(`Project ID from service account: ${PROJECT_ID}`);

// GoogleAuth для получения OAuth2-токена под нужный скоуп FCM
const googleAuth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
});

// ─── Отправка одного FCM-сообщения через HTTP v1 API ─────────────────────────
async function sendFcmToToken(accessToken, fcmToken, title, body, chatId) {
  const payload = JSON.stringify({
    message: {
      token: fcmToken,
      notification: { title, body },
      data: { chatId },
      android: {
        priority: "high",
        notification: {
          channel_id: "messages_channel",
          priority: "high",
          default_sound: true,
        },
      },
    },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "fcm.googleapis.com",
      path: `/v1/projects/${PROJECT_ID}/messages:send`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── HTTP сервер ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send(`CoolMessanger notification server ✓ (project: ${PROJECT_ID})`);
});

app.post("/notify", async (req, res) => {
  const { tokens, senderEmail, chatId, bodyText } = req.body;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ error: "tokens array is required" });
  }
  if (!bodyText) {
    return res.status(400).json({ error: "bodyText is required" });
  }

  try {
    // Получаем свежий OAuth2-токен
    const accessToken = await googleAuth.getAccessToken();
    console.log(`Sending to ${tokens.length} token(s) for chat ${chatId}`);

    let ok = 0;
    let fail = 0;

    for (const token of tokens) {
      const result = await sendFcmToToken(
        accessToken,
        token,
        senderEmail ?? "Новое сообщение",
        bodyText,
        chatId ?? ""
      );

      if (result.status === 200) {
        ok++;
      } else {
        fail++;
        console.error(
          `FCM HTTP ${result.status} for token ...${token.slice(-10)}: ${result.body}`
        );
      }
    }

    console.log(`[${chatId}] FCM: ${ok} ok / ${fail} failed`);
    res.json({ success: true, ok, fail });
  } catch (err) {
    console.error("Error in /notify:", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Notification server listening on port ${PORT}, project: ${PROJECT_ID}`)
);

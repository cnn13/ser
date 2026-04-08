const admin = require("firebase-admin");
const express = require("express");

// ─── Инициализация Firebase Admin SDK ────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const messaging = admin.messaging();
// Firestore НЕ используется — Android сам читает токены и присылает их сюда

// ─── HTTP сервер ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (_req, res) => {
  res.send("CoolMessanger notification server is running ✓");
});

// POST /notify — принимает токены от Android и отправляет FCM
app.post("/notify", async (req, res) => {
  const { tokens, senderEmail, chatId, bodyText } = req.body;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ error: "tokens array is required" });
  }
  if (!bodyText) {
    return res.status(400).json({ error: "bodyText is required" });
  }

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: senderEmail ?? "Новое сообщение",
        body: bodyText,
      },
      data: {
        chatId: chatId ?? "",
      },
      android: {
        priority: "high",
        notification: {
          channelId: "messages_channel",
          priority: "high",
          defaultSound: true,
        },
      },
    });

    console.log(
      `[${chatId}] FCM: ${response.successCount} ok / ${response.failureCount} failed`
    );

    // Логируем детали каждой ошибки
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error(`  Token[${idx}] error: ${resp.error?.code} — ${resp.error?.message}`);
      }
    });

    res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (err) {
    console.error("FCM error:", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "FCM send failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Notification server listening on port ${PORT}`)
);

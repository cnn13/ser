const admin = require("firebase-admin");
const express = require("express");

// ─── Инициализация Firebase Admin SDK ────────────────────────────────────────
// SERVICE_ACCOUNT_JSON — содержимое файла serviceAccountKey.json (env-переменная)
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// ─── Слушаем только новые сообщения (после старта сервера) ───────────────────
const serverStartTime = Date.now();
console.log(`Server started at ${new Date(serverStartTime).toISOString()}`);

db.collectionGroup("messages")
  .where("timestamp", ">=", serverStartTime)
  .onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;

        try {
          await handleNewMessage(change.doc);
        } catch (err) {
          console.error("Error handling message:", err);
        }
      });
    },
    (err) => {
      console.error("Firestore listener error:", err);
      // Render перезапустит процесс если он упадёт
      process.exit(1);
    }
  );

async function handleNewMessage(doc) {
  const msg = doc.data();
  const chatId = doc.ref.parent.parent.id;
  const senderId = msg.senderId;

  if (!senderId || !chatId) return;

  // Текст уведомления
  const bodyText =
    msg.contentType === "image"
      ? "📷 Изображение"
      : msg.contentType === "file"
      ? "📎 Файл"
      : msg.text || "";

  if (!bodyText) return;

  // Имя отправителя
  const senderSnap = await db.collection("users").doc(senderId).get();
  const senderName = senderSnap.data()?.email ?? "Новое сообщение";

  // Участники чата
  const chatSnap = await db.collection("chats").doc(chatId).get();
  const participants = chatSnap.data()?.participants ?? [];

  // Получатели = все кроме отправителя
  const recipients = participants.filter((uid) => uid !== senderId);
  if (recipients.length === 0) return;

  // FCM-токены получателей
  const userSnaps = await Promise.all(
    recipients.map((uid) => db.collection("users").doc(uid).get())
  );

  const tokens = userSnaps
    .map((s) => s.data()?.fcmToken)
    .filter((t) => typeof t === "string" && t.length > 0);

  if (tokens.length === 0) {
    console.log(`No tokens for chat ${chatId}, skipping`);
    return;
  }

  // Отправляем FCM
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: senderName, body: bodyText },
    data: { chatId },
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
    `[${chatId}] Sent ${response.successCount}/${tokens.length} notifications`
  );

  // Удаляем невалидные токены из Firestore
  const invalidCodes = [
    "messaging/invalid-registration-token",
    "messaging/registration-token-not-registered",
  ];
  const batch = db.batch();
  let hasBadTokens = false;

  response.responses.forEach((resp, idx) => {
    if (!resp.success && invalidCodes.includes(resp.error?.code)) {
      const badToken = tokens[idx];
      const snap = userSnaps.find((s) => s.data()?.fcmToken === badToken);
      if (snap) {
        batch.update(snap.ref, { fcmToken: admin.firestore.FieldValue.delete() });
        hasBadTokens = true;
      }
    }
  });

  if (hasBadTokens) await batch.commit();
}

// ─── HTTP-сервер (нужен для Render — проверяет живость через GET /) ───────────
const app = express();

app.get("/", (_req, res) => {
  res.send("CoolMessanger notification server is running ✓");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

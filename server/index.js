const admin = require("firebase-admin");
const express = require("express");

// ─── Инициализация Firebase Admin SDK ────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// TTL: не отправляем уведомления по задачам старше 5 минут
// (защита от "взрыва" старых задач после перезапуска сервера)
const TASK_TTL_MS = 5 * 60 * 1000;

console.log("Server started, listening to notification_tasks...");

// ─── Слушаем коллекцию notification_tasks ────────────────────────────────────
// Не требует индексов и не упирается в security rules (Admin SDK их обходит)
db.collection("notification_tasks").onSnapshot(
  async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;

      const ref = change.doc.ref;
      const task = change.doc.data();

      // Удаляем устаревшую задачу молча
      if (Date.now() - (task.timestamp ?? 0) > TASK_TTL_MS) {
        await ref.delete().catch(() => {});
        continue;
      }

      try {
        await processTask(task);
      } catch (err) {
        console.error("Error processing task:", err?.message ?? err);
      } finally {
        // Всегда удаляем задачу — чтобы не обработать повторно
        await ref.delete().catch(() => {});
      }
    }
  },
  (err) => {
    console.error("Firestore listener error:", err?.message ?? err);
    process.exit(1); // Render перезапустит процесс
  }
);

async function processTask(task) {
  const { senderId, senderEmail, chatId, text, contentType } = task;

  if (!senderId || !chatId) return;

  // Текст уведомления
  const bodyText =
    contentType === "image"
      ? "📷 Изображение"
      : contentType === "file"
      ? "📎 Файл"
      : text ?? "";

  if (!bodyText) return;

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
    console.log(`No FCM tokens for chat ${chatId}`);
    return;
  }

  // Отправляем FCM
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title: senderEmail ?? "Новое сообщение",
      body: bodyText,
    },
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
    `[${chatId}] Notifications: ${response.successCount} ok / ${response.failureCount} failed`
  );

  // Удаляем невалидные токены из Firestore
  const invalidCodes = new Set([
    "messaging/invalid-registration-token",
    "messaging/registration-token-not-registered",
  ]);

  const batch = db.batch();
  let hasBad = false;

  response.responses.forEach((resp, idx) => {
    if (!resp.success && invalidCodes.has(resp.error?.code)) {
      const snap = userSnaps.find((s) => s.data()?.fcmToken === tokens[idx]);
      if (snap?.ref) {
        batch.update(snap.ref, { fcmToken: admin.firestore.FieldValue.delete() });
        hasBad = true;
      }
    }
  });

  if (hasBad) await batch.commit();
}

// ─── HTTP-сервер (Render требует открытый порт) ───────────────────────────────
const app = express();

app.get("/", (_req, res) =>
  res.send("CoolMessanger notification server is running ✓")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP listening on port ${PORT}`));

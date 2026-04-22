require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const cron = require("node-cron");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ── Google Sheets підключення ─────────────────────────────────────────────
const privateKey = process.env.GOOGLE_PRIVATE_KEY;
if (!privateKey) throw new Error("❌ GOOGLE_PRIVATE_KEY не задано!");
if (!process.env.GOOGLE_SERVICE_EMAIL) throw new Error("❌ GOOGLE_SERVICE_EMAIL не задано!");
if (!process.env.BOT_TOKEN) throw new Error("❌ BOT_TOKEN не задано!");

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_EMAIL,
  key: privateKey.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

async function getSheets() {
  await doc.loadInfo();
  const clients = doc.sheetsByTitle["clients"] || await doc.addSheet({ title: "clients", headerValues: ["tg_id", "name", "username", "count", "joined", "last_used"] });
  const codes   = doc.sheetsByTitle["codes"]   || await doc.addSheet({ title: "codes",   headerValues: ["date", "code", "used"] });
  const coupons = doc.sheetsByTitle["coupons"] || await doc.addSheet({ title: "coupons", headerValues: ["coupon", "tg_id", "name", "created", "used"] });
  return { clients, codes, coupons };
}

// ── Ролі ──────────────────────────────────────────────────────────────────
const ADMIN_IDS   = process.env.ADMIN_IDS.split(",").map(id => id.trim());
const BARISTA_IDS = (process.env.BARISTA_IDS || "").split(",").map(id => id.trim()).filter(Boolean);

function isAdmin(tgId)   { return ADMIN_IDS.includes(String(tgId)); }
function isBarista(tgId) { return BARISTA_IDS.includes(String(tgId)); }
function isStaff(tgId)   { return isAdmin(tgId) || isBarista(tgId); }

// ── Утиліти ───────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toLocaleString("sv", { timeZone: "Europe/Kyiv" }).slice(0, 10);
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => "0123456789"[Math.floor(Math.random() * 10)]).join("");
}

function randomCoupon() {
  return "FREE-" + Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
}

function pizzaWord(n) {
  if (n === 1) return "піца";
  if (n >= 2 && n <= 4) return "піци";
  return "піц";
}

// ── Постійна клавіатура клієнта ───────────────────────────────────────────
const clientKeyboard = {
  keyboard: [
    [{ text: "🏠 Головна" }, { text: "📊 Статистика" }],
    [{ text: "🍕 Ввести код" }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ── Клавіатура бариста ────────────────────────────────────────────────────
const baristaKeyboard = {
  keyboard: [
    [{ text: "🎟 Згенерувати код для клієнта" }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ── Одноразові коди ───────────────────────────────────────────────────────
async function generateOneTimeCode() {
  const { codes } = await getSheets();
  const code = randomCode();
  await codes.addRow({ date: todayStr(), code, used: "no" });
  return code;
}

async function useOneTimeCode(inputCode) {
  const { codes } = await getSheets();
  const rows = await codes.getRows();
  const found = rows.find(r => r.get("code") === inputCode && r.get("used") === "no");
  if (!found) return false;
  found.set("used", "yes");
  await found.save();
  return true;
}

// ── Клієнти ───────────────────────────────────────────────────────────────
async function getOrCreateClient(tgId, name, username) {
  const { clients } = await getSheets();
  const rows = await clients.getRows();
  const found = rows.find(r => r.get("tg_id") === String(tgId));
  if (found) return found;

  await clients.addRow({
    tg_id: String(tgId),
    name,
    username: username || "",
    count: "0",
    joined: todayStr(),
    last_used: "",
  });
  const updated = await clients.getRows();
  return updated.find(r => r.get("tg_id") === String(tgId));
}

async function getClientCount(tgId) {
  const { clients } = await getSheets();
  const rows = await clients.getRows();
  const found = rows.find(r => r.get("tg_id") === String(tgId));
  return found ? parseInt(found.get("count") || "0") : 0;
}

async function incrementClient(tgId) {
  const { clients } = await getSheets();
  const rows = await clients.getRows();
  const found = rows.find(r => r.get("tg_id") === String(tgId));
  if (!found) return 0;
  const newCount = parseInt(found.get("count") || "0") + 1;
  found.set("count", String(newCount));
  await found.save();
  return newCount;
}

// ── Купони ────────────────────────────────────────────────────────────────
async function createCoupon(tgId, name) {
  const { coupons } = await getSheets();
  const coupon = randomCoupon();
  await coupons.addRow({ coupon, tg_id: String(tgId), name, created: todayStr(), used: "no" });
  return coupon;
}

async function checkCoupon(couponCode) {
  const { coupons } = await getSheets();
  const rows = await coupons.getRows();
  const found = rows.find(r => r.get("coupon") === couponCode.toUpperCase());
  if (!found) return { status: "not_found" };
  if (found.get("used") === "yes") return { status: "used" };
  return { status: "valid", name: found.get("name"), row: found };
}

async function markCouponUsed(couponCode) {
  const { coupons } = await getSheets();
  const rows = await coupons.getRows();
  const found = rows.find(r => r.get("coupon") === couponCode.toUpperCase());
  if (found) { found.set("used", "yes"); await found.save(); }
}

// ── Головна сторінка клієнта ──────────────────────────────────────────────
async function sendHome(chatId, name, tgId) {
  const count = await getClientCount(tgId);
  const remaining = 10 - (count % 10);
  bot.sendMessage(chatId,
    `🏠 *Головна*\n\n` +
    `🍕 Куплено піц: *${count}*\n` +
    `До безкоштовної: *${remaining}* ${pizzaWord(remaining)}\n\n` +
    `${count === 0 ? "Купи першу піцу і отримай код від бариста! 👇" : remaining <= 3 ? "🔥 Ще трохи — і безкоштовна піца!" : "💪 Гарний прогрес!"}`,
    { parse_mode: "Markdown", reply_markup: clientKeyboard }
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  /start — визначаємо роль і показуємо потрібний інтерфейс
// ══════════════════════════════════════════════════════════════════════════
bot.onText(/\/start/, async (msg) => {
  const tgId = msg.from.id;
  const name = msg.from.first_name || "Гість";
  const username = msg.from.username || "";

  // Бариста
  if (isBarista(tgId)) {
    return bot.sendMessage(tgId,
      `👋 Привіт, ${name}!\n\n` +
      `Натисни кнопку щоб згенерувати код для клієнта після продажу піци 👇`,
      { parse_mode: "Markdown", reply_markup: baristaKeyboard }
    );
  }

  // Адмін
  if (isAdmin(tgId)) {
    return bot.sendMessage(tgId,
      `👋 Привіт, ${name}! Ти в адмін-режимі.\n\nВикористовуй /admin для панелі керування.`,
      { parse_mode: "Markdown" }
    );
  }

  // Клієнт
  await getOrCreateClient(tgId, name, username);
  bot.sendMessage(tgId,
    `👋 Привіт, ${name}!\n\n` +
    `🍕 Це бот програми лояльності *Хліб з маслом*\n` +
    `Кожна 11-а міні-піца — *безкоштовно!*\n\n` +
    `Використовуй кнопки внизу 👇`,
    { parse_mode: "Markdown", reply_markup: clientKeyboard }
  );
  await sendHome(tgId, name, tgId);
});

// ══════════════════════════════════════════════════════════════════════════
//  БАРИСТА — генерація коду
// ══════════════════════════════════════════════════════════════════════════
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const tgId = msg.from.id;
  const name = msg.from.first_name || "Гість";
  const username = msg.from.username || "";

  // ── Кнопки бариста ──────────────────────────────────────────────────────
  if (msg.text === "🎟 Згенерувати код для клієнта") {
    if (!isStaff(tgId)) return;
    const code = await generateOneTimeCode();
    return bot.sendMessage(msg.chat.id,
      `🎟 *Одноразовий код:*\n\n` +
      `\`${code}\`\n\n` +
      `📢 Скажи клієнту:\n_"Відкрий бота і введи код: *${code}*"_\n\n` +
      `⚠️ Код діє лише *один раз* і лише для *одного клієнта*`,
      { parse_mode: "Markdown", reply_markup: baristaKeyboard }
    );
  }

  // ── Кнопки клієнта ──────────────────────────────────────────────────────
  if (isStaff(tgId)) return; // стафф не обробляємо як клієнта

  if (msg.text === "🏠 Головна") {
    await getOrCreateClient(tgId, name, username);
    return sendHome(msg.chat.id, name, tgId);
  }

  if (msg.text === "📊 Статистика") {
    const count = await getClientCount(tgId);
    const remaining = 10 - (count % 10);
    const freeEarned = Math.floor(count / 10);
    return bot.sendMessage(msg.chat.id,
      `📊 *Твоя статистика*\n\n` +
      `🍕 Куплено піц: *${count}*\n` +
      `🆓 Отримано безкоштовних: *${freeEarned}*\n` +
      `До наступної: *${remaining}* ${pizzaWord(remaining)}\n\n` +
      `${remaining <= 3 ? "🔥 Ще трохи — і безкоштовна піца!" : "💪 Продовжуй!"}`,
      { parse_mode: "Markdown", reply_markup: clientKeyboard }
    );
  }

  if (msg.text === "🍕 Ввести код") {
    return bot.sendMessage(msg.chat.id,
      `Просто напиши *4-значний код* який дав бариста 👇`,
      { parse_mode: "Markdown", reply_markup: clientKeyboard }
    );
  }

  // ── Обробка 4-значного коду ──────────────────────────────────────────────
  if (/^\d{4}$/.test(msg.text)) {
    const tgId2 = tgId;
    const name2 = name;
    const username2 = username;
    if (isStaff(tgId2)) return;
    await getOrCreateClient(tgId2, name2, username2);
    const inputCode = msg.text.trim();
    const valid = await useOneTimeCode(inputCode);
    if (!valid) {
      return bot.sendMessage(msg.chat.id,
        `❌ *Невірний або вже використаний код.*\n\nПопроси бариста згенерувати новий після покупки піци.`,
        { parse_mode: "Markdown", reply_markup: clientKeyboard }
      );
    }
    const newCount = await incrementClient(tgId2);
    const remaining = 10 - (newCount % 10);
    if (newCount % 10 === 0) {
      const coupon = await createCoupon(tgId2, name2);
      return bot.sendMessage(msg.chat.id,
        `🎉 *Вітаємо!* Це твоя ${newCount}-а піца!\n\n` +
        `🆓 Ти отримуєш *безкоштовну міні-піцу!*\n\n` +
        `Покажи касиру цей купон:\n🎟 \`${coupon}\`\n\n` +
        `_Купон безстроковий — не загубь!_`,
        { parse_mode: "Markdown", reply_markup: clientKeyboard }
      );
    } else {
      return bot.sendMessage(msg.chat.id,
        `✅ *Покупку зараховано!*\n\n` +
        `🍕 Всього піц: *${newCount}*\n` +
        `До безкоштовної ще: *${remaining}* ${pizzaWord(remaining)}\n\n` +
        `${remaining <= 3 ? "🔥 Ще трохи!" : "💪 Гарний прогрес!"}`,
        { parse_mode: "Markdown", reply_markup: clientKeyboard }
      );
    }
  }
});



// ══════════════════════════════════════════════════════════════════════════
//  АДМІН — панель
// ══════════════════════════════════════════════════════════════════════════
bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;

  bot.sendMessage(msg.chat.id,
    "👨‍💼 *Адмін-панель*\nОбери дію:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Топ клієнтів", callback_data: "admin_clients" }],
          [{ text: "✅ Перевірити купон", callback_data: "admin_coupon" }],
        ]
      }
    }
  );
});

bot.onText(/\/check (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const couponCode = match[1].trim().toUpperCase();
  const result = await checkCoupon(couponCode);

  if (result.status === "not_found") return bot.sendMessage(msg.chat.id, "❌ Купон не знайдено.");
  if (result.status === "used")      return bot.sendMessage(msg.chat.id, "⚠️ Купон вже був використаний.");

  bot.sendMessage(msg.chat.id,
    `✅ Купон *дійсний*\n👤 Клієнт: *${result.name}*\n\nВидати безкоштовну піцу та закрити купон?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Так, закрити`, callback_data: `use_${couponCode}` },
          { text: "❌ Скасувати", callback_data: "cancel" }
        ]]
      }
    }
  );
});

// ── Callback кнопки адміна ────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const tgId = query.from.id;
  const data = query.data;

  if (!isAdmin(tgId)) return bot.answerCallbackQuery(query.id);

  if (data === "admin_clients") {
    const { clients } = await getSheets();
    const rows = await clients.getRows();
    const sorted = rows
      .map(r => ({ name: r.get("name"), count: parseInt(r.get("count") || "0") }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const lines = ["📋 *Топ клієнтів:*\n"];
    sorted.forEach((c, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      lines.push(`${medal} ${c.name} — *${c.count}* 🍕`);
    });

    bot.editMessageText(lines.join("\n"),
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
    );
  }

  if (data === "admin_coupon") {
    bot.editMessageText(
      "Введи команду з купоном:\n`/check FREE-XXXXXXXX`",
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
    );
  }

  if (data.startsWith("use_")) {
    const coupon = data.replace("use_", "");
    await markCouponUsed(coupon);
    bot.editMessageText(
      `✅ Купон \`${coupon}\` закрито. Безкоштовна піца видана! 🍕`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
    );
  }

  if (data === "cancel") {
    bot.editMessageText("Скасовано.",
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    );
  }

  bot.answerCallbackQuery(query.id);
});

// ══════════════════════════════════════════════════════════════════════════
//  ЩОРАНКУ О 9:01 — нагадування адміну
// ══════════════════════════════════════════════════════════════════════════
cron.schedule("1 9 * * *", async () => {
  for (const adminId of ADMIN_IDS) {
    bot.sendMessage(adminId,
      `☀️ *Доброго ранку!*\n\n` +
      `🍕 Бот лояльності працює.\n` +
      `Баристи генерують коди після кожного продажу піци через кнопку в боті.\n\n` +
      `Для перегляду статистики: /admin`,
      { parse_mode: "Markdown" }
    );
  }
}, { timezone: "Europe/Kyiv" });

console.log("🍕 PizzaBro запущено!");

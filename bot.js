require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const cron = require("node-cron");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ── Google Sheets підключення ─────────────────────────────────────────────
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

async function getSheets() {
  await doc.loadInfo();
  const clients = doc.sheetsByTitle["clients"] || await doc.addSheet({ title: "clients", headerValues: ["tg_id", "name", "username", "count", "joined"] });
  const codes   = doc.sheetsByTitle["codes"]   || await doc.addSheet({ title: "codes",   headerValues: ["date", "code"] });
  const coupons = doc.sheetsByTitle["coupons"] || await doc.addSheet({ title: "coupons", headerValues: ["coupon", "tg_id", "name", "created", "used"] });
  return { clients, codes, coupons };
}

// ── Утиліти ───────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10); // "2025-04-21"
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function randomCoupon() {
  return "FREE-" + Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
}

function pizzaWord(n) {
  if (n === 1) return "піца";
  if (n >= 2 && n <= 4) return "піци";
  return "піц";
}

// ── Отримати або створити денний код ──────────────────────────────────────
async function getTodayCode() {
  const { codes } = await getSheets();
  const rows = await codes.getRows();
  const today = todayStr();
  const existing = rows.find(r => r.get("date") === today);
  if (existing) return existing.get("code");

  const code = randomCode();
  await codes.addRow({ date: today, code });
  return code;
}

// ── Клієнт: отримати або зареєструвати ───────────────────────────────────
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
  await coupons.addRow({
    coupon,
    tg_id: String(tgId),
    name,
    created: todayStr(),
    used: "no",
  });
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
  if (found) {
    found.set("used", "yes");
    await found.save();
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  КОМАНДИ КЛІЄНТА
// ══════════════════════════════════════════════════════════════════════════

bot.onText(/\/start/, async (msg) => {
  const tgId = msg.from.id;
  const name = msg.from.first_name || "Гість";
  const username = msg.from.username || "";

  await getOrCreateClient(tgId, name, username);
  const count = await getClientCount(tgId);
  const remaining = 10 - (count % 10);

  bot.sendMessage(tgId,
    `👋 Привіт, ${name}!\n\n` +
    `🍕 Це бот програми лояльності *Хліб з маслом*\n` +
    `Кожна 11-а міні-піца — *безкоштовно!*\n\n` +
    `📊 Твоїх покупок: *${count}*\n` +
    `До безкоштовної: *${remaining}* ${pizzaWord(remaining)}\n\n` +
    `Отримав код від бариста? Введи:\n` +
    `👉 /code XXXXXX`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "📊 Моя статистика", callback_data: "stats" }
        ]]
      }
    }
  );
});

bot.onText(/\/code (.+)/, async (msg, match) => {
  const tgId = msg.from.id;
  const name = msg.from.first_name || "Гість";
  const inputCode = match[1].trim().toUpperCase();

  const todayCode = await getTodayCode();

  if (inputCode !== todayCode) {
    return bot.sendMessage(tgId,
      "❌ Невірний код.\n\nПопроси бариста дати код на сьогодні.",
      { parse_mode: "Markdown" }
    );
  }

  // Перевіряємо чи вже використав код сьогодні
  const { clients } = await getSheets();
  const rows = await clients.getRows();
  const clientRow = rows.find(r => r.get("tg_id") === String(tgId));
  const lastUsed = clientRow ? clientRow.get("last_used") : "";

  if (lastUsed === todayStr()) {
    return bot.sendMessage(tgId,
      "⚠️ Ти вже вводив код сьогодні.\nКожен код діє *один раз на день* для одного клієнта.",
      { parse_mode: "Markdown" }
    );
  }

  // Зараховуємо
  if (clientRow) {
    clientRow.set("last_used", todayStr());
    await clientRow.save();
  }

  const newCount = await incrementClient(tgId);
  const remaining = 10 - (newCount % 10);

  if (newCount % 10 === 0) {
    // 🎉 Безкоштовна піца!
    const coupon = await createCoupon(tgId, name);
    bot.sendMessage(tgId,
      `🎉 *Вітаємо!* Це твоя ${newCount}-а піца!\n\n` +
      `🆓 Ти отримуєш *безкоштовну міні-піцу!*\n\n` +
      `Покажи касиру цей купон:\n` +
      `🎟 \`${coupon}\`\n\n` +
      `_Купон безстроковий — не загубь!_`,
      { parse_mode: "Markdown" }
    );
  } else {
    bot.sendMessage(tgId,
      `✅ *Покупку зараховано!*\n\n` +
      `🍕 Всього піц: *${newCount}*\n` +
      `До безкоштовної ще: *${remaining}* ${pizzaWord(remaining)}\n\n` +
      `${remaining <= 3 ? "🔥 Ще трохи!" : "💪 Гарний прогрес!"}`,
      { parse_mode: "Markdown" }
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  КОМАНДИ АДМІНА
// ══════════════════════════════════════════════════════════════════════════

const ADMIN_IDS = process.env.ADMIN_IDS.split(",").map(id => id.trim());

function isAdmin(tgId) {
  return ADMIN_IDS.includes(String(tgId));
}

bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;

  bot.sendMessage(msg.chat.id,
    "👨‍💼 *Адмін-панель*\nОбери дію:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎟 Код на сьогодні", callback_data: "admin_code" }],
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

  if (result.status === "not_found") {
    return bot.sendMessage(msg.chat.id, "❌ Купон не знайдено.");
  }
  if (result.status === "used") {
    return bot.sendMessage(msg.chat.id, "⚠️ Купон вже був використаний.");
  }

  bot.sendMessage(msg.chat.id,
    `✅ Купон *дійсний*\n👤 Клієнт: *${result.name}*\n\nВидати безкоштовну піцу та закрити купон?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Так, закрити ${couponCode}`, callback_data: `use_${couponCode}` },
          { text: "❌ Скасувати", callback_data: "cancel" }
        ]]
      }
    }
  );
});

// ── Callback кнопки ───────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const tgId = query.from.id;
  const data = query.data;

  // Клієнтська статистика
  if (data === "stats") {
    const count = await getClientCount(tgId);
    const remaining = 10 - (count % 10);
    const freeEarned = Math.floor(count / 10);
    bot.editMessageText(
      `📊 *Твоя статистика*\n\n` +
      `🍕 Куплено піц: *${count}*\n` +
      `🆓 Отримано безкоштовних: *${freeEarned}*\n` +
      `До наступної: *${remaining}* ${pizzaWord(remaining)}\n\n` +
      `${remaining <= 3 ? "🔥 Ще трохи — і безкоштовна піца!" : "💪 Продовжуй!"}`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
    );
    return bot.answerCallbackQuery(query.id);
  }

  if (!isAdmin(tgId)) return bot.answerCallbackQuery(query.id);

  if (data === "admin_code") {
    const code = await getTodayCode();
    bot.editMessageText(
      `🎟 *Код на сьогодні:*\n\n` +
      `\`${code}\`\n\n` +
      `Надішли баристам — вони говорять клієнтам після купівлі піци.\n` +
      `Клієнт вводить: \`/code ${code}\``,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
    );
  }

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
      "Введи команду з купоном для перевірки:\n`/check FREE-XXXXXXXX`",
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
    );
  }

  if (data.startsWith("use_")) {
    const coupon = data.replace("use_", "");
    await markCouponUsed(coupon);
    bot.editMessageText(
      `✅ Купон \`${coupon}\` закрито.\nБезкоштовна піца видана! 🍕`,
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
//  ЩОРАНКУ О 9:01 — надсилаємо код адміну
// ══════════════════════════════════════════════════════════════════════════
cron.schedule("1 9 * * *", async () => {
  const code = await getTodayCode();
  for (const adminId of ADMIN_IDS) {
    bot.sendMessage(adminId,
      `☀️ *Доброго ранку!*\n\n` +
      `🎟 Код на сьогодні:\n\n` +
      `\`${code}\`\n\n` +
      `Передай баристам 👆\nКлієнти вводять: \`/code ${code}\``,
      { parse_mode: "Markdown" }
    );
  }
}, { timezone: "Europe/Kyiv" });

console.log("🍕 Pizza Bot запущено!");

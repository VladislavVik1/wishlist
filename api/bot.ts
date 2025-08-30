import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/** ===== ENV ===== */
const BOT_TOKEN = process.env.BOT_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing env", {
    BOT_TOKEN: !!BOT_TOKEN,
    SUPABASE_URL: !!SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
  });
  throw new Error("Missing environment variables");
}

/** ===== DB ===== */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** ===== Types & helpers ===== */
interface Member {
  id: string;
  telegram_user_id: number;
  name: string | null;
  household_id: string | null;
}

interface Household {
  id: string;
  name: string | null;
  budget_uah: number;
  invite_code: string;
  created_at: string;
}

interface Category {
  id: number;
  household_id: string;
  name: string;
  slug: string;
}

interface Item {
  id: string;
  household_id: string;
  category_id: number | null;
  title: string;
  price_uah: number;
  status: "active" | "done" | "deleted";
  created_by: number;
  created_at: string;
  updated_at: string;
}

interface PendingAdd {
  id: string;
  user_id: number;
  household_id: string;
  stage: "title" | "category" | "price";
  title?: string;
  photo_file_id?: string;
  item_id?: string;
  created_at: string;
}

const DEFAULT_CATEGORIES = [
  { name: "Места куда идти с деньгами", slug: "paid_places" },
  { name: "бесплатные места", slug: "free_places" },
  { name: "Ресторан", slug: "restaurant" },
  { name: "Поездка", slug: "trip" },
  { name: "Вещи", slug: "things" },
  { name: "Косметика", slug: "cosmetics" },
  { name: "Игры", slug: "games" },
  { name: "Страйкбол", slug: "airsoft" },
  { name: "Прочее", slug: "other" },
];

const CURRENCY = "₴";

const isPrivate = (ctx: Context) => ctx.chat?.type === "private";

const toPrice = (raw?: string) => {
  if (!raw) return null;
  const n = Number(raw.replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
};

const fmtMoney = (n: number) => `${CURRENCY}\u00A0${n.toLocaleString("ru-UA", { minimumFractionDigits: 0 })}`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));

const buildItemLine = (it: Item) =>
  `• ${it.status === "done" ? `<s>${escapeHtml(it.title)}</s>` : escapeHtml(it.title)}${it.price_uah ? ` — ${fmtMoney(it.price_uah)}` : ""} (id:${it.id.slice(0,6)})`;

const pad = (v: string, len: number) => {
  const s = v.length > len ? v.slice(0, len - 1) + "…" : v;
  return s + " ".repeat(Math.max(0, len - s.length));
};

const chunk = <T,>(arr: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function getOrCreateMember(ctx: Context): Promise<Member> {
  const uid = ctx.from!.id;
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || ctx.from?.username || null;
  const { data, error } = await supabase.from("members").select("*").eq("telegram_user_id", uid).maybeSingle();
  if (error) throw error;
  if (data) return data as Member;
  const { data: created, error: err2 } = await supabase.from("members").insert({ telegram_user_id: uid, name, household_id: null }).select("*").single();
  if (err2) throw err2;
  return created as Member;
}

async function ensureCategories(household_id: string) {
  const { data } = await supabase.from("categories").select("id").eq("household_id", household_id).limit(1);
  if (data && data.length > 0) return;
  await supabase.from("categories").insert(DEFAULT_CATEGORIES.map(c => ({ ...c, household_id })));
}

async function otherHouseholdMembers(household_id: string, me: number): Promise<Member[]> {
  const { data, error } = await supabase.from("members").select("*").eq("household_id", household_id).neq("telegram_user_id", me);
  if (error) throw error;
  return (data || []) as Member[];
}

/** ===== Keyboards ===== */
function keyboardForItem(item: Item) {
  return new InlineKeyboard()
    .text(item.status === "done" ? "↩️ Вернуть" : "✅ Готово", `toggle:${item.id}`)
    .text("✏ Цена", `hintprice:${item.id}`).row()
    .text("🗑 Удалить", `del:${item.id}`);
}

function makeCategoryKeyboardForAdd(cats: Category[], pendingId: string) {
  const kb = new InlineKeyboard();
  const chunkedCats = chunk(cats, 2);
  
  for (const row of chunkedCats) {
    for (const c of row) {
      kb.text(c.name, `addcat:${pendingId}:${c.id}`);
    }
    kb.row();
  }
  kb.text("Пропустить категорию", `addcat:${pendingId}:skip`);
  return kb;
}

function makeCategoriesMenuKeyboard(cats: Category[]) {
  const kb = new InlineKeyboard();
  const chunkedCats = chunk(cats, 2);
  
  for (const row of chunkedCats) {
    for (const c of row) {
      kb.text(c.name, `cat:${c.id}`);
    }
    kb.row();
  }
  kb.text("📋 Все", "cat:all");
  return kb;
}

function priceKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("0", `price:${itemId}:0`)
    .text("100", `price:${itemId}:100`)
    .text("200", `price:${itemId}:200`)
    .text("500", `price:${itemId}:500`).row()
    .text("1000", `price:${itemId}:1000`)
    .text("2000", `price:${itemId}:2000`)
    .text("✏ Ввести", `pricemanual:${itemId}`).row()
    .text("➡️ Пропустить", `price:${itemId}:skip`);
}

/** ===== Bot ===== */
const bot = new Bot(BOT_TOKEN);
bot.catch((e: any) => console.error("Bot error:", e.error || e));

/** --- базовые --- */
bot.command("ping", (ctx: Context) => ctx.reply("pong"));
bot.command("help", (ctx: Context) => ctx.reply("/add, /categories, /list, /budget, /setprice, /create_household, /join_household"));

bot.command("start", async (ctx: Context) => {
  if (!isPrivate(ctx)) return ctx.reply("Используйте бота в личном чате.");
  const me = await getOrCreateMember(ctx);
  if (me.household_id) {
    const { data: hh } = await supabase.from("households").select("*").eq("id", me.household_id).single();
    await ctx.reply(
      `Привет! Домохозяйство: <b>${escapeHtml(hh?.name || "Семья")}</b>\n\n` +
      `Команды:\n` +
      `/add — пошагово создать хотелку (название → категория → цена)\n` +
      `/categories — меню с категориями (кнопки)\n` +
      `/list — табличный список\n` +
      `/budget [сумма] — посмотреть/изменить бюджет\n` +
      `/setprice <id> <цена> — изменить цену\n` +
      `/help — справка`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply("Добро пожаловать! /create_household <название> или /join_household <код>");
  }
});

/** --- create/join household --- */
bot.command("create_household", async (ctx: Context) => {
  if (!isPrivate(ctx)) return;
  const me = await getOrCreateMember(ctx);
  const name = (ctx.match as string | undefined)?.trim() || null;
  if (me.household_id) return ctx.reply("Вы уже в домохозяйстве.");
  const invite_code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { data: hh, error } = await supabase.from("households").insert({ name, budget_uah: 0, invite_code }).select("*").single();
  if (error) throw error;
  await supabase.from("members").update({ household_id: hh.id }).eq("telegram_user_id", me.telegram_user_id);
  await ensureCategories(hh.id);
  await ctx.reply(`Код приглашения: <code>${invite_code}</code>\nУ Марины: /join_household ${invite_code}`, { parse_mode: "HTML" });
});

bot.command("join_household", async (ctx: Context) => {
  if (!isPrivate(ctx)) return;
  const code = ((ctx.match as string) || "").trim().toUpperCase();
  if (!code) return ctx.reply("Укажите код: /join_household ABC123");
  const me = await getOrCreateMember(ctx);
  if (me.household_id) return ctx.reply("Вы уже в домохозяйстве.");
  const { data: hh } = await supabase.from("households").select("*").eq("invite_code", code).maybeSingle();
  if (!hh) return ctx.reply("Неверный код.");
  await supabase.from("members").update({ household_id: hh.id }).eq("telegram_user_id", me.telegram_user_id);
  await ensureCategories(hh.id);
  return ctx.reply("Вы присоединились! Используйте /add и /list");
});

/** --- categories menu (кнопки + «прыжки») --- */
bot.command("categories", async (ctx: Context) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id).order("id");
  return ctx.reply("Выбери категорию:", { reply_markup: makeCategoriesMenuKeyboard((cats || []) as Category[]) });
});

/** --- budget --- */
bot.command("budget", async (ctx: Context) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const arg = ((ctx.match as string) || "").trim();
  if (!arg) {
    const { data: hh } = await supabase.from("households").select("*").eq("id", me.household_id).single();
    const { data: sumRow } = await supabase.from("items").select("price_uah").eq("household_id", me.household_id).eq("status", "active");
    const total = (sumRow || []).reduce((acc: number, r: any) => acc + (r.price_uah || 0), 0);
    return ctx.reply(`Бюджет: ${fmtMoney(hh?.budget_uah || 0)}\nАктивные: ${fmtMoney(total)}\nОстаток: ${fmtMoney((hh?.budget_uah || 0) - total)}`);
  } else {
    const num = toPrice(arg);
    if (num === null) return ctx.reply("Введите сумму: /budget 5000");
    await supabase.from("households").update({ budget_uah: num }).eq("id", me.household_id);
    return ctx.reply(`Новый бюджет: ${fmtMoney(num)}`);
  }
});

/** ========== /add — ВИЗАРД ========== */
/** Шаг 0: команда /add — создаём черновик со стадией 'title' и просим ввести название */
bot.command("add", async (ctx: Context) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");

  // чистим старые зависшие черновики пользователя
  await supabase.from("pending_adds").delete().eq("user_id", me.telegram_user_id);

  const { data: pending, error } = await supabase.from("pending_adds").insert({
    user_id: me.telegram_user_id,
    household_id: me.household_id,
    stage: "title",
  }).select("*").single();

  if (error) {
    console.error("Error creating pending add:", error);
    return ctx.reply("Произошла ошибка. Попробуйте снова.");
  }

  await ctx.reply("Введи название хотелки (можно приложить фото):", {
    reply_markup: { force_reply: true },
  });
});

/** Общий обработчик сообщений для стадий визарда (название/цена) */
bot.on("message", async (ctx: Context) => {
  if (!isPrivate(ctx)) return;
  if (!ctx.message) return; // Добавляем проверку на существование сообщения
  
  const me = await getOrCreateMember(ctx);

  // проверяем есть ли активный черновик
  const { data: pending } = await supabase
    .from("pending_adds")
    .select("*")
    .eq("user_id", me.telegram_user_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!pending) return;

  // не перехватываем команды во время визарда
  const text = ctx.message.text || "";
  if (text && text.startsWith("/")) return;

  // STAGE: title  — сохраняем название (+фото), спрашиваем категорию
  if (pending.stage === "title") {
    const title = ctx.message.caption || text || "";
    if (!title.trim()) return ctx.reply("Пустое название. Напиши текстом, например: «Кроссовки Nike».");

    const photos = ctx.message.photo;
    const photoId = photos?.length ? photos[photos.length - 1].file_id : null;

    await supabase.from("pending_adds").update({
      title: title.trim(),
      photo_file_id: photoId,
      stage: "category",
    }).eq("id", pending.id);

    const { data: cats } = await supabase
      .from("categories")
      .select("*")
      .eq("household_id", pending.household_id)
      .order("id");

      return ctx.reply(`Хотелка: <b>${escapeHtml(title.trim())}</b>\nВыбери категорию:`, {
        parse_mode: "HTML",
        reply_markup: makeCategoryKeyboardForAdd((cats || []) as Category[], pending.id),
      });
  }

  // STAGE: price — пользователь прислал текст с ценой
  if (pending.stage === "price" && pending.item_id) {
    const priceText = text || "";
    const num = toPrice(priceText);
    if (num === null) return ctx.reply("Не понял цену. Пример: 1500 или 1,500");

    await supabase.from("items").update({ price_uah: num }).eq("id", pending.item_id);
    const { data: item } = await supabase.from("items").select("*").eq("id", pending.item_id).single();

    // завершаем визард
    await supabase.from("pending_adds").delete().eq("id", pending.id);

    return ctx.reply(`Готово: ${buildItemLine(item as Item)}`, {
      parse_mode: "HTML",
      reply_markup: keyboardForItem(item as Item),
    });
  }
});

/** ========== /list — табличный вывод ========== */
bot.command("list", async (ctx: Context) => {
  try {
    const me = await getOrCreateMember(ctx);
    if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");

    const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id).order("id");
    const mapCat = new Map<number, Category>(); 
    for (const c of cats || []) mapCat.set((c as Category).id, c as Category);

    const { data: items } = await supabase
      .from("items")
      .select("*")
      .eq("household_id", me.household_id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });

    const rows = (items || []) as Item[];
    if (rows.length === 0) return ctx.reply("Пусто. Добавьте через /add");

    const NAME_W = 28, CAT_W = 14, PRICE_W = 10;
    const header = `#  ${pad("Название", NAME_W)}  ${pad("Категория", CAT_W)}  ${pad("Цена", PRICE_W)}`;
    const lines: string[] = [header];
    const limit = 60;
    
    rows.slice(0, limit).forEach((it, i) => {
      const cat = it.category_id ? mapCat.get(it.category_id)?.name || "-" : "-";
      const price = it.price_uah ? fmtMoney(it.price_uah) : "-";
      const name = it.status === "done" ? `${escapeHtml(it.title)}✓` : escapeHtml(it.title);
      lines.push(`${String(i + 1).padStart(2, " ")}. ${pad(name, NAME_W)}  ${pad(cat, CAT_W)}  ${pad(price, PRICE_W)}`);
    });
    
    if (rows.length > limit) lines.push(`... и ещё ${rows.length - limit} позиций`);

    await ctx.reply(`<pre>${lines.join("\n")}</pre>`, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Error in /list command:", error);
    await ctx.reply("Произошла ошибка при получении списка. Попробуйте позже.");
  }
});

/** ========== /list_photos — вывод с фотографиями ========== */
bot.command("list_photos", async (ctx: Context) => {
  try {
    const me = await getOrCreateMember(ctx);
    if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");

    // Получаем категории для отображения названий
    const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id).order("id");
    const mapCat = new Map<number, Category>(); 
    for (const c of cats || []) mapCat.set((c as Category).id, c as Category);

    // Получаем элементы с их изображениями
    const { data: items } = await supabase
      .from("items")
      .select("*, item_images(file_id)")
      .eq("household_id", me.household_id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });

    const rows = (items || []) as any[];
    if (rows.length === 0) return ctx.reply("Пусто. Добавьте через /add");

    // Отправляем первые 3 элементов с фото
    for (const item of rows.slice(0, 3)) {
      const hasImage = item.item_images && item.item_images.length > 0;
      const statusIcon = item.status === "done" ? "✅ " : "📝 ";
      const categoryName = item.category_id ? mapCat.get(item.category_id)?.name || "" : "";
      
      let message = `${statusIcon}<b>${escapeHtml(item.title)}</b>`;
      if (categoryName) message += `\nКатегория: ${escapeHtml(categoryName)}`;
      if (item.price_uah > 0) message += `\nЦена: ${fmtMoney(item.price_uah)}`;
      message += `\nID: <code>${item.id.slice(0, 8)}</code>`;
      
      try {
        if (hasImage) {
          await ctx.replyWithPhoto(item.item_images[0].file_id, {
            caption: message,
            parse_mode: "HTML",
            reply_markup: keyboardForItem(item)
          });
        } else {
          await ctx.reply(message, {
            parse_mode: "HTML",
            reply_markup: keyboardForItem(item)
          });
        }
        
        // Задержка между сообщениями
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error("Error sending item:", error);
        // В случае ошибки отправляем текстовый вариант
        await ctx.reply(message, {
          parse_mode: "HTML",
          reply_markup: keyboardForItem(item)
        });
      }
    }
    
    if (rows.length > 3) {
      await ctx.reply(`... и ещё ${rows.length - 3} позиций. Используйте /categories для просмотра по категориям.`);
    }
  } catch (error) {
    console.error("Error in /list_photos command:", error);
    await ctx.reply("Произошла ошибка при получении списка с фото. Попробуйте позже.");
  }
});

/** ========== callbacks ========== */
bot.on("callback_query:data", async (ctx: Context) => {
  // Проверяем наличие callbackQuery и его данных
  if (!ctx.callbackQuery?.data) return;
  
  const d = ctx.callbackQuery.data;

  // выбор категории (из визарда /add)
  if (d.startsWith("addcat:")) {
    const [, pendingId, catIdStr] = d.split(":");
    const me = await getOrCreateMember(ctx);

    const { data: pend } = await supabase.from("pending_adds").select("*").eq("id", pendingId).maybeSingle();
    if (!pend) { await ctx.answerCallbackQuery({ text: "Черновик не найден. Начните /add заново." }); return; }
    if (pend.user_id !== me.telegram_user_id) { await ctx.answerCallbackQuery({ text: "Это не ваш черновик", show_alert: true }); return; }

    const category_id = catIdStr === "skip" ? null : Number(catIdStr);

    const { data: item, error } = await supabase.from("items").insert({
      household_id: pend.household_id,
      category_id,
      title: pend.title,
      price_uah: 0,
      status: "active",
      created_by: pend.user_id,
    }).select("*").single();
    
    if (error) {
      console.error("Error creating item:", error);
      await ctx.answerCallbackQuery({ text: "Ошибка при создании" });
      return;
    }

    if (pend.photo_file_id) {
      await supabase.from("item_images").insert({ item_id: item.id, file_id: pend.photo_file_id });
    }

    // обновляем черновик -> ждём цену
    await supabase.from("pending_adds").update({ stage: "price", item_id: item.id }).eq("id", pendingId);

    // уведомим второго участника
    const others = await otherHouseholdMembers(item.household_id, pend.user_id);
    for (const m of others) {
      await bot.api.sendMessage(m.telegram_user_id, `➕ Новая хотелка: <b>${escapeHtml(item.title)}</b>`, { parse_mode: "HTML" });
    }

    await ctx.editMessageText(`Добавлено: ${buildItemLine(item as Item)}\n\nТеперь укажи цену:`, {
      parse_mode: "HTML",
      reply_markup: priceKeyboard(item.id),
    });
    return ctx.answerCallbackQuery();
  }

  // быстрый выбор цены
  if (d.startsWith("price:")) {
    const [, itemId, val] = d.split(":");
    if (val !== "skip") {
      const num = toPrice(val);
      if (num !== null) await supabase.from("items").update({ price_uah: num }).eq("id", itemId);
    }
    const { data: item } = await supabase.from("items").select("*").eq("id", itemId).single();

    // чистим черновик, если он был на стадии price
    await supabase.from("pending_adds").delete().eq("item_id", itemId);

    await ctx.editMessageText(`Готово: ${buildItemLine(item as Item)}`, {
      parse_mode: "HTML",
      reply_markup: keyboardForItem(item as Item),
    });
    return ctx.answerCallbackQuery({ text: "Сохранено" });
  }

  // ручной ввод цены (без команды) — переводим визард в stage=price и ждём текст
  if (d.startsWith("pricemanual:")) {
    const [, itemId] = d.split(":");
    await supabase.from("pending_adds").upsert(
      { user_id: ctx.from!.id, household_id: "", stage: "price", item_id: itemId } as any,
      { onConflict: "user_id" }
    );
    await ctx.answerCallbackQuery();
    return ctx.reply("Введи цену числом (пример: 1500 или 1,500):", { reply_markup: { force_reply: true } });
  }

  // меню категорий и «прыжки»
  if (d === "cat:all") {
    const me = await getOrCreateMember(ctx);
    const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id).order("id");
    await ctx.editMessageText("Выбери категорию:", { reply_markup: makeCategoriesMenuKeyboard((cats || []) as Category[]) });
    return ctx.answerCallbackQuery();
  }
  
  if (d.startsWith("cat:")) {
    const catId = Number(d.split(":")[1]);
    const me = await getOrCreateMember(ctx);
    const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id).order("id");
    const mapCat = new Map<number, Category>(); 
    for (const c of cats || []) mapCat.set((c as Category).id, c as Category);

    const { data: items } = await supabase
      .from("items").select("*")
      .eq("household_id", me.household_id)
      .eq("category_id", catId)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });

    const rows = (items || []) as Item[];
    const catName = mapCat.get(catId)?.name || "Категория";

    if (rows.length === 0) {
      await ctx.editMessageText(`В категории <b>${escapeHtml(catName)}</b> пока пусто.`, {
        parse_mode: "HTML",
        reply_markup: makeCategoriesMenuKeyboard((cats || []) as Category[]),
      });
      return ctx.answerCallbackQuery();
    }

    const NAME_W = 28, PRICE_W = 12;
    const header = `#  ${pad("Название", NAME_W)}  ${pad("Цена", PRICE_W)}`;
    const lines: string[] = [header];
    const limit = 70;
    
    rows.slice(0, limit).forEach((it, i) => {
      const price = it.price_uah ? fmtMoney(it.price_uah) : "-";
      const name = it.status === "done" ? `${escapeHtml(it.title)}✓` : escapeHtml(it.title);
      lines.push(`${String(i + 1).padStart(2, " ")}. ${pad(name, NAME_W)}  ${pad(price, PRICE_W)}`);
    });
    
    if (rows.length > limit) lines.push(`... и ещё ${rows.length - limit} позиций`);

    await ctx.editMessageText(`<b>${escapeHtml(catName)}</b>\n<pre>${lines.join("\n")}</pre>`, {
      parse_mode: "HTML",
      reply_markup: makeCategoriesMenuKeyboard((cats || []) as Category[]),
    });
    return ctx.answerCallbackQuery();
  }

  // стандартные кнопки элемента
  if (d.startsWith("toggle:")) {
    const id = d.split(":")[1];
    const { data: item } = await supabase.from("items").select("*").eq("id", id).single();
    if (!item) return ctx.answerCallbackQuery({ text: "Не найдено" });
    const newStatus = item.status === "done" ? "active" : "done";
    await supabase.from("items").update({ status: newStatus }).eq("id", id);
    await ctx.editMessageText(`Обновлено: ${buildItemLine({ ...item, status: newStatus } as Item)}`, {
      parse_mode: "HTML",
      reply_markup: keyboardForItem({ ...item, status: newStatus } as Item)
    });
    return ctx.answerCallbackQuery();
  }
  
  if (d.startsWith("del:")) {
    const id = d.split(":")[1];
    await supabase.from("items").update({ status: "deleted" }).eq("id", id);
    await ctx.editMessageText("Удалено");
    return ctx.answerCallbackQuery();
  }
  
  if (d.startsWith("hintprice:")) {
    const id = d.split(":")[1];
    await ctx.answerCallbackQuery();
    return ctx.reply(`Измени цену: отправь число, например "1500".\n(или нажми на кнопки цены)`, {
      reply_markup: priceKeyboard(id),
    });
  }
});

/** --- setprice вручную (остаётся как альтернатива) --- */
bot.command("setprice", async (ctx: Context) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const [id, priceStr] = ((ctx.match as string) || "").trim().split(/\s+/, 2);
  if (!id || !priceStr) return ctx.reply("Формат: /setprice <id> <цена>");
  const num = toPrice(priceStr);
  if (num === null) return ctx.reply("Неверная цена.");
  const { data: item } = await supabase.from("items").select("*").eq("id", id).single();
  if (!item || item.household_id !== me.household_id) return ctx.reply("Не найдено");
  await supabase.from("items").update({ price_uah: num }).eq("id", id);
  await ctx.reply(`Цена обновлена: ${fmtMoney(num)}`);
});

/** ===== Vercel handler (HTTP adapter) ===== */
const handleUpdate = webhookCallback(bot, "http");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") { 
      res.status(200).send("OK"); 
      return; 
    }
    await handleUpdate(req, res);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).send("OK");
  }
}
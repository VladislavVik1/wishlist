import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { Context } from "grammy";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/* ===== ENV ===== */
const BOT_TOKEN = process.env.BOT_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing env", {
    BOT_TOKEN: !!BOT_TOKEN,
    SUPABASE_URL: !!SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
  });
}

/* ===== DB ===== */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===== Types / helpers ===== */
type Member = { id: string; telegram_user_id: number; name: string | null; household_id: string | null };
type Household = { id: string; name: string | null; budget_uah: number; invite_code: string };
type Category = { id: number; household_id: string; name: string; slug: string };
type Item = {
  id: string; household_id: string; category_id: number | null; title: string;
  price_uah: number; status: "active" | "done" | "deleted"; created_by: number;
  created_at: string; updated_at: string;
};
type Pending = {
  id: string; user_id: number; household_id: string;
  title: string | null; photo_file_id: string | null;
  stage: "title" | "category" | "price";
  item_id: string | null;
};

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
  `• ${(it.status==="done" ? `<s>${escapeHtml(it.title)}</s>` : escapeHtml(it.title))}${it.price_uah ? ` — ${fmtMoney(it.price_uah)}` : ""} (id:${it.id.slice(0,6)})`;

/* === small helpers === */
async function getOrCreateMember(ctx: Context): Promise<Member> {
  const uid = ctx.from!.id;
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || ctx.from?.username || null;
  const { data, error } = await supabase.from("members").select("*").eq("telegram_user_id", uid).maybeSingle();
  if (error) throw error;
  if (data) return data as Member;
  const { data: created, error: err2 } = await supabase
    .from("members")
    .insert({ telegram_user_id: uid, name, household_id: null })
    .select("*").single();
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
async function getPending(uid: number): Promise<Pending | null> {
  const { data, error } = await supabase
    .from("pending_adds")
    .select("*")
    .eq("user_id", uid)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? (data[0] as Pending) : null;
}
function keyboardForItem(item: Item) {
  return new InlineKeyboard()
    .text(item.status === "done" ? "↩️ Вернуть" : "✅ Готово", `toggle:${item.id}`)
    .text("✏ Цена", `askprice:${item.id}`)
    .row()
    .text("🗑 Удалить", `del:${item.id}`);
}
async function catsKeyboard(household_id: string, item_id: string) {
  await ensureCategories(household_id);
  const { data: cats } = await supabase.from("categories").select("*").eq("household_id", household_id).order("id");
  const kb = new InlineKeyboard();
  let col = 0;
  for (const c of (cats || []) as Category[]) {
    kb.text(c.name, `setcat:${item_id}:${c.id}`);
    col++;
    if (col % 2 === 0) kb.row();
  }
  kb.row().text("💰 Ввести цену", `askprice:${item_id}`).text("✅ Готово", `finish:${item_id}`);
  return kb;
}

/* ===== Bot ===== */
const bot = new Bot(BOT_TOKEN);
bot.catch(e => console.error("Bot error:", e.error || e));

/* --- базовые команды --- */
bot.command("ping", ctx => ctx.reply("pong"));

bot.command("start", async (ctx) => {
  if (!isPrivate(ctx)) return ctx.reply("Используйте бота в личном чате.");
  const me = await getOrCreateMember(ctx);
  if (me.household_id) {
    const { data: hh } = await supabase.from("households").select("*").eq("id", me.household_id).single();
    await ctx.reply(
      `Привет! Домохозяйство: <b>${escapeHtml(hh?.name || "Семья")}</b>\n\n` +
      `Команды:\n` +
      `/add — добавить хотелку (пошагово)\n` +
      `/list [категория] — список\n` +
      `/budget [сумма] — бюджет\n` +
      `/categories — показать категории\n` +
      `/setprice <id> <цена> — изменить цену (на всякий случай)\n` +
      `/help — справка`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply("Добро пожаловать! /create_household <название> или /join_household <код>");
  }
});

bot.command("help", (ctx) => ctx.reply("/add, /list, /budget, /categories, /setprice, /create_household, /join_household"));

bot.command("create_household", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const me = await getOrCreateMember(ctx);
  const name = (ctx.match as string | undefined)?.trim() || null;
  if (me.household_id) return ctx.reply("Вы уже в домохозяйстве.");
  const invite_code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { data: hh, error } = await supabase.from("households").insert({ name, budget_uah: 0, invite_code }).select("*").single();
  if (error) throw error;
  await supabase.from("members").update({ household_id: hh.id }).eq("telegram_user_id", me.telegram_user_id);
  await ensureCategories(hh.id);
  await ctx.reply(`Код приглашения: <code>${invite_code}</code>\nПусть Марина отправит: /join_household ${invite_code}`, { parse_mode: "HTML" });
});

bot.command("join_household", async (ctx) => {
  if (!isPrivate(ctx)) return;
  const code = ((ctx.match as string) || "").trim().toUpperCase();
  if (!code) return ctx.reply("Укажи код: /join_household ABC123");
  const me = await getOrCreateMember(ctx);
  if (me.household_id) return ctx.reply("Ты уже в домохозяйстве.");
  const { data: hh } = await supabase.from("households").select("*").eq("invite_code", code).maybeSingle();
  if (!hh) return ctx.reply("Неверный код.");
  await supabase.from("members").update({ household_id: hh.id }).eq("telegram_user_id", me.telegram_user_id);
  await ensureCategories(hh.id);
  return ctx.reply("Готово! Добавляй хотелки через /add");
});

bot.command("categories", async (ctx) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const { data: cats } = await supabase.from("categories").select("name, slug").eq("household_id", me.household_id).order("id");
  const txt = (cats || []).map((c: any) => `• ${c.name} (${c.slug})`).join("\n");
  return ctx.reply(txt || "Категории не найдены");
});

bot.command("budget", async (ctx) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const arg = ((ctx.match as string) || "").trim();
  if (!arg) {
    const { data: hh } = await supabase.from("households").select("*").eq("id", me.household_id).single();
    const { data: sumRow } = await supabase.from("items").select("price_uah").eq("household_id", me.household_id).eq("status", "active");
    const total = (sumRow || []).reduce((acc: number, r: any) => acc + (r.price_uah || 0), 0);
    return ctx.reply(
      `Бюджет: ${fmtMoney(hh?.budget_uah || 0)}\n` +
      `Активные хотелки: ${fmtMoney(total)}\n` +
      `Остаток: ${fmtMoney((hh?.budget_uah || 0) - total)}`
    );
  } else {
    const num = toPrice(arg);
    if (num === null) return ctx.reply("Введи сумму: /budget 5000");
    await supabase.from("households").update({ budget_uah: num }).eq("id", me.household_id);
    return ctx.reply(`Новый бюджет: ${fmtMoney(num)}`);
  }
});

/* ====== НОВОЕ: пошаговый /add ====== */
bot.command("add", async (ctx) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");

  // очищаем старые незавершённые черновики
  await supabase.from("pending_adds").delete().eq("user_id", ctx.from!.id);

  await supabase.from("pending_adds").insert({
    user_id: ctx.from!.id,
    household_id: me.household_id,
    stage: "title",
    title: null,
    photo_file_id: null,
    item_id: null,
  });

  await ctx.reply("Введи название хотелки (можно приложить фото):");
});

// этот хэндлер ловит любые сообщения от пользователя и двигает «визард»
bot.on("message", async (ctx) => {
  if (!isPrivate(ctx)) return;

  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return; // на всякий случай

  const pending = await getPending(ctx.from!.id);
  if (!pending) return; // нет активного визарда — игнорим

  // название / фото
  if (pending.stage === "title") {
    const title = (ctx.message as any).text || (ctx.message as any).caption;
    const photos = (ctx.message as any).photo as Array<{ file_id: string }> | undefined;

    if (!title) {
      await ctx.reply("Нужно ввести название текстом 🙂");
      return;
    }

    // создаём item
    const { data: item, error } = await supabase.from("items").insert({
      household_id: me.household_id,
      category_id: null,
      title,
      price_uah: 0,
      status: "active",
      created_by: me.telegram_user_id,
    }).select("*").single();
    if (error) throw error;

    if (photos?.length) {
      const best = photos[photos.length - 1];
      await supabase.from("item_images").insert({ item_id: item.id, file_id: best.file_id });
    }

    await supabase.from("pending_adds").update({ stage: "category", item_id: item.id }).eq("id", pending.id);

    await ctx.reply("Выбери категорию:", {
      reply_markup: await catsKeyboard(me.household_id!, item.id),
    });

    return;
  }

  // ввод цены цифрой (после нажатия кнопки «Ввести цену»)
  if (pending.stage === "price") {
    const text = (ctx.message as any).text || "";
    const price = toPrice(text);
    if (price === null) {
      await ctx.reply("Пришли только число, например 1500");
      return;
    }

    if (!pending.item_id) {
      // что-то пошло не так — сносим черновик
      await supabase.from("pending_adds").delete().eq("id", pending.id);
      await ctx.reply("Попробуй ещё раз: /add");
      return;
    }

    await supabase.from("items").update({ price_uah: price }).eq("id", pending.item_id);
    const { data: item2 } = await supabase.from("items").select("*").eq("id", pending.item_id).single();

    // уведомления второму участнику
    const others = await otherHouseholdMembers(me.household_id!, me.telegram_user_id);
    for (const m of others) {
      await bot.api.sendMessage(m.telegram_user_id, `✏ Цена обновлена: <b>${escapeHtml(item2!.title)}</b> — ${fmtMoney(price)}`, { parse_mode: "HTML" });
    }

    await supabase.from("pending_adds").delete().eq("id", pending.id);
    await ctx.reply(`Готово: ${buildItemLine(item2 as Item)}`, { parse_mode: "HTML", reply_markup: keyboardForItem(item2 as Item) });
  }
});

/* ====== callback-кнопки: категории/цена/завершение ====== */
bot.on("callback_query:data", async (ctx) => {
  const d = ctx.callbackQuery.data;
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return;

  if (d.startsWith("setcat:")) {
    const [, item_id, cat_id] = d.split(":");
    await supabase.from("items").update({ category_id: Number(cat_id) }).eq("id", item_id);
    await ctx.answerCallbackQuery({ text: "Категория назначена" });
    return;
  }

  if (d.startsWith("askprice:")) {
    const item_id = d.split(":")[1];
    const pending = await getPending(ctx.from!.id);
    if (pending) {
      await supabase.from("pending_adds").update({ stage: "price", item_id }).eq("id", pending.id);
    } else {
      // если визарда нет (редкий кейс) — создаём
      await supabase.from("pending_adds").insert({
        user_id: ctx.from!.id,
        household_id: me.household_id,
        stage: "price",
        title: null,
        photo_file_id: null,
        item_id,
      });
    }
    await ctx.answerCallbackQuery();
    await ctx.reply("Введи цену числом (например 1200)");
    return;
  }

  if (d.startsWith("finish:")) {
    const item_id = d.split(":")[1];
    await supabase.from("pending_adds").delete().eq("user_id", ctx.from!.id);
    const { data: item } = await supabase.from("items").select("*").eq("id", item_id).single();
    await ctx.answerCallbackQuery();
    await ctx.reply(`Добавлено: ${buildItemLine(item as Item)}`, { parse_mode: "HTML", reply_markup: keyboardForItem(item as Item) });
    return;
  }

  // старые кнопки
  if (d.startsWith("toggle:")) {
    const id = d.split(":")[1];
    const { data: item } = await supabase.from("items").select("*").eq("id", id).single();
    if (!item) return ctx.answerCallbackQuery({ text: "Не найдено" });
    const newStatus = item.status === "done" ? "active" : "done";
    await supabase.from("items").update({ status: newStatus }).eq("id", id);
    await ctx.editMessageText(`Обновлено: ${buildItemLine({ ...item, status: newStatus } as Item)}`, {
      parse_mode: "HTML",
      reply_markup: keyboardForItem({ ...item, status: newStatus } as Item),
    });
    return ctx.answerCallbackQuery();
  }
  if (d.startsWith("del:")) {
    const id = d.split(":")[1];
    await supabase.from("items").update({ status: "deleted" }).eq("id", id);
    await ctx.editMessageText("Удалено");
    return ctx.answerCallbackQuery();
  }
});

/* ===== Список ===== */
bot.command("list", async (ctx) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const filter = ((ctx.match as string) || "").trim().toLowerCase();

  const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id).order("id");
  const mapCat = new Map<number, Category>(); for (const c of cats || []) mapCat.set((c as Category).id, c as Category);

  const { data: items } = await supabase
    .from("items")
    .select("*")
    .eq("household_id", me.household_id)
    .neq("status", "deleted")
    .order("created_at", { ascending: false });

  const rows = (items || []) as Item[];
  const filtered = !filter ? rows : rows.filter((it) => {
    const cat = it.category_id ? mapCat.get(it.category_id) : null;
    return (cat && (cat.name.toLowerCase().includes(filter) || cat.slug.toLowerCase().includes(filter))) || it.title.toLowerCase().includes(filter);
  });

  if (filtered.length === 0) return ctx.reply("Пусто. Добавь через /add");

  // Группировка по категориям
  const byCat = new Map<string, Item[]>();
  for (const it of filtered) {
    const catName = it.category_id ? mapCat.get(it.category_id)?.name || "Без категории" : "Без категории";
    if (!byCat.has(catName)) byCat.set(catName, []);
    byCat.get(catName)!.push(it);
  }

  let out = "";
  for (const [catName, itemsIn] of byCat) {
    out += `\n<b>${escapeHtml(catName)}</b>\n`;
    for (const it of itemsIn) {
      out += `${buildItemLine(it)}\n`;
    }
  }
  await ctx.reply(out.trim(), { parse_mode: "HTML" });
});

/* ===== Vercel handler ===== */
const handleUpdate = webhookCallback(bot, "http");
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") { res.status(200).send("OK"); return; }
    await handleUpdate(req as any, res as any);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).send("OK");
  }
}

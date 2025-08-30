import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { Context } from "grammy";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing env", { BOT_TOKEN: !!BOT_TOKEN, SUPABASE_URL: !!SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY });
}

// ===== DB =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== Types / helpers =====
type Member = { id: string; telegram_user_id: number; name: string | null; household_id: string | null };
type Household = { id: string; name: string | null; budget_uah: number; invite_code: string };
type Category = { id: number; household_id: string; name: string; slug: string };
type Item = { id: string; household_id: string; category_id: number | null; title: string; price_uah: number; status: "active" | "done" | "deleted"; created_by: number; created_at: string; updated_at: string; };

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
const toPrice = (raw?: string) => { if (!raw) return null; const n = Number(raw.replace(/\s+/g, "").replace(",", ".")); return Number.isFinite(n) ? Number(n.toFixed(2)) : null; };
const fmtMoney = (n: number) => `${CURRENCY}\u00A0${n.toLocaleString("ru-UA", { minimumFractionDigits: 0 })}`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
const buildItemLine = (it: Item) => `• ${(it.status==="done" ? `<s>${escapeHtml(it.title)}</s>` : escapeHtml(it.title))}${it.price_uah ? ` — ${fmtMoney(it.price_uah)}` : ""} (id:${it.id.slice(0,6)})`;

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

// ===== Bot =====
const bot = new Bot(BOT_TOKEN);
bot.catch(e => console.error("Bot error:", e.error || e));
bot.command("ping", ctx => ctx.reply("pong"));
bot.command("health", async (ctx) => {
  try { const { error } = await supabase.from("households").select("id", { head:true, count:"exact" }).limit(1); if (error) throw error; await ctx.reply("Supabase: OK"); }
  catch (e:any){ console.error("Supabase health error:", e); await ctx.reply("Supabase error: " + (e?.message || e)); }
});

bot.command("start", async (ctx) => {
  if (!isPrivate(ctx)) return ctx.reply("Используйте бота в личном чате.");
  const me = await getOrCreateMember(ctx);
  if (me.household_id) {
    const { data: hh } = await supabase.from("households").select("*").eq("id", me.household_id).single();
    await ctx.reply(
      `Привет! Домохозяйство: <b>${escapeHtml(hh?.name || "Семья")}</b>\n\n` +
      `/add <категория> <цена> <название>\n/list [категория]\n/budget [сумма]\n/categories\n/setprice <id> <цена>\n/help`,
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
  await ctx.reply(`Код приглашения: <code>${invite_code}</code>\nУ Марины: /join_household ${invite_code}`, { parse_mode: "HTML" });
});

bot.command("join_household", async (ctx) => {
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
    return ctx.reply(`Бюджет: ${fmtMoney(hh?.budget_uah || 0)}\nАктивные: ${fmtMoney(total)}\nОстаток: ${fmtMoney((hh?.budget_uah || 0) - total)}`);
  } else {
    const num = toPrice(arg);
    if (num === null) return ctx.reply("Введите сумму: /budget 5000");
    await supabase.from("households").update({ budget_uah: num }).eq("id", me.household_id);
    return ctx.reply(`Новый бюджет: ${fmtMoney(num)}`);
  }
});

bot.command("add", async (ctx) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const text = (ctx.message as any)?.caption || (ctx.message as any)?.text || "";
  const rest = text.replace(/^\/add\s*/i, "").trim();
  if (!rest) return ctx.reply("Формат: /add <категория> <цена?> <название>\nПример: /add Вещи 1500 Кроссовки", { parse_mode: "HTML" });

  const parts = rest.split(/\s+/);
  const catName = parts.shift()!;
  let price: number | null = null;
  if (parts.length) { const p = toPrice(parts[0]); if (p !== null) { price = p; parts.shift(); } }
  const title = parts.join(" ").trim();
  if (!title) return ctx.reply("Укажите название хотелки после категории и (опционально) цены.");

  const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id);
  const cat = (cats || []).find((c: any) => [c.name.toLowerCase(), c.slug.toLowerCase()].includes(catName.toLowerCase()));
  const category_id = cat ? (cat as Category).id : null;

  const { data: item, error } = await supabase.from("items").insert({
    household_id: me.household_id, category_id, title, price_uah: price || 0, status: "active", created_by: me.telegram_user_id
  }).select("*").single();
  if (error) throw error;

  const photos = (ctx.message as any)?.photo as Array<{ file_id: string }> | undefined;
  if (photos?.length) {
    const best = photos[photos.length - 1];
    await supabase.from("item_images").insert({ item_id: item.id, file_id: best.file_id });
  }

  const others = await otherHouseholdMembers(me.household_id, me.telegram_user_id);
  for (const m of others) {
    await bot.api.sendMessage(m.telegram_user_id, `➕ Новая хотелка: <b>${escapeHtml(title)}</b>${price ? " — " + fmtMoney(price) : ""}`, { parse_mode: "HTML" });
  }

  await ctx.reply(`Добавлено: ${buildItemLine(item as Item)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ Готово", `toggle:${(item as Item).id}`).text("✏ Цена", `hintprice:${(item as Item).id}`).row().text("🗑 Удалить", `del:${(item as Item).id}`) });
});

bot.command("list", async (ctx) => {
  const me = await getOrCreateMember(ctx);
  if (!me.household_id) return ctx.reply("Сначала /create_household или /join_household");
  const filter = ((ctx.match as string) || "").trim().toLowerCase();

  const { data: cats } = await supabase.from("categories").select("*").eq("household_id", me.household_id).order("id");
  const mapCat = new Map<number, Category>(); for (const c of cats || []) mapCat.set((c as Category).id, c as Category);

  const { data: items } = await supabase.from("items").select("*").eq("household_id", me.household_id).neq("status", "deleted").order("created_at", { ascending: false });
  const rows = (items || []) as Item[];

  const filtered = !filter ? rows : rows.filter((it) => {
    const cat = it.category_id ? mapCat.get(it.category_id) : null;
    return (cat && (cat.name.toLowerCase().includes(filter) || cat.slug.toLowerCase().includes(filter))) || it.title.toLowerCase().includes(filter);
  });

  if (filtered.length === 0) return ctx.reply("Пусто. Добавьте через /add");

  const totalActive = filtered.filter(i => i.status === "active").reduce((s, i) => s + (i.price_uah || 0), 0);
  const lines = filtered.map(buildItemLine).join("\n");
  await ctx.reply(`Список (активные: ${fmtMoney(totalActive)}):\n${lines}`, { parse_mode: "HTML" });
});

bot.command("setprice", async (ctx) => {
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

bot.on("callback_query:data", async (ctx) => {
  const d = ctx.callbackQuery.data;
  if (d.startsWith("toggle:")) {
    const id = d.split(":")[1];
    const { data: item } = await supabase.from("items").select("*").eq("id", id).single();
    if (!item) return ctx.answerCallbackQuery({ text: "Не найдено" });
    const newStatus = item.status === "done" ? "active" : "done";
    await supabase.from("items").update({ status: newStatus }).eq("id", id);
    await ctx.editMessageText(`Обновлено: ${buildItemLine({ ...item, status: newStatus } as Item)}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(newStatus==="done"?"↩️ Вернуть":"✅ Готово", `toggle:${id}`).text("✏ Цена", `hintprice:${id}`).row().text("🗑 Удалить", `del:${id}`) });
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
    return ctx.reply(`Изменить цену: /setprice ${id} 1234`);
  }
});

// ===== Vercel handler (HTTP adapter) =====
const handleUpdate = webhookCallback(bot, "http"); // <— ВАЖНО

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") { res.status(200).send("OK"); return; }
    await handleUpdate(req as any, res as any);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).send("OK");
  }
}

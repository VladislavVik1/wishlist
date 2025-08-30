import { Bot, Context, InlineKeyboard, webhookCallback, InputMediaPhoto } from "grammy";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const logger = {
  info: (message: string, data?: any) => 
    console.log(JSON.stringify({ level: "INFO", message, data })),
  error: (message: string, error?: any) => 
    console.error(JSON.stringify({ level: "ERROR", message, error }))
};

/** ===== ENV ===== */
const BOT_TOKEN = process.env.BOT_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

interface PendingEdit {
  id: string;
  user_id: number;
  item_id: string;
  field: "title" | "category" | "price" | "photo";
  created_at: string;
}

interface ItemImage {
  id: string;
  item_id: string;
  file_id: string;
  created_at: string;
}

interface ItemWithRelations extends Item {
  categories: { name: string } | null;
  item_images: ItemImage[];
}

const DEFAULT_CATEGORIES = [
  { name: "Места куда идти с деньгами", slug: "paid_places" },
  { name: "бесплатные места", slug: "free_places" },
  { name: "Ресторан", slug: "restaurant" },
  { name: "Поездка", slug: "trip" },
  { name: "Веси", slug: "things" },
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
  try {
    if (!ctx.from) throw new Error("User not found in context");
    
    const uid = ctx.from.id;
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || ctx.from?.username || null;
    
    const { data, error } = await supabase.from("members").select("*").eq("telegram_user_id", uid).maybeSingle();
    if (error) {
      logger.error("Error getting member", error);
      throw error;
    }
    
    if (data) return data as Member;
    
    const { data: created, error: err2 } = await supabase.from("members")
      .insert({ telegram_user_id: uid, name, household_id: null })
      .select("*")
      .single();
      
    if (err2) {
      logger.error("Error creating member", err2);
      throw err2;
    }
    
    return created as Member;
  } catch (error) {
    logger.error("Error in getOrCreateMember", error);
    throw error;
  }
}

async function ensureCategories(household_id: string) {
  try {
    const { data } = await supabase.from("categories").select("id").eq("household_id", household_id).limit(1);
    if (data && data.length > 0) return;
    await supabase.from("categories").insert(DEFAULT_CATEGORIES.map(c => ({ ...c, household_id })));
  } catch (error) {
    logger.error("Error ensuring categories", error);
    throw error;
  }
}

async function otherHouseholdMembers(household_id: string, me: number): Promise<Member[]> {
  try {
    const { data, error } = await supabase.from("members").select("*").eq("household_id", household_id).neq("telegram_user_id", me);
    if (error) {
      logger.error("Error getting other household members", error);
      throw error;
    }
    return (data || []) as Member[];
  } catch (error) {
    logger.error("Error in otherHouseholdMembers", error);
    throw error;
  }
}

/** ===== Keyboards ===== */
function mainMenuKeyboard() {
  return new InlineKeyboard()
    .text("➕ Добавить хотелку", "add_item")
    .text("📋 Список хотелок", "list_items").row()
    .text("🏷 Категории", "categories")
    .text("💰 Бюджет", "budget").row()
    .text("🔄 Обновить меню", "refresh_menu");
}

function keyboardForItem(item: Item, isDetailed: boolean = false) {
  const keyboard = new InlineKeyboard();
  
  if (isDetailed) {
    keyboard
      .text("✏️ Название", `edit_title:${item.id}`)
      .text("✏️ Категория", `edit_category:${item.id}`).row()
      .text("✏️ Цена", `edit_price:${item.id}`)
      .text("🖼 Фото", `edit_photo:${item.id}`).row()
      .text(item.status === "done" ? "↩️ Вернуть" : "✅ Готово", `toggle:${item.id}`)
      .text("🗑 Удалить", `del:${item.id}`).row()
      .text("⬅️ Назад", `back_to_list`);
  } else {
    keyboard
      .text(item.status === "done" ? "↩️ Вернуть" : "✅ Готово", `toggle:${item.id}`)
      .text("✏️ Редакт.", `edit:${item.id}`).row()
      .text("🗑 Удалить", `del:${item.id}`);
  }
  
  return keyboard;
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

function editPhotoKeyboard(itemId: string, hasPhotos: boolean) {
  const kb = new InlineKeyboard();
  
  kb.text("➕ Добавить фото", `add_photo:${itemId}`).row();
  
  if (hasPhotos) {
    kb
      .text("👀 Просмотреть фото", `view_photos:${itemId}`)
      .text("🗑 Удалить фото", `delete_photos:${itemId}`).row();
  }
  
  kb.text("⬅️ Назад", `edit:${itemId}`);
  return kb;
}

/** ===== Bot ===== */
const bot = new Bot(BOT_TOKEN);
bot.catch((e: any) => logger.error("Bot error:", e.error || e));

/** --- Главное меню --- */
bot.command("start", async (ctx: Context) => {
  try {
    if (!isPrivate(ctx)) return ctx.reply("Используйте бота в личном чате.");
    const me = await getOrCreateMember(ctx);
    
    if (me.household_id) {
      const { data: hh } = await supabase.from("households").select("*").eq("id", me.household_id).single();
      await ctx.reply(
        `Привет! Домохозяйство: <b>${escapeHtml(hh?.name || "Семья")}</b>\n\n` +
        `Используй меню ниже для управления хотелками:`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
      );
    } else {
      await ctx.reply(
        "Добро пожаловать! Создайте домохозяйство или присоединитесь к существующему:",
        { reply_markup: new InlineKeyboard()
          .text("🏠 Создать домохозяйство", "create_household")
          .text("🔗 Присоединиться", "join_household")
        }
      );
    }
  } catch (error) {
    logger.error("Error in start command", error);
    await ctx.reply("Произошла ошибка. Попробуйте позже.");
  }
});

bot.callbackQuery("refresh_menu", async (ctx: Context) => {
  try {
    await ctx.editMessageText("Главное меню:", { reply_markup: mainMenuKeyboard() });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error refreshing menu", error);
    await ctx.answerCallbackQuery({ text: "Ошибка обновления меню" });
  }
});

/** --- create/join household --- */
bot.callbackQuery("create_household", async (ctx: Context) => {
  try {
    await ctx.reply("Введите название домохозяйства:");
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in create_household callback", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

bot.callbackQuery("join_household", async (ctx: Context) => {
  try {
    await ctx.reply("Введите код приглашения:");
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in join_household callback", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

bot.on("message", async (ctx: Context) => {
  try {
    if (!isPrivate(ctx)) return;
    if (!ctx.message || !ctx.from) return;
    
    const text = ctx.message.text || "";
    
    // Обработка создания домохозяйства
    if (text && !text.startsWith("/")) {
      const me = await getOrCreateMember(ctx);
      
      // Проверяем, есть ли pending операция
      const { data: pendingHousehold } = await supabase
        .from("pending_household")
        .select("*")
        .eq("user_id", me.telegram_user_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (pendingHousehold) {
        if (pendingHousehold.type === "create") {
          const name = text.trim();
          const invite_code = Math.random().toString(36).slice(2, 8).toUpperCase();
          
          const { data: hh, error } = await supabase.from("households")
            .insert({ name, budget_uah: 0, invite_code })
            .select("*")
            .single();
            
          if (error) throw error;
          
          await supabase.from("members")
            .update({ household_id: hh.id })
            .eq("telegram_user_id", me.telegram_user_id);
            
          await ensureCategories(hh.id);
          await supabase.from("pending_household").delete().eq("id", pendingHousehold.id);
          
          await ctx.reply(
            `Домохозяйство "${name}" создано!\nКод приглашения: <code>${invite_code}</code>\n\nПоделитесь этим кодом с женой.`,
            { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
          );
          return;
        } else if (pendingHousehold.type === "join") {
          const code = text.trim().toUpperCase();
          const { data: hh } = await supabase.from("households")
            .select("*")
            .eq("invite_code", code)
            .maybeSingle();
            
          if (!hh) {
            await ctx.reply("Неверный код. Попробуйте еще раз:");
            return;
          }
          
          await supabase.from("members")
            .update({ household_id: hh.id })
            .eq("telegram_user_id", me.telegram_user_id);
            
          await ensureCategories(hh.id);
          await supabase.from("pending_household").delete().eq("id", pendingHousehold.id);
          
          await ctx.reply(
            `Вы присоединились к домохозяйству "${hh.name}"!`,
            { reply_markup: mainMenuKeyboard() }
          );
          return;
        }
      }
    }
    
    // Остальная обработка сообщений...
    const me = await getOrCreateMember(ctx);

    // проверяем есть ли активный черновик
    const { data: pending } = await supabase
      .from("pending_adds")
      .select("*")
      .eq("user_id", me.telegram_user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!pending) {
      // Проверяем pending редактирования
      const { data: pendingEdit } = await supabase
        .from("pending_edits")
        .select("*")
        .eq("user_id", me.telegram_user_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
        
      if (pendingEdit) {
        switch (pendingEdit.field) {
          case "title":
            await supabase
              .from("items")
              .update({ title: text })
              .eq("id", pendingEdit.item_id);
            await ctx.reply("Название обновлено!");
            break;
          case "price":
            const num = toPrice(text);
            if (num === null) {
              await ctx.reply("Неверная цена. Попробуйте еще раз:");
              return;
            }
            await supabase
              .from("items")
              .update({ price_uah: num })
              .eq("id", pendingEdit.item_id);
            await ctx.reply(`Цена обновлена: ${fmtMoney(num)}`);
            break;
        }
        
        await supabase.from("pending_edits").delete().eq("id", pendingEdit.id);
        return;
      }
      
      return;
    }

    // не перехватываем команды во время визард
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
  } catch (error) {
    logger.error("Error in message handler", error);
    await ctx.reply("Произошла ошибка при обработке сообщения. Попробуйте позже.");
  }
});

/** --- Добавление хотелки через меню --- */
bot.callbackQuery("add_item", async (ctx: Context) => {
  try {
    const me = await getOrCreateMember(ctx);
    if (!me.household_id) {
      await ctx.answerCallbackQuery({ text: "Сначала создайте или присоединитесь к домохозяйству" });
      return;
    }

    // чистим старые зависшие черновики пользователя
    await supabase.from("pending_adds").delete().eq("user_id", me.telegram_user_id);

    const { data: pending, error } = await supabase.from("pending_adds").insert({
      user_id: me.telegram_user_id,
      household_id: me.household_id,
      stage: "title",
    }).select("*").single();

    if (error) {
      logger.error("Error creating pending add:", error);
      await ctx.answerCallbackQuery({ text: "Ошибка при создании" });
      return;
    }

    await ctx.reply("Введи название хотелки (можно приложить фото):", {
      reply_markup: { force_reply: true },
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in add_item callback", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

/** --- Просмотр списка хотелок --- */
bot.callbackQuery("list_items", async (ctx: Context) => {
  try {
    const me = await getOrCreateMember(ctx);
    if (!me.household_id) {
      await ctx.answerCallbackQuery({ text: "Сначала создайте или присоединитесь к домохозяйству" });
      return;
    }

    // Получаем элементы с их изображениями и категориями
    const { data: items, error } = await supabase
      .from("items")
      .select(`
        *,
        categories:category_id(name),
        item_images(file_id)
      `)
      .eq("household_id", me.household_id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });

    if (error) {
      logger.error("Error fetching items:", error);
      await ctx.answerCallbackQuery({ text: "Ошибка при получении данных" });
      return;
    }

    const rows = (items || []) as ItemWithRelations[];
    if (rows.length === 0) {
      await ctx.editMessageText("Пусто. Добавьте хотелки через меню.", {
        reply_markup: new InlineKeyboard().text("➕ Добавить", "add_item").row().text("⬅️ Назад", "refresh_menu")
      });
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.editMessageText(`Найдено хотелок: ${rows.length}\nВыберите действие:`, {
      reply_markup: new InlineKeyboard()
        .text("📋 Показать все", "show_all_items")
        .text("🏷 По категориям", "categories")
        .row()
        .text("⬅️ Назад", "refresh_menu")
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in list_items callback", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

bot.callbackQuery("show_all_items", async (ctx: Context) => {
  try {
    const me = await getOrCreateMember(ctx);
    const { data: items } = await supabase
      .from("items")
      .select(`
        *,
        categories:category_id(name),
        item_images(file_id)
      `)
      .eq("household_id", me.household_id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });

    const rows = (items || []) as ItemWithRelations[];
    
    for (const item of rows) {
      const categoryName = item.categories?.name || "Без категории";
      const statusIcon = item.status === "done" ? "✅ " : "📝 ";
      const price = item.price_uah > 0 ? `Цена: ${fmtMoney(item.price_uah)}` : "Цена не указана";
      
      let message = `${statusIcon}<b>${escapeHtml(item.title)}</b>\n`;
      message += `Категория: ${escapeHtml(categoryName)}\n`;
      message += `${price}\n`;
      message += `ID: <code>${item.id.slice(0, 8)}</code>`;
      
      try {
        if (item.item_images && item.item_images.length > 0) {
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
        
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        logger.error("Error sending item:", error);
        await ctx.reply(message, {
          parse_mode: "HTML",
          reply_markup: keyboardForItem(item)
        });
      }
    }
    
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in show_all_items callback", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

/** --- Редактирование хотелок --- */
bot.callbackQuery(/edit:.+/, async (ctx: Context) => {
  try {
    if (!ctx.callbackQuery?.data) {
      await ctx.answerCallbackQuery({ text: "Ошибка: данные не получены" });
      return;
    }
    
    const itemId = ctx.callbackQuery.data.split(':')[1];
    const { data: item } = await supabase
      .from('items')
      .select('*, categories(name), item_images(file_id)')
      .eq('id', itemId)
      .single();

    if (!item) {
      await ctx.answerCallbackQuery({ text: "Элемент не найден" });
      return;
    }

    const message = `📝 Редактирование: ${escapeHtml(item.title)}\n\n` +
                   `🏷 Категория: ${item.categories?.name || 'Не указана'}\n` +
                   `💰 Цена: ${item.price_uah ? fmtMoney(item.price_uah) : 'Не указана'}\n` +
                   `📸 Фото: ${item.item_images.length > 0 ? item.item_images.length : 'Нет'}`;

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: keyboardForItem(item, true)
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error('Error in edit handler', error);
    await ctx.answerCallbackQuery({ text: 'Ошибка при редактировании' });
  }
});

bot.callbackQuery(/edit_title:.+/, async (ctx: Context) => {
  try {
    if (!ctx.callbackQuery?.data) {
      await ctx.answerCallbackQuery({ text: "Ошибка: данные не получены" });
      return;
    }
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: "Ошибка: пользователь не определен" });
      return;
    }
    
    const itemId = ctx.callbackQuery.data.split(':')[1];
    
    // Создаем pending edit запись
    await supabase.from('pending_edits').insert({
      user_id: ctx.from.id,
      item_id: itemId,
      field: 'title'
    });

    await ctx.reply('Введите новое название:', { 
      reply_markup: { force_reply: true } 
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error('Error in edit_title handler', error);
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
});

bot.callbackQuery(/edit_price:.+/, async (ctx: Context) => {
  try {
    if (!ctx.callbackQuery?.data) {
      await ctx.answerCallbackQuery({ text: "Ошибка: данные не получены" });
      return;
    }
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: "Ошибка: пользователь не определен" });
      return;
    }
    
    const itemId = ctx.callbackQuery.data.split(':')[1];
    
    // Создаем pending edit запись
    await supabase.from('pending_edits').insert({
      user_id: ctx.from.id,
      item_id: itemId,
      field: 'price'
    });

    await ctx.reply('Введите новую цену:', { 
      reply_markup: { force_reply: true } 
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error('Error in edit_price handler', error);
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
});

bot.callbackQuery(/edit_photo:.+/, async (ctx: Context) => {
  try {
    if (!ctx.callbackQuery?.data) {
      await ctx.answerCallbackQuery({ text: "Ошибка: данные не получены" });
      return;
    }
    
    const itemId = ctx.callbackQuery.data.split(':')[1];
    const { data: photos } = await supabase
      .from('item_images')
      .select('*')
      .eq('item_id', itemId);

    await ctx.editMessageText("Управление фотографиями:", {
      reply_markup: editPhotoKeyboard(itemId, (photos?.length || 0) > 0)
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error('Error in edit_photo handler', error);
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
});

bot.callbackQuery(/add_photo:.+/, async (ctx: Context) => {
  try {
    if (!ctx.callbackQuery?.data) {
      await ctx.answerCallbackQuery({ text: "Ошибка: данные не получены" });
      return;
    }
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: "Ошибка: пользователь не определен" });
      return;
    }
    
    const itemId = ctx.callbackQuery.data.split(':')[1];
    
    // Создаем pending edit запись
    await supabase.from('pending_edits').insert({
      user_id: ctx.from.id,
      item_id: itemId,
      field: 'photo'
    });

    await ctx.reply('Пришлите фото для добавления:', { 
      reply_markup: { force_reply: true } 
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error('Error in add_photo handler', error);
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
});

bot.callbackQuery(/view_photos:.+/, async (ctx: Context) => {
  try {
    if (!ctx.callbackQuery?.data) {
      await ctx.answerCallbackQuery({ text: "Ошибка: данные не получены" });
      return;
    }
    
    const itemId = ctx.callbackQuery.data.split(':')[1];
    const { data: photos } = await supabase
      .from('item_images')
      .select('file_id')
      .eq('item_id', itemId);

    if (photos && photos.length > 0) {
      // Правильно типизируем медиа объекты
      const media: InputMediaPhoto[] = photos.map(photo => ({
        type: 'photo',
        media: photo.file_id
      } as InputMediaPhoto));
      
      await ctx.replyWithMediaGroup(media);
      
      // Отправляем сообщение с кнопкой назад
      await ctx.reply("Фотографии элемента:", {
        reply_markup: new InlineKeyboard().text("⬅️ Назад", `edit_photo:${itemId}`)
      });
    } else {
      await ctx.answerCallbackQuery({ text: 'Фотографии отсутствуют' });
    }
  } catch (error) {
    logger.error('Error in view_photos handler', error);
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
});

bot.callbackQuery(/delete_photos:.+/, async (ctx: Context) => {
  try {
    if (!ctx.callbackQuery?.data) {
      await ctx.answerCallbackQuery({ text: "Ошибка: данные не получены" });
      return;
    }
    
    const itemId = ctx.callbackQuery.data.split(':')[1];
    
    // Удаляем все фото элемента
    await supabase.from('item_images').delete().eq('item_id', itemId);
    
    await ctx.editMessageText("Все фотографии удалены.", {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", `edit_photo:${itemId}`)
    });
    await ctx.answerCallbackQuery({ text: 'Фото удалены' });
  } catch (error) {
    logger.error('Error in delete_photos handler', error);
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
});

bot.callbackQuery("back_to_list", async (ctx: Context) => {
  try {
    await ctx.editMessageText("Главное меню:", { reply_markup: mainMenuKeyboard() });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in back_to_list handler", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

/** --- Категории --- */
bot.callbackQuery("categories", async (ctx: Context) => {
  try {
    const me = await getOrCreateMember(ctx);
    if (!me.household_id) {
      await ctx.answerCallbackQuery({ text: "Сначала создайте или присоединитесь к домохозяйству" });
      return;
    }
    
    const { data: cats } = await supabase
      .from("categories")
      .select("*")
      .eq("household_id", me.household_id)
      .order("id");
    
    await ctx.editMessageText("Выбери категорию:", {
      reply_markup: makeCategoriesMenuKeyboard((cats || []) as Category[])
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in categories callback", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

/** --- Бюджет --- */
bot.callbackQuery("budget", async (ctx: Context) => {
  try {
    const me = await getOrCreateMember(ctx);
    if (!me.household_id) {
      await ctx.answerCallbackQuery({ text: "Сначала создайте или присоединитесь к домохозяйству" });
      return;
    }
    
    const { data: hh } = await supabase
      .from("households")
      .select("*")
      .eq("id", me.household_id)
      .single();
      
    const { data: sumRow } = await supabase
      .from("items")
      .select("price_uah")
      .eq("household_id", me.household_id)
      .eq("status", "active");
      
    const total = (sumRow || []).reduce((acc: number, r: any) => acc + (r.price_uah || 0), 0);
    
    const message = `💰 <b>Бюджет домохозяйства</b>\n\n` +
                   `Общий бюджет: ${fmtMoney(hh?.budget_uah || 0)}\n` +
                   `Активные хотелки: ${fmtMoney(total)}\n` +
                   `Остаток: ${fmtMoney((hh?.budget_uah || 0) - total)}\n\n` +
                   `Используйте /budget [сумма] для изменения бюджета.`;
    
    await ctx.editMessageText(message, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("⬅️ Назад", "refresh_menu")
    });
    await ctx.answerCallbackQuery();
  } catch (error) {
    logger.error("Error in budget callback", error);
    await ctx.answerCallbackQuery({ text: "Ошибка" });
  }
});

/** ===== Vercel handler (HTTP adapter) ===== */
const handleUpdate = webhookCallback(bot, "http");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Проверка переменных окружения
  if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logger.error("Missing environment variables");
    return res.status(500).json({ error: "Server configuration error" });
  }

  if (req.method === "GET") {
    logger.info("GET request received");
    return res.status(200).json({ status: "OK", message: "Bot is running" });
  }

  try {
    logger.info("Received update", req.body);
    await handleUpdate(req, res);
  } catch (err) {
    logger.error("Webhook error", err);
    
    if (!res.headersSent) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      return res.status(200).json({ 
        status: "error", 
        message: errorMessage 
      });
    }
  }
}
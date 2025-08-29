# Telegram Wishlist Bot (₴)
Синхронизированный бот-«хотелки» для двоих : добавление, удаление, зачёркивание, цены в гривнах, бюджет и уведомления партнёру.

## Возможности
- 9 разделов: Места куда идти с деньгами, бесплатные места, Ресторан, Поездка, Вещи, Косметика, Игры, Страйкбол, Прочее
- Добавление текстом и с фото (фото привяжется к хотелке)
- Цены в ₴ и общий бюджет / остаток
- Автоуведомление партнёру, когда добавляешь хотелку
- Синхронизация в реальном времени (общее «домохозяйство»)

## Быстрый старт (бесплатно)
### 1) Создай бота

- В Telegram напиши @BotFather → `/newbot` → получи **BOT_TOKEN`**
- (Опционально) команды через `/setcommands`:
  ```
  start - начать
  add - добавить хотелку
  list - список хотелок
  budget - бюджет
  categories - категории
  setprice - изменить цену
  create_household - создать семью
  join_household - присоединиться
  ```

### 2) Supabase (Free)
1. Зарегистрируйся на supabase.com → создай проект
2. SQL Editor → вставь `supabase_schema.sql` → Run
3. В Settings → API скопируй **Project URL** (SUPABASE_URL) и **Service role key** (SUPABASE_SERVICE_ROLE_KEY)

### 3) Локально
```bash
npm install
# cоздай .env на основе .env.example
npm run build
node build/api/bot.js
```

### 4) Vercel (Free)
1. Импортируй репозиторий/папку в vercel.com
2. В настройках проекта добавь переменные окружения:
   - `BOT_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Deploy

### 5) Подключи Webhook
Открой в браузере (подставь свои значения):
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<твое-приложение>.vercel.app/api/bot
```

### 6) Спаривание (синхро)
- Ты: `/create_household Семья` → бот покажет код
- Марина: `/join_household <код>` → теперь список общий и уведомления включены

## Использование
- Добавить: `/add Вещи 1500 Кроссовки` (или фото с подписью `/add Вещи 1500 Кроссовки`)
- Список: `/list` или `/list Поездка`
- Бюджет: `/budget 10000` (в гривнах), показать — `/budget`
- Изменить цену: `/setprice <id> 1234`
- Кнопки под сообщением: ✅ готово/↩️ вернуть, 🗑 удалить

## Файлы проекта
- `api/bot.ts` — код бота (TypeScript, ESM, grammY)
- `supabase_schema.sql` — схема БД
- `package.json`, `tsconfig.json`, `vercel.json`
- `.env.example`, `.gitignore`, `README.md`

## Примечания
- Хранение фото идёт через `file_id` Telegram — без оплаты за дисковое хранилище
- Vercel/Supabase — бесплатные тарифы для семейного использования

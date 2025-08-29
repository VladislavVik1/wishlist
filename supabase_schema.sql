-- Supabase schema for Wishlist Bot
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text,
  invite_code text unique not null,
  budget_uah numeric not null default 0,
  created_at timestamptz default now()
);

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete set null,
  telegram_user_id bigint unique,
  name text,
  created_at timestamptz default now()
);

create table if not exists categories (
  id bigserial primary key,
  household_id uuid references households(id) on delete cascade,
  name text not null,
  slug text not null
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade,
  category_id bigint references categories(id) on delete set null,
  title text not null,
  price_uah numeric not null default 0,
  status text not null default 'active',
  created_by bigint not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists item_images (
  id bigserial primary key,
  item_id uuid references items(id) on delete cascade,
  file_id text not null,
  created_at timestamptz default now()
);

create index if not exists idx_items_household on items(household_id);
create index if not exists idx_categories_household on categories(household_id);

-- updated_at trigger
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_updated_at on items;
create trigger trg_set_updated_at before update on items for each row execute function set_updated_at();

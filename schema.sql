-- SORTED pilot schema · run once in Supabase SQL editor
-- Privacy by design: no transcripts, no photos, no phone numbers. Ever.

create table if not exists sku_products (
  id bigint generated always as identity primary key,
  name text not null,
  brand text,
  category text,              -- deo | facewash | moisturiser | sunscreen | shampoo | beard | powder | intimate
  price_band text,            -- e.g. "₹200-300"
  flags jsonb default '{}',   -- {"paraben":false,"aluminium_salts":true,"alcohol_denat":false,"strong_fragrance":true,"comedogenic":false}
  claim_notes text,           -- e.g. "48-hr protection is marketing"
  skin_type_fit text,         -- oily | dry | all
  alt_product_id bigint references sku_products(id),
  source_url text,
  last_verified date default current_date
);

create table if not exists events (
  id bigint generated always as identity primary key,
  device_id text not null,    -- random pseudo-ID from the browser, never a phone number
  event text not null,        -- activated | verdict_given | helped | meh | private_used | product_used | barber_used | link_shared | red_flag | followup_shown
  mode text,
  ts timestamptz default now()
);

create table if not exists followups (
  id bigint generated always as identity primary key,
  device_id text not null,
  due_date date not null,
  topic text not null,        -- health-followup | urgent-followup  (CATEGORY ONLY — never the conversation)
  status text default 'pending',  -- pending | done
  created_at timestamptz default now()
);

create index if not exists ev_device on events(device_id);
create index if not exists fu_due on followups(status, due_date);

-- Gate metrics (run anytime):
-- Activation:   select count(distinct device_id) from events where event='activated';
-- D30 return:   select device_id, count(*) from events where event like '%_given' or event like '%_used' group by 1;
-- Health usage: select count(distinct device_id) from events where event='private_used';

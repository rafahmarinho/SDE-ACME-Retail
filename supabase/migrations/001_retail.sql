-- ACME Retail schema. The application service is the write path.
-- retail_state is the canonical snapshot. order_feed supports realtime.
-- Direct browser writes are denied by RLS. The service role bypasses RLS
-- only after the Next.js API has authorized the actor.

create table if not exists public.retail_state (
  id integer primary key default 1 check (id = 1),
  version integer not null default 1,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.order_feed (
  id text primary key,
  user_id text not null,
  number text not null,
  payment_status text not null,
  delivery_status text not null,
  updated_at timestamptz not null
);

alter table public.retail_state enable row level security;
alter table public.order_feed enable row level security;

drop policy if exists order_feed_select_own on public.order_feed;
create policy order_feed_select_own on public.order_feed
  for select to authenticated
  using (user_id = auth.uid()::text);

insert into storage.buckets (id, name, public)
values ('return-photos', 'return-photos', false)
on conflict (id) do nothing;

-- No insert/update/delete policies: clients cannot mutate store data or files directly.
-- The API uploads return photos with the service role after checking the session.

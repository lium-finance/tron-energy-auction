create table if not exists quotes (
  hour         bigint        not null,
  venue        text          not null,
  size         bigint        not null,
  term         text          not null,
  sun_per_unit numeric(12,4),
  depth        bigint,
  read_at      timestamptz   not null,
  source       text          not null,
  status       text          not null,
  reason       text,
  payload_hash text,
  primary key (hour, venue, size, term)
);

create table if not exists prints (
  hour              bigint      primary key,
  median            numeric(12,4),
  cheapest          numeric(12,4),
  dearest           numeric(12,4),
  live_count        int         not null,
  depth_aware_count int         not null,
  status            text        not null,
  method_version    text        not null,
  printed_at        timestamptz not null
);

create table if not exists chain (
  hour                    bigint      primary key,
  energy_fee_sun          int         not null,
  total_energy_weight_trx bigint      not null,
  total_energy_limit      bigint      not null,
  trx_usd                 numeric(12,6),
  read_at                 timestamptz not null
);

create table if not exists verification (
  hour         bigint      not null,
  wallet       text        not null,
  energy_limit bigint      not null,
  energy_used  bigint      not null,
  read_at      timestamptz not null,
  source       text        not null,
  primary key (hour, wallet)
);

create table if not exists payloads (
  payload_hash text        primary key,
  body         text        not null,
  stored_at    timestamptz not null default now()
);

create table if not exists alerts (
  kind     text        not null,
  utc_day  date        not null,
  sent_at  timestamptz not null default now(),
  primary key (kind, utc_day)
);

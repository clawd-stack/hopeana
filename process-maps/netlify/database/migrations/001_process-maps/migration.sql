-- ---------------------------------------------------------------------
-- Process maps.
--
-- Every table is prefixed pm_ so the module can be dropped into Peggy's
-- database without colliding with anything already there.
--
-- A map is a board. Everything on it (sticky notes, process steps,
-- decisions, swimlanes, connectors) is one row in pm_items, keyed by an
-- id the browser generates. Keeping items as rows rather than one JSON
-- document per board is what lets two people edit the same board at
-- once: each change touches only the items it changed, so one person
-- moving a sticky never overwrites another person's text edit.
--
-- pm_maps.revision is the board's change counter. Every write takes the
-- board row lock, bumps the counter and stamps the items it touched with
-- the new value, so commits land in revision order and "everything since
-- revision N" is an exact, gap-free question. Deleted items stay as
-- tombstones so a browser that last synced at N still learns about them.
-- ---------------------------------------------------------------------

create table if not exists pm_users (
  user_id        uuid primary key default gen_random_uuid(),
  email          text not null,
  name           text not null,
  role           text not null default 'editor' check (role in ('admin', 'editor', 'viewer')),
  -- scrypt with its cost parameters embedded. See src/lib/password.ts.
  -- Null until a password has been issued.
  password_hash  text,
  -- Set on every admin-issued password, cleared when the person picks
  -- their own, so a password that was read out or emailed never lasts.
  must_change    boolean not null default true,
  -- Part of every session cookie. Bumped whenever the password changes, so
  -- a reset or a change signs out every browser still holding the old one.
  session_version integer not null default 0,
  active         boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists pm_users_email_idx on pm_users (lower(email));

-- Sign-in attempts per bucket (hashed email, hashed IP) per window.
create table if not exists pm_throttle (
  bucket_key    text primary key,
  hits          integer not null,
  window_start  timestamptz not null
);

create table if not exists pm_maps (
  map_id       uuid primary key default gen_random_uuid(),
  name         text not null,
  -- Free text grouping, e.g. Workforce, HSEQ, Finance. Matches Peggy's modules.
  area         text not null default '',
  description  text not null default '',
  status       text not null default 'draft' check (status in ('draft', 'in_review', 'agreed')),
  revision     bigint not null default 0,
  item_count   integer not null default 0,
  -- A thumbnail for the maps list: shape boxes and link lines as numbers,
  -- drawn by the browser. Never markup, so it cannot carry script.
  preview      jsonb,
  created_by   uuid references pm_users (user_id) on delete set null,
  updated_by   uuid references pm_users (user_id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);

create index if not exists pm_maps_list_idx on pm_maps (archived_at, updated_at desc);

create table if not exists pm_items (
  map_id      uuid not null references pm_maps (map_id) on delete cascade,
  item_id     text not null,
  kind        text not null,
  -- The whole item as the browser sees it, after server-side validation.
  data        jsonb not null,
  revision    bigint not null,
  deleted     boolean not null default false,
  updated_by  uuid references pm_users (user_id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (map_id, item_id)
);

create index if not exists pm_items_revision_idx on pm_items (map_id, revision);

-- Who has a board open right now, and what they have selected, so
-- collaborators can see each other. One row per browser tab, not per
-- person: somebody with the board open twice is two sets of selections,
-- and keying by person let an idle tab overwrite the busy one's.
-- Rows older than the presence window are stale and ignored.
create table if not exists pm_presence (
  map_id     uuid not null references pm_maps (map_id) on delete cascade,
  user_id    uuid not null references pm_users (user_id) on delete cascade,
  client_id  text not null default '',
  seen_at    timestamptz not null default now(),
  selection  jsonb not null default '[]'::jsonb,
  primary key (map_id, user_id, client_id)
);

-- ---------------------------------------------------------------------
-- Agents: team members that are software rather than people (Crocbot, a
-- Claude agent, a scheduled job). They read and edit maps through the API
-- and the MCP endpoint, never through the board, so they have no password
-- and no email. Each one holds an access key instead.
--
-- Only a SHA-256 of the key is kept: the key is 32 random bytes, so a fast
-- hash is enough, and the key itself is shown once, to the admin who made it.
-- Making a new key replaces the old one; deactivating the agent stops it.
-- ---------------------------------------------------------------------

alter table pm_users add column if not exists is_agent boolean not null default false;
alter table pm_users add column if not exists api_key_hash text;
alter table pm_users add column if not exists api_key_created_at timestamptz;

-- People sign in with an email; agents have none.
alter table pm_users alter column email drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pm_users_person_has_email') then
    alter table pm_users add constraint pm_users_person_has_email check (is_agent or email is not null);
  end if;
  -- An agent edits or reads; it never manages the team.
  if not exists (select 1 from pg_constraint where conname = 'pm_users_agent_not_admin') then
    alter table pm_users add constraint pm_users_agent_not_admin check (not is_agent or role <> 'admin');
  end if;
end $$;

create unique index if not exists pm_users_api_key_idx on pm_users (api_key_hash) where api_key_hash is not null;

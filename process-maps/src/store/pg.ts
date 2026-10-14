import postgres from 'postgres';
import { env } from '../lib/env.ts';
import type { Item, ItemOp } from '../domain/items.ts';
import type { ApplyResult, ItemRow, MapRecord, PresenceRow, Role, Store, UserRecord } from './types.ts';

/**
 * Postgres implementation. The one operation that has to be exactly right is
 * apply(): it takes the board row lock, bumps the revision and writes every
 * item in the batch inside one transaction, so commits land in revision order
 * and a reader asking for "everything after N" can never miss a change.
 */

type Sql = ReturnType<typeof postgres>;

let shared: Sql | null = null;

function connect(connectionString?: string): Sql {
  if (!shared) {
    shared = postgres(connectionString ?? env.databaseUrl, {
      // Serverless: small pool, short idle, prepared statements off because
      // connections are recycled behind a pooler.
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
    });
  }
  return shared;
}

/**
 * A value for a jsonb parameter. postgres.js serialises json itself, so a
 * pre-stringified value would be stored as a JSON string, not as the object.
 */
const asJson = (db: Sql | postgres.TransactionSql, value: unknown) => db.json(value as postgres.JSONValue);

const toNumber = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value ?? ''));
const isoOrNull = (value: unknown) => (value === null || value === undefined ? null : iso(value));

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapUser(row: any): UserRecord {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    isAgent: row.is_agent === true,
    apiKeyCreatedAt: isoOrNull(row.api_key_created_at),
    active: row.active,
    mustChange: row.must_change,
    sessionVersion: toNumber(row.session_version),
    passwordHash: row.password_hash ?? null,
    lastLoginAt: isoOrNull(row.last_login_at),
    createdAt: iso(row.created_at),
  };
}

function mapMap(row: any): MapRecord {
  return {
    mapId: row.map_id,
    name: row.name,
    area: row.area,
    description: row.description,
    status: row.status,
    revision: toNumber(row.revision),
    itemCount: toNumber(row.item_count),
    preview: row.preview ?? null,
    createdBy: row.created_by ?? null,
    createdByName: row.created_by_name ?? null,
    updatedBy: row.updated_by ?? null,
    updatedByName: row.updated_by_name ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: isoOrNull(row.archived_at),
  };
}

export function createPgStore(connectionString?: string): Store {
  const sql = () => connect(connectionString);

  async function getMap(db: Sql | postgres.TransactionSql, mapId: string): Promise<MapRecord | null> {
    const [row]: any[] = await db`
      select m.*, cu.name as created_by_name, uu.name as updated_by_name
      from pm_maps m
      left join pm_users cu on cu.user_id = m.created_by
      left join pm_users uu on uu.user_id = m.updated_by
      where m.map_id = ${mapId}::uuid
    `;
    return row ? mapMap(row) : null;
  }

  async function writeItems(
    tx: postgres.TransactionSql,
    mapId: string,
    items: Item[],
    revision: number,
    userId: string,
  ): Promise<void> {
    if (!items.length) return;
    const rows = items.map((item) => ({ id: item.id, kind: item.kind, item }));
    await tx`
      insert into pm_items (map_id, item_id, kind, data, revision, deleted, updated_by, updated_at)
      select ${mapId}::uuid, r.id, r.kind, r.item, ${revision}, false, ${userId}::uuid, now()
      from jsonb_to_recordset(${asJson(tx, rows)}) as r(id text, kind text, item jsonb)
      on conflict (map_id, item_id) do update
        set kind = excluded.kind,
            data = excluded.data,
            revision = excluded.revision,
            deleted = false,
            updated_by = excluded.updated_by,
            updated_at = now()
    `;
  }

  return {
    users: {
      async get(userId) {
        const [row]: any[] = await sql()`select * from pm_users where user_id = ${userId}::uuid`;
        return row ? mapUser(row) : null;
      },
      async getByEmail(email) {
        const [row]: any[] = await sql()`select * from pm_users where lower(email) = ${email.toLowerCase()}`;
        return row ? mapUser(row) : null;
      },
      async list() {
        const rows: any[] = await sql()`select * from pm_users order by active desc, lower(name)`;
        return rows.map(mapUser);
      },
      async create({ email, name, role, passwordHash, mustChange, isAgent = false }) {
        const [row]: any[] = await sql()`
          insert into pm_users (email, name, role, password_hash, must_change, is_agent)
          values (${email}, ${name}, ${role}, ${passwordHash}, ${mustChange}, ${isAgent})
          on conflict (lower(email)) do nothing
          returning *
        `;
        return row ? mapUser(row) : null;
      },
      async update(userId, patch) {
        const [row]: any[] = await sql()`
          update pm_users set
            name = coalesce(${patch.name ?? null}, name),
            role = coalesce(${patch.role ?? null}, role),
            active = coalesce(${patch.active ?? null}::boolean, active),
            updated_at = now()
          where user_id = ${userId}::uuid
          returning *
        `;
        return row ? mapUser(row) : null;
      },
      async setPassword(userId, passwordHash, mustChange) {
        await sql()`
          update pm_users set password_hash = ${passwordHash}, must_change = ${mustChange},
            session_version = session_version + 1, updated_at = now()
          where user_id = ${userId}::uuid
        `;
      },
      async recordLogin(userId) {
        await sql()`update pm_users set last_login_at = now() where user_id = ${userId}::uuid`;
      },
      async setApiKey(userId, keyHash) {
        await sql()`
          update pm_users set api_key_hash = ${keyHash}, api_key_created_at = now(), updated_at = now()
          where user_id = ${userId}::uuid
        `;
      },
      async getByApiKey(keyHash) {
        const [row]: any[] = await sql()`select * from pm_users where api_key_hash = ${keyHash}`;
        return row ? mapUser(row) : null;
      },
    },

    async throttle(bucketKey, limit, windowMs) {
      const windowStart = new Date(Date.now() - windowMs);
      const [row]: any[] = await sql()`
        insert into pm_throttle (bucket_key, hits, window_start)
        values (${bucketKey}, 1, now())
        on conflict (bucket_key) do update
          set hits = case when pm_throttle.window_start < ${windowStart} then 1 else pm_throttle.hits + 1 end,
              window_start = case when pm_throttle.window_start < ${windowStart} then now() else pm_throttle.window_start end
        returning hits
      `;
      return toNumber(row.hits) <= limit;
    },

    maps: {
      async list({ archived }) {
        const rows: any[] = await sql()`
          select m.*, cu.name as created_by_name, uu.name as updated_by_name
          from pm_maps m
          left join pm_users cu on cu.user_id = m.created_by
          left join pm_users uu on uu.user_id = m.updated_by
          where (m.archived_at is not null) = ${archived}
          order by m.updated_at desc
        `;
        return rows.map(mapMap);
      },
      get: (mapId) => getMap(sql(), mapId),
      async create({ name, area, description, userId, items }) {
        return sql().begin(async (tx) => {
          const revision = items.length ? 1 : 0;
          const [row]: any[] = await tx`
            insert into pm_maps (name, area, description, revision, item_count, created_by, updated_by)
            values (${name}, ${area}, ${description}, ${revision}, ${items.length}, ${userId}::uuid, ${userId}::uuid)
            returning map_id
          `;
          await writeItems(tx, row.map_id, items, revision, userId);
          return (await getMap(tx, row.map_id))!;
        }) as Promise<MapRecord>;
      },
      async update(mapId, patch, userId) {
        const archived = patch.archived === undefined ? null : patch.archived;
        const [row]: any[] = await sql()`
          update pm_maps set
            name = coalesce(${patch.name ?? null}, name),
            area = coalesce(${patch.area ?? null}, area),
            description = coalesce(${patch.description ?? null}, description),
            status = coalesce(${patch.status ?? null}, status),
            archived_at = case
              when ${archived}::boolean is null then archived_at
              when ${archived}::boolean then coalesce(archived_at, now())
              else null
            end,
            updated_by = ${userId}::uuid,
            updated_at = now()
          where map_id = ${mapId}::uuid
          returning map_id
        `;
        return row ? getMap(sql(), mapId) : null;
      },
      async items(mapId, sinceRevision): Promise<ItemRow[]> {
        const rows: any[] = sinceRevision === 0
          ? await sql()`
              select item_id, data, revision, deleted from pm_items
              where map_id = ${mapId}::uuid and not deleted
              order by revision
            `
          : await sql()`
              select item_id, data, revision, deleted from pm_items
              where map_id = ${mapId}::uuid and revision > ${sinceRevision}
              order by revision
            `;
        return rows.map((row) => ({
          id: row.item_id,
          item: row.deleted ? null : (row.data as Item),
          revision: toNumber(row.revision),
          deleted: row.deleted,
        }));
      },
      async apply(mapId, ops: ItemOp[], userId, maxItems): Promise<ApplyResult> {
        return sql().begin(async (tx) => {
          // The lock that orders every write to this board.
          const [map]: any[] = await tx`
            select archived_at from pm_maps where map_id = ${mapId}::uuid for update
          `;
          if (!map) return { ok: false, code: 'NOT_FOUND' } as const;
          if (map.archived_at) return { ok: false, code: 'MAP_ARCHIVED' } as const;

          const puts = ops.flatMap((op) => (op.type === 'put' ? [op.item] : []));
          const deletes = ops.flatMap((op) => (op.type === 'delete' ? [op.id] : []));
          const touched = asJson(tx, ops.map((op) => (op.type === 'put' ? op.item.id : op.id)));

          const [counts]: any[] = await tx`
            select count(*) as live from pm_items where map_id = ${mapId}::uuid and not deleted
          `;
          const touchedLive: any[] = await tx`
            select item_id, kind from pm_items
            where map_id = ${mapId}::uuid and not deleted
              and item_id in (select jsonb_array_elements_text(${touched}))
          `;
          // A live step cannot become a connector or the other way round: the
          // two are drawn by different machinery, and every browser would choke.
          const liveKinds = new Map(touchedLive.map((row) => [row.item_id as string, row.kind as string]));
          for (const item of puts) {
            const was = liveKinds.get(item.id);
            if (was && (was === 'connector') !== (item.kind === 'connector')) return { ok: false, code: 'INVALID_REQUEST' } as const;
          }
          // Live after = live now, minus every touched item that is live now,
          // plus every put (each put leaves its item live).
          const liveAfter = toNumber(counts.live) - touchedLive.length + puts.length;
          if (liveAfter > maxItems) return { ok: false, code: 'MAP_FULL' } as const;

          const [bumped]: any[] = await tx`
            update pm_maps set revision = revision + 1, updated_at = now(), updated_by = ${userId}::uuid
            where map_id = ${mapId}::uuid
            returning revision
          `;
          const revision = toNumber(bumped.revision);

          await writeItems(tx, mapId, puts, revision, userId);
          if (deletes.length) {
            // The old data stays on the tombstone, which costs little and
            // leaves a deleted step recoverable by hand if it ever matters.
            await tx`
              insert into pm_items (map_id, item_id, kind, data, revision, deleted, updated_by, updated_at)
              select ${mapId}::uuid, d.id, 'deleted', 'null'::jsonb, ${revision}, true, ${userId}::uuid, now()
              from jsonb_array_elements_text(${asJson(tx, deletes)}) as d(id)
              on conflict (map_id, item_id) do update
                set revision = excluded.revision,
                    deleted = true,
                    updated_by = excluded.updated_by,
                    updated_at = now()
            `;
          }
          await tx`
            update pm_maps set item_count = ${liveAfter} where map_id = ${mapId}::uuid
          `;
          return { ok: true, revision } as const;
        }) as Promise<ApplyResult>;
      },
      async setPreview(mapId, preview) {
        await sql()`update pm_maps set preview = ${asJson(sql(), preview)} where map_id = ${mapId}::uuid`;
      },
      async touchPresence(mapId, userId, clientId, selection) {
        await sql()`
          insert into pm_presence (map_id, user_id, client_id, seen_at, selection)
          values (${mapId}::uuid, ${userId}::uuid, ${clientId}, now(), ${asJson(sql(), selection)})
          on conflict (map_id, user_id, client_id) do update
            set seen_at = now(), selection = excluded.selection
        `;
      },
      async presence(mapId, withinMs): Promise<PresenceRow[]> {
        const rows: any[] = await sql()`
          select p.user_id, p.client_id, u.name, p.selection, p.seen_at
          from pm_presence p
          join pm_users u on u.user_id = p.user_id
          where p.map_id = ${mapId}::uuid
            and p.seen_at > now() - make_interval(secs => ${withinMs / 1000})
        `;
        return rows.map((row) => ({
          userId: row.user_id,
          clientId: row.client_id,
          name: row.name,
          selection: Array.isArray(row.selection) ? row.selection : [],
          seenAt: iso(row.seen_at),
        }));
      },
    },
  };
}

/** Test seam: closes the shared pool so a suite can exit cleanly. */
export async function closePgStore(): Promise<void> {
  if (shared) {
    await shared.end({ timeout: 5 });
    shared = null;
  }
}

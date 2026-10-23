// Seeds a fresh site from the industry pack: the demo sources (industry/sources.json, only the ones not
// there yet, so admin edits are never undone). Topics need no seeding: they are read from industry/topics.json.
// A few feeds that moved or stopped are repaired when the stored config is still the broken one.
// Re-runnable:  node --env-file=.env scripts/seed.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql, type Sql } from "@aihot/backend/db";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

interface SeedSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  tier?: string;
  owner_entity_id?: string | null;
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  enabled?: boolean;
}

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };

/** Previous feed URLs that no longer return a feed. Replaced only while the row still has one of these. */
const REPLACED_FEEDS: Record<string, string[]> = {
  "rss-ts-digital_ai_translation": ["https://xionglingsong.github.io/rss-translation-studies/topic-digital-ai-translation.xml"],
  "rss-ts-audiovisual_translation": ["https://xionglingsong.github.io/rss-translation-studies/topic-audiovisual-translation.xml"],
  "rss-ts-terminology_specialized_translation": ["https://xionglingsong.github.io/rss-translation-studies/topic-terminology-specialized-translation.xml"],
  "rss-ts-interpreting": ["https://xionglingsong.github.io/rss-translation-studies/topic-interpreting.xml"],
  "rss-ts-translator_education": ["https://xionglingsong.github.io/rss-translation-studies/topic-translator-education.xml"],
  "rss-nimdzi": ["https://www.nimdzi.com/feed/", "https://www.nimdzi.com/feed"],
  "rss-multilingual": ["https://www.multilingual.com/feed/", "https://www.multilingual.com/feed"],
  "rss-phrase-blog": ["https://phrase.com/blog/feed/", "https://phrase.com/blog/feed"],
  "rss-kudo": ["https://www.kudo.ai/feed/", "https://www.kudo.ai/feed", "https://kudo.ai/feed/", "https://kudo.ai/feed"],
};

/** Reddit hot feeds share one IP budget of about one request every few seconds. */
const REDDIT_STAGGER_MINUTES = [0, 8, 16, 24, 32];

function byId(id: string): SeedSource | undefined {
  return sources.find((s) => s.id === id);
}

const redditSources = sources.filter((s) => String(s.config.feedUrl ?? "").includes("reddit.com"));
const redditStagger = new Map(redditSources.map((s, index) => [s.id, REDDIT_STAGGER_MINUTES[index % REDDIT_STAGGER_MINUTES.length] ?? 0]));

/**
 * Updates sources that were seeded with a feed address this pack has since corrected, and only when
 * that address is still stored. An admin who already changed the feed is left alone. Returns the ids
 * that changed.
 */
export async function repairKnownSources(db: Sql): Promise<string[]> {
  const changed: string[] = [];
  for (const [id, previousUrls] of Object.entries(REPLACED_FEEDS)) {
    const source = byId(id);
    if (!source) continue;
    const feedUrl = String(source.config.feedUrl ?? "");
    for (const previousUrl of previousUrls) {
      // A feed that only changed address keeps every other setting. A feed that changed kind
      // (the blog RSS that now comes from JSON) takes the pack's config, because the old keys no longer apply.
      const rows = source.kind === "rss"
        ? await db<{ id: string }[]>`
            UPDATE sources
            SET config = jsonb_set(config, '{feedUrl}', to_jsonb(${feedUrl}::text), false),
                updated_at = now(), next_fetch_at = now()
            WHERE id = ${id} AND kind = 'rss' AND config->>'feedUrl' = ${previousUrl}
            RETURNING id`
        : await db<{ id: string }[]>`
            UPDATE sources
            SET kind = ${source.kind}, config = ${db.json(source.config as never)}, updated_at = now(), next_fetch_at = now()
            WHERE id = ${id} AND config->>'feedUrl' = ${previousUrl}
            RETURNING id`;
      if (rows.length) changed.push(id);
    }
  }

  const rows = await db<{ id: string }[]>`
    UPDATE sources
    SET config = jsonb_set(
          CASE WHEN config->>'itemSelector' = 'div.c-article-list'
            THEN jsonb_set(config, '{itemSelector}', '"div.article.c-article-list"'::jsonb, true)
            ELSE config END,
          '{publishedAtOrder}', '"mdy"'::jsonb, true),
        updated_at = now(),
        next_fetch_at = least(next_fetch_at, now())
    WHERE id = 'web-gala-news'
      AND config->>'url' = 'https://www.gala-global.org/news/'
      AND config->>'publishedAtSelector' = '.c-article-list__date'
      AND coalesce(config->>'publishedAtOrder', '') <> 'mdy'
    RETURNING id`;
  if (rows.length) changed.push("web-gala-news");

  for (const source of redditSources) {
    const stagger = redditStagger.get(source.id) ?? 0;
    const rows = await db<{ id: string }[]>`
      UPDATE sources
      SET config = jsonb_set(config, '{minIntervalMinutes}', to_jsonb(${360}::int), true),
          interval_minutes = greatest(interval_minutes, 360),
          next_fetch_at = now() + make_interval(mins => ${stagger}),
          updated_at = now()
      WHERE id = ${source.id}
        AND kind = 'rss'
        AND config->>'feedUrl' = ${String(source.config.feedUrl)}
        AND NOT (config ? 'minIntervalMinutes')
      RETURNING id`;
    if (rows.length) changed.push(source.id);
  }

  const terps = byId("pod-troublesome-terps");
  if (terps?.enabled === false) {
    const rows = await db<{ id: string }[]>`
      UPDATE sources SET enabled = false, updated_at = now()
      WHERE id = 'pod-troublesome-terps' AND enabled
        AND config->>'feedUrl' = ${String(terps.config.feedUrl)}
      RETURNING id`;
    if (rows.length) changed.push("pod-troublesome-terps");
  }
  return changed;
}

async function main(): Promise<void> {
  let added = 0;
  for (const s of sources) {
    assertSupportedConfig(s.kind, s.config);
    const tier = s.tier ?? "T2";
    const stagger = redditStagger.get(s.id) ?? 0;
    // First-party means a T1 source, as the admin sets it.
    const inserted = await sql`
      INSERT INTO sources (id, name, kind, config, tier, first_party, owner_entity_id, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
      VALUES (${s.id}, ${s.name}, ${s.kind}, ${sql.json(s.config as never)}, ${tier}, ${tier === "T1"}, ${s.owner_entity_id ?? null},
              ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false},
              ${s.enabled ?? true}, now() + make_interval(mins => ${stagger}))
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    added += inserted.length;
  }
  const repaired = await repairKnownSources(sql);
  console.log(`sources: ${added} added, ${sources.length - added} already there, ${repaired.length} repaired${repaired.length ? ` (${repaired.join(", ")})` : ""}`);
  await closeDb();
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) await main();

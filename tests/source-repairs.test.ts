// Seed repair rewrites only the feed addresses this pack knows are broken. An address an admin already
// changed stays as they left it, and a second run changes nothing.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { repairKnownSources } from "../scripts/seed.ts";

after(() => closeDb());

const oldJournal = "https://xionglingsong.github.io/rss-translation-studies/topic-interpreting.xml";
const newJournal = "https://yileme.github.io/rss-translation-studies/topic-interpreting.xml";

test("broken seed feeds are corrected once, and an edited feed is left alone", async () => {
  await sql`INSERT INTO sources (id, name, kind, config, interval_minutes, next_fetch_at) VALUES
    ('rss-ts-interpreting', '口译', 'rss', ${sql.json({ feedUrl: oldJournal, allowCategories: ["interpreting"] })}, 240, '2100-01-01'),
    ('rss-phrase-blog', 'Phrase', 'rss', ${sql.json({ feedUrl: "https://phrase.com/blog/feed/", _aihot: { initialBackfillLimit: 8 } })}, 180, '2100-01-01'),
    ('rss-kudo', 'KUDO', 'rss', ${sql.json({ feedUrl: "https://example.com/kudo.xml" })}, 180, '2100-01-01'),
    ('web-gala-news', 'GALA', 'web_list', ${sql.json({ url: "https://www.gala-global.org/news/", itemSelector: "div.c-article-list", publishedAtSelector: ".c-article-list__date", detail: { maxFetches: 2 } })}, 240, '2100-01-01'),
    ('rss-reddit-machinetranslation', 'MT', 'rss', ${sql.json({ feedUrl: "https://www.reddit.com/r/MachineTranslation/hot/.rss" })}, 60, '2100-01-01'),
    ('pod-troublesome-terps', 'Terps', 'rss', ${sql.json({ feedUrl: "https://feeds.fireside.fm/troubleterps/rss" })}, 720, '2100-01-01')`;

  const changed = await repairKnownSources(sql);
  assert.ok(changed.includes("rss-ts-interpreting"));
  assert.ok(changed.includes("rss-phrase-blog"));
  assert.ok(changed.includes("web-gala-news"));
  assert.ok(changed.includes("rss-reddit-machinetranslation"));
  assert.ok(changed.includes("pod-troublesome-terps"));
  assert.equal(changed.includes("rss-kudo"), false);

  const [journal] = await sql<{ config: { feedUrl: string; allowCategories: string[] } }[]>`SELECT config FROM sources WHERE id = 'rss-ts-interpreting'`;
  assert.equal(journal!.config.feedUrl, newJournal);
  assert.deepEqual(journal!.config.allowCategories, ["interpreting"]);

  const [phrase] = await sql<{ kind: string; config: { url?: string; feedUrl?: string } }[]>`SELECT kind, config FROM sources WHERE id = 'rss-phrase-blog'`;
  assert.equal(phrase!.kind, "json_list");
  assert.equal(phrase!.config.url, "https://phrase.com/wp-json/wp/v2/posts?per_page=10");
  assert.equal(phrase!.config.feedUrl, undefined);

  const [kudo] = await sql<{ kind: string; config: { feedUrl: string } }[]>`SELECT kind, config FROM sources WHERE id = 'rss-kudo'`;
  assert.equal(kudo!.kind, "rss");
  assert.equal(kudo!.config.feedUrl, "https://example.com/kudo.xml");

  const [gala] = await sql<{ config: { publishedAtOrder: string; itemSelector: string; detail: { maxFetches: number } } }[]>`SELECT config FROM sources WHERE id = 'web-gala-news'`;
  assert.equal(gala!.config.publishedAtOrder, "mdy");
  assert.equal(gala!.config.itemSelector, "div.article.c-article-list");
  assert.equal(gala!.config.detail.maxFetches, 2);

  const [reddit] = await sql<{ interval_minutes: number; config: { minIntervalMinutes: number } }[]>`SELECT interval_minutes, config FROM sources WHERE id = 'rss-reddit-machinetranslation'`;
  assert.equal(reddit!.interval_minutes, 360);
  assert.equal(reddit!.config.minIntervalMinutes, 360);

  const [terps] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM sources WHERE id = 'pod-troublesome-terps'`;
  assert.equal(terps!.enabled, false);

  assert.deepEqual(await repairKnownSources(sql), []);
});

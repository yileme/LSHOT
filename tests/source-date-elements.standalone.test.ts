// Real listing date labels can carry a Unix debugging tooltip, while detail rules can select a
// metadata element. Neither should hide the date the configured element actually supplies.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchDetail, fromHtml } from "@aihot/backend/sources/web-list";

const html = `<html><head><meta name="date" content="2026-09-11T19:58:33Z"></head><body>` +
  `<article><a href="/post">A real article</a><span title="Unix: 1789171113866">Sep 11, 2026</span></article></body></html>`;
const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("GALA's month/day/year label is a date only when the source asks for that order", () => {
  const card = `<div class="article col-xs-12 c-article-list"><a class="c-article-list-full-width__title" href="/news/example">A GALA note</a>` +
    `<div class="c-article-list__date" aria-label="Date posted"><span class="sr-only">Date posted</span>10/18/2026</div></div>` +
    `<div class="well box c-article-list"><a class="c-article-list-full-width__title" href="/news/wrapped">Wrapped</a></div>`;
  const config = { url: "https://www.gala-global.org/news/", itemSelector: "div.article.c-article-list", linkSelector: "a.c-article-list-full-width__title", titleSelector: "a.c-article-list-full-width__title", publishedAtSelector: ".c-article-list__date", publishedAtUtcOffset: "+00:00" };
  assert.equal(fromHtml(card, config.url, { config } as never)[0]!.publishedAt, null);
  const dated = fromHtml(card, config.url, { config: { ...config, publishedAtOrder: "mdy" } } as never);
  assert.deepEqual(dated.map((item) => item.url), ["https://www.gala-global.org/news/example"]);
  assert.equal(dated[0]!.publishedAt?.toISOString(), "2026-10-18T00:00:00.000Z");
});

test("a listing uses the visible date when its tooltip is not a publication date", () => {
  const items = fromHtml(html, base, { config: { url: base, itemSelector: "article", publishedAtSelector: "span[title^='Unix:']", publishedAtUtcOffset: "+00:00" } } as never);
  assert.equal(items[0]!.publishedAt?.toISOString(), "2026-09-11T00:00:00.000Z");
});

test("a detail date selector reads meta content and an invalid tooltip does not mask visible text", async () => {
  for (const [publishedAtSelector, expected] of [["meta[name='date']", "2026-09-11T19:58:33.000Z"], ["span", "2026-09-11T00:00:00.000Z"]]) {
    const item = await fetchDetail(base + "/post", { config: { detail: { publishedAtSelector, publishedAtAuthoritative: true, publishedAtUtcOffset: "+00:00" } } } as never, { date: true, title: false, summary: false });
    assert.equal(item.publishedAt?.toISOString(), expected);
  }
});

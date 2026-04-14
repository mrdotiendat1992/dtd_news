import { createClient } from "npm:@supabase/supabase-js@2";

type FeedSource = {
  id: string;
  name: string;
  feed_url: string;
  category: string;
};

type NewsItem = {
  source_id: string;
  title: string;
  url: string;
  summary: string;
  content: string;
  image_url: string;
  published_at: string | null;
  fingerprint: string;
  tokens: string[];
  embedding: number[];
};

type Cluster = {
  items: NewsItem[];
  centroid: number[];
  category: string;
  latestAt: number;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const ADMIN_EMAILS = (Deno.env.get("ADMIN_EMAILS") ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_EMBEDDING_MODEL = Deno.env.get("OPENAI_EMBEDDING_MODEL") ?? "text-embedding-3-small";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
};

const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
  const secret = req.headers.get("x-ingest-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";

  const authorized = await isAuthorized(token, secret);
  if (!authorized) {
    return new Response("unauthorized", { status: 401, headers: corsHeaders });
  }

  const run = await createRun();

  try {
    const sources = await loadSources();
    const items = await loadItems(sources);
    const stored = await upsertItems(items);
    const articles = await buildAggregates(items, sources);

    await finishRun(run.id, "success", sources.length, stored, articles.length, `Ingest thành công: ${articles.length} bài tổng hợp.`);

    return Response.json({ sources: sources.length, items: stored, articles: articles.length, runId: run.id }, { headers: corsHeaders });
  } catch (error) {
    await finishRun(run.id, "error", 0, 0, 0, error?.message ?? "Unknown error");
    return Response.json({ error: error?.message ?? "Unknown error" }, { status: 500, headers: corsHeaders });
  }
});

async function isAuthorized(token: string, secret: string) {
  if (INGEST_SECRET && secret && secret === INGEST_SECRET) return true;
  if (!token) return false;

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.email) return false;

  if (!ADMIN_EMAILS.length) return true;
  return ADMIN_EMAILS.includes(data.user.email.toLowerCase());
}

async function createRun() {
  const { data, error } = await client
    .from("ingest_runs")
    .insert({ status: "running" })
    .select("id,started_at")
    .single();

  if (error) throw error;
  return data;
}

async function finishRun(id: string, status: string, sourcesCount: number, itemsCount: number, articlesCount: number, message: string) {
  const { error } = await client
    .from("ingest_runs")
    .update({
      status,
      sources_count: sourcesCount,
      items_count: itemsCount,
      articles_count: articlesCount,
      message,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

async function loadSources(): Promise<FeedSource[]> {
  const { data, error } = await client
    .from("news_sources")
    .select("id,name,feed_url,category")
    .eq("is_active", true);

  if (error) throw error;
  return data ?? [];
}

async function loadItems(sources: FeedSource[]): Promise<NewsItem[]> {
  const raw: Omit<NewsItem, "embedding">[] = [];

  for (const source of sources) {
    const response = await fetch(source.feed_url, { headers: { "user-agent": "DTD News Aggregator/1.0" } });
    if (!response.ok) continue;

    const xml = await response.text();
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (!doc) continue;

    for (const node of [...doc.querySelectorAll("item")].slice(0, 20)) {
      const title = tagText(node, "title");
      const url = tagText(node, "link");
      if (!title || !url) continue;

      const description = tagText(node, "description");
      const summary = stripHtml(description);
      const content = stripHtml(tagText(node, "content:encoded"));
      const text = `${title} ${summary} ${content}`;

      raw.push({
        source_id: source.id,
        title,
        url,
        summary: summary || title,
        content: content || summary || title,
        image_url: extractImageUrl(description),
        published_at: parseDate(tagText(node, "pubDate")),
        fingerprint: fingerprint(text),
        tokens: tokenSet(text),
      });
    }
  }

  const deduped = dedupeItems(raw);
  const embeddings = await embedTexts(deduped.map((item) => `${item.title}\n${item.summary}\n${item.content}`));

  return deduped.map((item, index) => ({
    ...item,
    embedding: embeddings[index] ?? hashEmbedding(`${item.title} ${item.summary}`),
  }));
}

async function upsertItems(items: NewsItem[]) {
  if (!items.length) return 0;

  const payload = items.map(({ tokens, embedding, ...item }) => item);
  const { error } = await client.from("raw_news_items").upsert(payload, { onConflict: "url" });
  if (error) throw error;
  return payload.length;
}

async function buildAggregates(items: NewsItem[], sources: FeedSource[]) {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const clusters = clusterItems(items, sourceMap);

  const { error: clearError } = await client.from("aggregated_articles").delete();
  if (clearError) throw clearError;

  const articles = [];
  for (const cluster of clusters) {
    const sorted = [...cluster.items].sort((a, b) => dateValue(b.published_at) - dateValue(a.published_at));
    const representative = sorted[0];
    if (!representative) continue;

    const uniqueSources = [...new Set(cluster.items.map((item) => item.source_id))];
    const sourceLinks = sorted.slice(0, 8).map((item) => ({
      title: item.title,
      url: item.url,
      name: sourceMap.get(item.source_id)?.name ?? "Nguồn",
    }));

    const category = sourceMap.get(representative.source_id)?.category ?? "general";
    const topic = deriveTopic(cluster.items);
    const title = makeAggregateTitle(representative.title, category, topic);
    const summary = makeSummary(cluster.items, topic);
    const body = makeBody(cluster.items, sourceMap, topic);
    const slug = `${category}-${topic.slice(0, 4).join("-") || fingerprint(title).slice(0, 8)}-${fingerprint(title).slice(0, 10)}`;

    const payload = {
      slug,
      title,
      summary,
      body,
      category,
      source_count: uniqueSources.length,
      source_links: sourceLinks,
      published_at: representative.published_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await client.from("aggregated_articles").insert(payload);
    if (error) throw error;
    articles.push(payload);
  }

  return articles;
}

function dedupeItems(items: Omit<NewsItem, "embedding">[]) {
  const result: Omit<NewsItem, "embedding">[] = [];

  for (const item of items.sort((a, b) => dateValue(b.published_at) - dateValue(a.published_at))) {
    const duplicate = result.some((existing) => {
      if (existing.source_id === item.source_id && fingerprintKey(existing) === fingerprintKey(item)) return true;
      if (item.fingerprint === existing.fingerprint) return true;
      return titleSimilarityTokens(item.tokens, existing.tokens) >= 0.93;
    });

    if (!duplicate) result.push(item);
  }

  return result;
}

function clusterItems(items: NewsItem[], sourceMap: Map<string, FeedSource>) {
  const clusters: Cluster[] = [];
  const sorted = [...items].sort((a, b) => dateValue(b.published_at) - dateValue(a.published_at));

  for (const item of sorted) {
    const source = sourceMap.get(item.source_id);
    if (!source) continue;

    let bestCluster: Cluster | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      if (cluster.category !== source.category) continue;
      const score = clusterSimilarity(item, cluster);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    const threshold = item.embedding.length >= 512 ? 0.84 : 0.7;
    if (bestCluster && bestScore >= threshold) {
      bestCluster.items.push(item);
      bestCluster.centroid = averageVector(bestCluster.centroid, item.embedding, bestCluster.items.length);
      bestCluster.latestAt = Math.max(bestCluster.latestAt, dateValue(item.published_at));
    } else {
      clusters.push({ items: [item], centroid: [...item.embedding], category: source.category, latestAt: dateValue(item.published_at) });
    }
  }

  return clusters.filter((cluster) => cluster.items.length >= 2 || cluster.items[0]);
}

function clusterSimilarity(item: NewsItem, cluster: Cluster) {
  const vectorScore = cosineSimilarity(item.embedding, cluster.centroid);
  const titleScore = titleSimilarityTokens(item.tokens, cluster.items[0].tokens);
  const freshness = freshnessScore(item.published_at, cluster.latestAt);
  const sourceDiversity = Math.min(new Set(cluster.items.map((member) => member.source_id)).size / 4, 0.12);

  return vectorScore * 0.72 + titleScore * 0.18 + freshness + sourceDiversity;
}

function titleSimilarityTokens(a: string[], b: string[]) {
  return jaccard(new Set(a), new Set(b));
}

function makeAggregateTitle(title: string, category: string, topic: string[]) {
  const clean = title.replace(/^(\[[^\]]+\]\s*)+/, "").trim();
  const base = clean.split(":")[0].trim();
  const topicText = topic.slice(0, 3).join(" ");
  const suffix = topicText || base;

  if (category === "the-gioi") return `Tổng hợp thế giới: ${suffix}`;
  if (category === "kinh-doanh") return `Tổng hợp kinh doanh: ${suffix}`;
  return `Tổng hợp tin nóng: ${suffix}`;
}

function makeSummary(group: NewsItem[], topic: string[]) {
  const lead = group[0]?.summary || group[0]?.title || "Tin nổi bật";
  return `${lead}. Chủ đề chính: ${topic.slice(0, 4).join(", ") || "tổng hợp tin nóng"}.`;
}

function makeBody(group: NewsItem[], sourceMap: Map<string, FeedSource>, topic: string[]) {
  const bullets = group
    .slice(0, 8)
    .map((item) => {
      const source = sourceMap.get(item.source_id);
      return `- ${source?.name ?? "Nguồn"}: ${item.title} (${item.url})`;
    })
    .join("\n");

  return [
    `Chủ đề chính: ${topic.slice(0, 4).join(", ") || "tổng hợp tin nóng"}`,
    "",
    "Tóm tắt nhanh:",
    group[0]?.summary || group[0]?.title || "Không có mô tả",
    "",
    "Các nguồn liên quan:",
    bullets,
  ].join("\n");
}

function deriveTopic(group: NewsItem[]) {
  const frequency = new Map<string, number>();
  for (const item of group) {
    for (const token of item.tokens) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .filter((token) => token.length > 2)
    .slice(0, 6);
}

async function embedTexts(texts: string[]) {
  if (!texts.length) return [] as number[][];

  if (!OPENAI_API_KEY) {
    return texts.map((text) => hashEmbedding(text));
  }

  const batchSize = 32;
  const embeddings: number[][] = [];

  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input: batch }),
    });

    if (!response.ok) {
      return texts.map((text) => hashEmbedding(text));
    }

    const json = await response.json();
    const batchEmbeddings = (json.data ?? []).map((entry: { embedding: number[] }) => entry.embedding);
    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}

function hashEmbedding(value: string, dimensions = 256) {
  const vector = new Array(dimensions).fill(0);
  const tokens = tokenSet(value);

  for (const token of tokens) {
    const index = Math.abs(hashString(token)) % dimensions;
    vector[index] += 1;
  }

  return normalizeVector(vector);
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
}

function averageVector(current: number[], next: number[], count: number) {
  const length = Math.min(current.length, next.length);
  const averaged = new Array(length);
  for (let index = 0; index < length; index++) {
    averaged[index] = (current[index] * (count - 1) + next[index]) / count;
  }
  return normalizeVector(averaged);
}

function cosineSimilarity(a: number[], b: number[]) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    magA += a[index] * a[index];
    magB += b[index] * b[index];
  }

  if (!magA || !magB) return 0;
  return dot / Math.sqrt(magA * magB);
}

function freshnessScore(publishedAt: string | null, latestAt: number) {
  const diffHours = Math.abs(dateValue(publishedAt) - latestAt) / 36e5;
  if (diffHours <= 6) return 0.18;
  if (diffHours <= 12) return 0.12;
  if (diffHours <= 24) return 0.08;
  if (diffHours <= 48) return 0.04;
  return 0;
}

function tokenSet(value: string) {
  const stopwords = new Set(["va", "la", "cho", "voi", "mot", "nhung", "cac", "nay", "the", "o", "tai", "tu", "duoc", "se", "dang", "sau", "trong", "khi", "ve", "lan", "con", "de", "tiep", "theo", "bang", "cua", "tren", "duoi", "nua", "dong", "ong", "ba"]);
  const base = normalize(value).split(" ").filter((token) => token.length > 2 && !stopwords.has(token));
  const bigrams: string[] = [];
  for (let index = 0; index < base.length - 1; index++) {
    bigrams.push(`${base[index]}_${base[index + 1]}`);
  }
  return [...new Set([...base, ...bigrams])];
}

function jaccard(a: Set<string>, b: Set<string>) {
  return intersectionSize(a, b) / Math.max(unionSize(a, b), 1);
}

function intersectionSize(a: Set<string>, b: Set<string>) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function unionSize(a: Set<string>, b: Set<string>) {
  return new Set([...a, ...b]).size;
}

function fingerprintKey(item: Pick<NewsItem, "source_id" | "fingerprint">) {
  return `${item.source_id}:${item.fingerprint}`;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractImageUrl(value: string) {
  const match = value.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] ?? "";
}

function parseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fingerprint(value: string) {
  return normalize(value)
    .split("")
    .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
    .toString(16)
    .replace("-", "n");
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dateValue(value: string | null) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

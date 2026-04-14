const config = window.DTD_NEWS_CONFIG ?? {};
const SUPABASE_URL = config.supabaseUrl || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = config.supabaseAnonKey || "YOUR_ANON_KEY";
const INGEST_SECRET = config.ingestSecret || "";
const INGEST_URL = `${SUPABASE_URL}/functions/v1/ingest-news`;

if (!window.supabase) {
  throw new Error("Supabase JS chưa được tải. Kiểm tra CDN trong admin.html.");
}

const sb = isConfigured() ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const els = {
  secret: document.getElementById("secretInput"),
  runBtn: document.getElementById("runBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  runStatus: document.getElementById("runStatus"),
  logList: document.getElementById("logList"),
  statSources: document.getElementById("statSources"),
  statItems: document.getElementById("statItems"),
  statArticles: document.getElementById("statArticles"),
};

if (INGEST_SECRET) {
  els.secret.value = INGEST_SECRET;
}

els.runBtn.addEventListener("click", runIngest);
els.refreshBtn.addEventListener("click", loadLogs);

loadLogs();

async function runIngest() {
  const secret = els.secret.value.trim();
  if (!secret) {
    setStatus("Nhập secret trước khi chạy ingest.");
    return;
  }

  setStatus("Đang chạy ingest...");
  els.runBtn.disabled = true;

  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "x-ingest-secret": secret },
    });
    if (!res.ok) throw new Error(await res.text());
    const payload = await res.json();
    setStatus(`Hoàn tất: ${payload.articles} bài tổng hợp`);
    await loadLogs();
  } catch (error) {
    setStatus(`Lỗi ingest: ${error.message}`);
  } finally {
    els.runBtn.disabled = false;
  }
}

async function loadLogs() {
  if (!sb) {
    els.logList.innerHTML = '<div class="card">Cấu hình Supabase trước.</div>';
    return;
  }

  const [logsRes, sourcesRes, itemsRes, articlesRes] = await Promise.all([
    sb.from("ingest_runs").select("id,started_at,finished_at,status,sources_count,items_count,articles_count,message").order("started_at", { ascending: false }).limit(10),
    sb.from("news_sources").select("*", { count: "exact", head: true }),
    sb.from("raw_news_items").select("*", { count: "exact", head: true }),
    sb.from("aggregated_articles").select("*", { count: "exact", head: true }),
  ]);

  const logs = logsRes.data ?? [];
  els.statSources.textContent = String(sourcesRes.count ?? 0);
  els.statItems.textContent = String(itemsRes.count ?? 0);
  els.statArticles.textContent = String(articlesRes.count ?? 0);

  els.logList.innerHTML = logs
    .map(
      (log) => `
        <article class="log-card">
          <div class="card-top">
            <span class="tag">${escapeHtml(log.status)}</span>
            <span class="time">${new Date(log.started_at).toLocaleString("vi-VN")}</span>
          </div>
          <div class="log-meta">${log.sources_count} nguồn · ${log.items_count} tin · ${log.articles_count} bài</div>
          <p class="summary">${escapeHtml(log.message || "")}</p>
        </article>`,
    )
    .join("") || '<div class="card">Chưa có log.</div>';
}

function setStatus(message) {
  els.runStatus.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isConfigured() {
  return !SUPABASE_URL.includes("YOUR_PROJECT") && SUPABASE_ANON_KEY !== "YOUR_ANON_KEY";
}

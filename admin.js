const config = window.DTD_NEWS_CONFIG ?? {};
const SUPABASE_URL = config.supabaseUrl || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = config.supabaseAnonKey || "YOUR_ANON_KEY";
const INGEST_URL = `${SUPABASE_URL}/functions/v1/ingest-news`;

if (!window.supabase) {
  throw new Error("Supabase JS chưa được tải. Kiểm tra CDN trong admin.html.");
}

const sb = isConfigured() ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const els = {
  loginPanel: document.getElementById("loginPanel"),
  dashboardPanel: document.getElementById("dashboardPanel"),
  logPanel: document.getElementById("logPanel"),
  email: document.getElementById("emailInput"),
  password: document.getElementById("passwordInput"),
  signInBtn: document.getElementById("signInBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  authStatus: document.getElementById("authStatus"),
  runBtn: document.getElementById("runBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  runStatus: document.getElementById("runStatus"),
  logList: document.getElementById("logList"),
  statSources: document.getElementById("statSources"),
  statItems: document.getElementById("statItems"),
  statArticles: document.getElementById("statArticles"),
  dailyChart: document.getElementById("dailyChart"),
  topicChart: document.getElementById("topicChart"),
};

const state = {
  session: null,
  articles: [],
  logs: [],
};

if (!sb) {
  els.authStatus.textContent = "Cấu hình `config.dev.js` hoặc `config.prod.js` trước khi đăng nhập.";
} else {
  els.signInBtn.addEventListener("click", signIn);
  els.signOutBtn.addEventListener("click", signOut);
  els.runBtn.addEventListener("click", runIngest);
  els.refreshBtn.addEventListener("click", loadDashboard);

  sb.auth.getSession().then(({ data }) => {
    setSession(data.session);
  });

  sb.auth.onAuthStateChange((_event, session) => {
    setSession(session);
  });
}

function setSession(session) {
  state.session = session;
  const loggedIn = Boolean(session?.user);
  els.loginPanel.classList.toggle("hidden", loggedIn);
  els.dashboardPanel.classList.toggle("hidden", !loggedIn);
  els.logPanel.classList.toggle("hidden", !loggedIn);
  els.signOutBtn.classList.toggle("hidden", !loggedIn);
  els.refreshBtn.classList.toggle("hidden", !loggedIn);

  if (loggedIn) {
    els.authStatus.textContent = `Đã đăng nhập: ${session.user.email}`;
    loadDashboard();
  } else {
    els.authStatus.textContent = "Hãy đăng nhập bằng tài khoản Supabase admin.";
  }
}

async function signIn() {
  if (!sb) return;
  els.authStatus.textContent = "Đang đăng nhập...";
  const email = els.email.value.trim();
  const password = els.password.value;

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    els.authStatus.textContent = `Lỗi: ${error.message}`;
  }
}

async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  state.session = null;
}

async function runIngest() {
  if (!sb) return;
  const token = state.session?.access_token;
  if (!token) {
    setRunStatus("Cần đăng nhập trước.");
    return;
  }

  setRunStatus("Đang chạy ingest...");
  els.runBtn.disabled = true;

  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(await res.text());
    const payload = await res.json();
    setRunStatus(`Hoàn tất: ${payload.articles} bài tổng hợp`);
    await loadDashboard();
  } catch (error) {
    setRunStatus(`Lỗi ingest: ${error.message}`);
  } finally {
    els.runBtn.disabled = false;
  }
}

async function loadDashboard() {
  if (!sb || !state.session) return;

  const [logsRes, sourcesRes, itemsRes, articlesRes, articleDataRes] = await Promise.all([
    sb.from("ingest_runs").select("id,started_at,finished_at,status,sources_count,items_count,articles_count,message").order("started_at", { ascending: false }).limit(10),
    sb.from("news_sources").select("*", { count: "exact", head: true }),
    sb.from("raw_news_items").select("*", { count: "exact", head: true }),
    sb.from("aggregated_articles").select("*", { count: "exact", head: true }),
    sb.from("aggregated_articles").select("title,summary,category,published_at").order("published_at", { ascending: false }).limit(120),
  ]);

  state.logs = logsRes.data ?? [];
  state.articles = articleDataRes.data ?? [];

  els.statSources.textContent = String(sourcesRes.count ?? 0);
  els.statItems.textContent = String(itemsRes.count ?? 0);
  els.statArticles.textContent = String(articlesRes.count ?? 0);

  renderLogs();
  renderCharts();
}

function renderLogs() {
  els.logList.innerHTML = state.logs
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

function renderCharts() {
  const daily = groupByDay(state.articles);
  const topic = groupByTopic(state.articles);
  renderBarChart(els.dailyChart, daily);
  renderBarChart(els.topicChart, topic);
}

function groupByDay(items) {
  const map = new Map();
  for (const item of items) {
    const key = new Date(item.published_at).toISOString().slice(0, 10);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function groupByTopic(items) {
  const map = new Map();
  for (const item of items) {
    for (const token of topTokens(`${item.title} ${item.summary || ""}`)) {
      map.set(token, (map.get(token) ?? 0) + 1);
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function renderBarChart(container, entries) {
  const max = Math.max(...entries.map(([, value]) => value), 1);
  container.innerHTML = entries
    .map(
      ([label, value]) => `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max((value / max) * 100, 6)}%"></div></div>
          <div class="bar-value">${value}</div>
        </div>`,
    )
    .join("") || '<div class="card">Chưa có dữ liệu.</div>';
}

function setRunStatus(message) {
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

function topTokens(value) {
  const stopwords = new Set(["va", "la", "cho", "voi", "mot", "nhung", "cac", "nay", "the", "o", "tai", "tu", "duoc", "se", "dang", "sau", "trong", "khi", "ve", "lan", "con", "de", "tiep", "theo", "tin", "bao", "thoi", "su", "tong", "hop"]);
  return [...new Set(
    String(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((token) => token.length > 2 && !stopwords.has(token)),
  )].slice(0, 6);
}

function isConfigured() {
  return !SUPABASE_URL.includes("YOUR_PROJECT") && SUPABASE_ANON_KEY !== "YOUR_ANON_KEY";
}

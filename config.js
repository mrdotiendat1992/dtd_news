(function () {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  const env = new URLSearchParams(window.location.search).get("env") || (isLocal ? "dev" : "prod");
  window.DTD_NEWS_CONFIG = env === "prod"
    ? (window.DTD_NEWS_CONFIG_PROD ?? window.DTD_NEWS_CONFIG_DEV ?? {})
    : (window.DTD_NEWS_CONFIG_DEV ?? window.DTD_NEWS_CONFIG_PROD ?? {});
  window.DTD_NEWS_ENV = env;
})();

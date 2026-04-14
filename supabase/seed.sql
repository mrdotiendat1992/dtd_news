insert into public.news_sources (name, feed_url, category)
values
  ('VnExpress - Thời sự', 'https://vnexpress.net/rss/thoi-su.rss', 'thoi-su'),
  ('VnExpress - Kinh doanh', 'https://vnexpress.net/rss/kinh-doanh.rss', 'kinh-doanh'),
  ('VnExpress - Thế giới', 'https://vnexpress.net/rss/the-gioi.rss', 'the-gioi'),
  ('VOV - Tin thời sự', 'https://vov.vn/rss/tin-moi.rss', 'thoi-su'),
  ('VietnamPlus - Thời sự', 'https://www.vietnamplus.vn/rss/thoisu.rss', 'thoi-su')
on conflict (feed_url) do nothing;

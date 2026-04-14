# DTD News

Web app tin tức tổng hợp dùng Supabase làm backend và HTML/CSS/JS làm frontend.

## Tính năng

- Cào tin từ các nguồn RSS chính thống
- Gom các tin liên quan thành bài tổng hợp
- Lưu dữ liệu trên Supabase Postgres
- Frontend tĩnh để xem bài tổng hợp theo chủ đề

## Cấu trúc

- `supabase/schema.sql`: schema + dữ liệu nguồn mẫu
- `supabase/functions/ingest-news/index.ts`: edge function lấy RSS và tạo bài tổng hợp
- `index.html`, `article.html`, `admin.html`, `styles.css`, `app.js`, `article.js`, `admin.js`, `config.dev.js`, `config.prod.js`, `config.js`: frontend
- `supabase/seed.sql`: seed nguồn RSS mẫu
- `supabase/config.toml`: cấu hình Supabase CLI
- `scripts/deploy.ps1`: script deploy một lệnh cho Supabase CLI

## Cấu hình

1. Tạo project Supabase.
2. Chạy `supabase/schema.sql` trong SQL Editor.
3. Deploy edge function `ingest-news`.
4. Set secrets cho function:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `INGEST_SECRET`
   - `ADMIN_EMAILS` (tuỳ chọn, phân tách bằng dấu phẩy)
   - `OPENAI_API_KEY` (tuỳ chọn, để bật embedding mạnh)
5. Mở `config.dev.js` và `config.prod.js` để điền `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `INGEST_SECRET`.

Admin login dùng Supabase Auth email/password. Chỉ email trong `ADMIN_EMAILS` mới được chạy ingest.

Frontend sẽ tự chọn config theo `?env=dev|prod` hoặc hostname.

Trang admin: mở `admin.html` để chạy ingest và xem log.

## Deploy bằng Supabase CLI

```bash
supabase init
supabase link --project-ref <project-ref>
supabase db push
supabase db reset --linked
supabase secrets set SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key> INGEST_SECRET=<secret>
supabase functions deploy ingest-news
```

Hoặc dùng một lệnh PowerShell:

```powershell
.\scripts\deploy.ps1 -ProjectRef <project-ref> -SupabaseUrl https://<project-ref>.supabase.co -ServiceRoleKey <service-role-key> -IngestSecret <secret>
```

Nếu muốn giới hạn email admin và bật embedding:

```powershell
.\scripts\deploy.ps1 -ProjectRef <project-ref> -SupabaseUrl https://<project-ref>.supabase.co -ServiceRoleKey <service-role-key> -IngestSecret <secret> -AdminEmails admin@domain.com -OpenAIApiKey <openai-key>
```

Nếu muốn seed lại nguồn RSS:

```bash
supabase db reset --linked
```

## Chạy ingest thủ công

Gọi edge function với header:

```bash
x-ingest-secret: <INGEST_SECRET>
```

## Ghi chú

- Dự án dùng RSS thay vì cào HTML trực tiếp để ổn định hơn và giảm rủi ro vi phạm điều khoản nguồn tin.
- Phần tổng hợp dùng clustering theo chủ đề và độ giống tiêu đề/nội dung.

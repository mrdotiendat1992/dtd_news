param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRef,

  [Parameter(Mandatory = $true)]
  [string]$SupabaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$ServiceRoleKey,

  [Parameter(Mandatory = $true)]
  [string]$IngestSecret,

  [Parameter(Mandatory = $false)]
  [string]$AdminEmails = "",

  [Parameter(Mandatory = $false)]
  [string]$OpenAIApiKey = ""
)

$ErrorActionPreference = "Stop"

supabase link --project-ref $ProjectRef
supabase db push
if ($AdminEmails -and $AdminEmails.Trim().Length -gt 0) {
  supabase secrets set SUPABASE_URL=$SupabaseUrl SUPABASE_SERVICE_ROLE_KEY=$ServiceRoleKey INGEST_SECRET=$IngestSecret ADMIN_EMAILS=$AdminEmails OPENAI_API_KEY=$OpenAIApiKey
} else {
  supabase secrets set SUPABASE_URL=$SupabaseUrl SUPABASE_SERVICE_ROLE_KEY=$ServiceRoleKey INGEST_SECRET=$IngestSecret OPENAI_API_KEY=$OpenAIApiKey
}
supabase functions deploy ingest-news

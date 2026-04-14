param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRef,

  [Parameter(Mandatory = $true)]
  [string]$SupabaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$ServiceRoleKey,

  [Parameter(Mandatory = $true)]
  [string]$IngestSecret
)

$ErrorActionPreference = "Stop"

supabase link --project-ref $ProjectRef
supabase db push
supabase secrets set SUPABASE_URL=$SupabaseUrl SUPABASE_SERVICE_ROLE_KEY=$ServiceRoleKey INGEST_SECRET=$IngestSecret
supabase functions deploy ingest-news

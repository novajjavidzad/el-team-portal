/**
 * SharePoint → core.case_documents Sync
 *
 * Uses Microsoft Graph API with Azure AD client credentials (app-only auth).
 * Reads sharepoint_folder_url from core.cases, resolves the Graph drive item,
 * lists all files in the folder, and upserts to core.case_documents.
 *
 * Prerequisites:
 *   - Azure AD app needs SharePoint permission: Sites.Read.All (application)
 *   - Admin consent must be granted in Azure portal
 *
 * Usage:
 *   node scripts/sync-sharepoint-docs.mjs --deal-id=57782494293
 *   node scripts/sync-sharepoint-docs.mjs --all
 *   node scripts/sync-sharepoint-docs.mjs --all --dry-run
 */

import { createClient } from '@supabase/supabase-js'

const TENANT_ID     = process.env.AZURE_AD_TENANT_ID     || '6c5c63d2-425b-4a52-8bad-8059713fb96e'
const CLIENT_ID     = process.env.AZURE_AD_CLIENT_ID     || 'aad6b8b9-2590-44c5-9e63-1b4b9ce7f869'
const CLIENT_SECRET = process.env.AZURE_AD_CLIENT_SECRET
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing: AZURE_AD_CLIENT_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const coreDb   = supabase.schema('core')
const dryRun   = process.argv.includes('--dry-run')

// ─── Microsoft Graph auth (app-only / client credentials) ──

let _graphToken = null

async function getGraphToken() {
  if (_graphToken) return _graphToken
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  )
  const data = await res.json()
  if (!data.access_token) throw new Error(`Graph auth failed: ${JSON.stringify(data)}`)
  _graphToken = data.access_token
  return _graphToken
}

async function graph(path) {
  const token = await getGraphToken()
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph ${res.status} ${path}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

// ─── URL → Graph drive item ─────────────────────────────────
// SharePoint URL format:
//   https://rockpointgrowth.sharepoint.com/sites/Legal/Shared%20Documents/Lemon%20Law/...
// Graph path:
//   /sites/rockpointgrowth.sharepoint.com:/sites/Legal:/drive/root:/Lemon Law/.../children

function parseSharePointUrl(url) {
  const parsed = new URL(url)
  const hostname = parsed.hostname  // rockpointgrowth.sharepoint.com
  // Extract site path (/sites/Legal) and the rest
  const match = parsed.pathname.match(/^(\/sites\/[^/]+)(.*)/)
  if (!match) throw new Error(`Cannot parse SharePoint URL: ${url}`)
  const sitePath    = match[1]                                    // /sites/Legal
  const folderPath  = decodeURIComponent(match[2]).replace(/^\/Shared Documents/, '')
                                                   .replace(/^\//, '')
  // folderPath: "Lemon Law/Potential Clients/Chad Ferrell v. FCA US LLC"
  return { hostname, sitePath, folderPath }
}

async function listFolderFiles(sharePointUrl) {
  const { hostname, sitePath, folderPath } = parseSharePointUrl(sharePointUrl)

  // 1. Resolve site ID
  const site = await graph(`/sites/${hostname}:${sitePath}`)
  const siteId = site.id

  // 2. Get default drive (Shared Documents)
  const drive = await graph(`/sites/${siteId}/drive`)
  const driveId = drive.id

  // 3. List files in folder (non-recursive for now — just top-level)
  const encodedPath = encodeURIComponent(folderPath)
  const items = await graph(`/drives/${driveId}/root:/${encodedPath}:/children?$top=100&$select=id,name,file,size,webUrl,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy`)

  const files = (items.value ?? []).filter(i => i.file) // files only, no subfolders

  return { driveId, siteId, files }
}

function fileExtension(name) {
  const parts = name.split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : null
}

function mapFile(caseId, driveId, f) {
  return {
    case_id:              caseId,
    sharepoint_item_id:   f.id,
    sharepoint_drive_id:  driveId,
    name:                 f.name,
    file_extension:       fileExtension(f.name),
    size_bytes:           f.size ?? null,
    mime_type:            f.file?.mimeType ?? null,
    web_url:              f.webUrl ?? null,
    download_url:         null, // short-lived; fetch on demand
    created_at_source:    f.createdDateTime ?? null,
    modified_at_source:   f.lastModifiedDateTime ?? null,
    created_by:           f.createdBy?.user?.displayName ?? null,
    modified_by:          f.lastModifiedBy?.user?.displayName ?? null,
    synced_at:            new Date().toISOString(),
    updated_at:           new Date().toISOString(),
    is_deleted:           false,
  }
}

// ─── Sync one case ──────────────────────────────────────────

async function syncCase(caseRow) {
  if (!caseRow.sharepoint_folder_url) {
    console.log(`  ⚠ No SharePoint URL — deal ${caseRow.hubspot_deal_id}`)
    return { synced: 0, status: 'no_url' }
  }

  console.log(`  📁 ${caseRow.sharepoint_folder_title ?? caseRow.sharepoint_folder_url.split('/').pop()}`)

  let driveId, files
  try {
    const result = await listFolderFiles(caseRow.sharepoint_folder_url)
    driveId = result.driveId
    files   = result.files
  } catch (e) {
    console.error(`  ✗ Graph error: ${e.message}`)
    return { synced: 0, status: 'graph_error', error: e.message }
  }

  console.log(`  → ${files.length} file(s) found`)

  if (dryRun) {
    files.forEach(f => console.log(`    [dry-run] ${f.name} (${(f.size / 1024).toFixed(1)} KB)`))
    return { synced: files.length, status: 'dry_run' }
  }

  if (files.length === 0) return { synced: 0, status: 'empty' }

  const rows = files.map(f => mapFile(caseRow.id, driveId, f))
  const { error } = await coreDb
    .from('case_documents')
    .upsert(rows, { onConflict: 'case_id,sharepoint_item_id', ignoreDuplicates: false })

  if (error) {
    console.error(`  ✗ Upsert error: ${error.message}`)
    return { synced: 0, status: 'db_error', error: error.message }
  }

  return { synced: files.length, status: 'ok' }
}

// ─── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2)
const dealIdArg  = args.find(a => a.startsWith('--deal-id='))?.split('=')[1]
const dealIdsArg = args.find(a => a.startsWith('--deal-ids='))?.split('=')[1]
const allFlag    = args.includes('--all')

let cases = []

if (dealIdArg) {
  const { data } = await coreDb.from('cases').select('id,hubspot_deal_id,sharepoint_folder_url,sharepoint_folder_title').eq('hubspot_deal_id', dealIdArg).single()
  if (!data) { console.error('Case not found'); process.exit(1) }
  cases = [data]
} else if (dealIdsArg) {
  const ids = dealIdsArg.split(',').map(s => s.trim())
  const { data } = await coreDb.from('cases').select('id,hubspot_deal_id,sharepoint_folder_url,sharepoint_folder_title').in('hubspot_deal_id', ids)
  cases = data ?? []
} else if (allFlag) {
  const { data } = await coreDb.from('cases').select('id,hubspot_deal_id,sharepoint_folder_url,sharepoint_folder_title').eq('is_deleted', false).not('sharepoint_folder_url', 'is', null)
  cases = data ?? []
  console.log(`Found ${cases.length} cases with SharePoint URLs`)
} else {
  console.error('Usage: --deal-id=<id>  |  --deal-ids=<id1,id2>  |  --all  [--dry-run]')
  process.exit(1)
}

if (dryRun) console.log('\n⚠ DRY RUN — no data will be written\n')

let totalFiles = 0, totalErrors = 0

for (const c of cases) {
  console.log(`\n▶  Deal ${c.hubspot_deal_id}`)
  const result = await syncCase(c)
  if (result.status === 'ok' || result.status === 'dry_run') totalFiles += result.synced
  else if (result.status === 'graph_error' || result.status === 'db_error') totalErrors++
  await new Promise(r => setTimeout(r, 200))
}

console.log(`\n✅ Done — ${totalFiles} files synced | ${totalErrors} errors`)
if (totalErrors > 0) console.log('\nNote: Graph errors usually mean the Azure AD app needs Sites.Read.All permission granted by an admin.')

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Repo       = "imjszhang/js-eyes"
$SkillName  = "js-eyes"
$SiteUrl    = "https://js-eyes.com"
$InstallDir = if ($env:JS_EYES_DIR) { $env:JS_EYES_DIR } else { ".\skills" }

function Write-Info  ($msg) { Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "[ok]    $msg" -ForegroundColor Green }
function Write-Warn  ($msg) { Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Write-Err   ($msg) { Write-Host "[error] $msg" -ForegroundColor Red }

function Try-Download {
    param([string]$Dest, [string[]]$Urls)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    foreach ($url in $Urls) {
        Write-Info "Trying: $url"
        try {
            Invoke-WebRequest $url -OutFile $Dest -UseBasicParsing -TimeoutSec 15
            return $true
        } catch {
            Write-Warn "Failed, trying next source..."
        }
    }
    return $false
}

# ── Prerequisites ─────────────────────────────────────────────────────

try   { $null = Get-Command node -ErrorAction Stop }
catch { Write-Err "Node.js is required. Install: https://nodejs.org/"; exit 1 }

try   { $null = Get-Command npm -ErrorAction Stop }
catch { Write-Err "npm is required."; exit 1 }

# ── Resolve latest version ────────────────────────────────────────────

Write-Info "Fetching latest release info..."
$Tag = $null
try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing -TimeoutSec 10
    $Tag = $release.tag_name
} catch {}

if ($Tag) {
    Write-Info "Latest version: $Tag"
} else {
    Write-Warn "Could not determine latest release - using latest available."
}

# ── Prepare target directory ──────────────────────────────────────────

$Target = Join-Path $InstallDir $SkillName

if (Test-Path $Target) {
    Write-Warn "Directory already exists: $Target"
    if ($env:JS_EYES_FORCE -ne "1") {
        $reply = Read-Host "  Overwrite? [y/N]"
        if ($reply -notin @('y', 'Y')) {
            Write-Info "Aborted."
            exit 0
        }
    }
    Remove-Item $Target -Recurse -Force
}

New-Item -ItemType Directory -Path $Target -Force | Out-Null

# ── Download with multi-source fallback ───────────────────────────────

$TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("js-eyes-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    $SkillZip  = Join-Path $TmpDir "skill.zip"
    $ArchiveZip = Join-Path $TmpDir "archive.zip"
    $UseSkillZip = $false

    $UrlsSkillZip = @("$SiteUrl/js-eyes-skill.zip")
    $UrlsArchive = @()
    if ($Tag) {
        $UrlsArchive += "https://github.com/$Repo/archive/refs/tags/$Tag.zip"
    } else {
        $UrlsArchive += "https://github.com/$Repo/archive/refs/heads/main.zip"
    }

    Write-Info "Downloading skill bundle..."

    if (Try-Download -Dest $SkillZip -Urls $UrlsSkillZip) {
        $UseSkillZip = $true
    } elseif (Try-Download -Dest $ArchiveZip -Urls $UrlsArchive) {
        $UseSkillZip = $false
    } else {
        Write-Err "All download sources failed. Check your network and try again."
        exit 1
    }

    # ── Extract ───────────────────────────────────────────────────────

    Write-Info "Extracting skill bundle..."

    if ($UseSkillZip) {
        Expand-Archive -Path $SkillZip -DestinationPath $Target -Force
    } else {
        $ExtractDir = Join-Path $TmpDir "extract"
        Expand-Archive -Path $ArchiveZip -DestinationPath $ExtractDir -Force
        $Extracted = Get-ChildItem $ExtractDir -Directory | Select-Object -First 1
        if (-not $Extracted) { Write-Err "Failed to extract archive."; exit 1 }

        $BundleFiles = @('SKILL.md', 'SECURITY.md', 'package.json', 'LICENSE')
        foreach ($f in $BundleFiles) {
            $src = Join-Path $Extracted.FullName $f
            if (Test-Path $src) { Copy-Item $src $Target }
        }
        foreach ($d in @('openclaw-plugin', 'server', 'clients')) {
            $src = Join-Path $Extracted.FullName $d
            if (Test-Path $src) { Copy-Item $src (Join-Path $Target $d) -Recurse }
        }
    }
} finally {
    Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ── Install dependencies ──────────────────────────────────────────────

Write-Info "Installing dependencies..."
Push-Location $Target
try { npm install --production 2>$null } catch { npm install }
Pop-Location

# ── Done ──────────────────────────────────────────────────────────────

$AbsTarget  = (Resolve-Path $Target).Path
$PluginPath = (Join-Path $AbsTarget "openclaw-plugin") -replace '\\', '/'

Write-Ok "JS Eyes installed to: $AbsTarget"
Write-Host ""
Write-Host ([string]::new([char]0x2501, 57))
Write-Host "  Next: register the plugin in ~/.openclaw/openclaw.json"
Write-Host ""
Write-Host "  Add to plugins.load.paths:"
Write-Host "    `"$PluginPath`""
Write-Host ""
Write-Host "  Add to plugins.entries:"
Write-Host '    "js-eyes": {'
Write-Host '      "enabled": true,'
Write-Host '      "config": { "serverPort": 18080, "autoStartServer": true }'
Write-Host '    }'
Write-Host ""
Write-Host "  Then restart OpenClaw."
Write-Host ([string]::new([char]0x2501, 57))

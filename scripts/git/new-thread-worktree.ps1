[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Name,

  [string]$Base = "origin/main",

  [string]$ParentDir = "",

  [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"

function Invoke-GitCapture {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args
  )

  $result = & git @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("git {0}`n{1}" -f ($Args -join " "), ($result | Out-String).Trim())
  }

  return ($result | Out-String).Trim()
}

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Args
  )

  & git @Args
  if ($LASTEXITCODE -ne 0) {
    throw ("git {0} failed with exit code {1}" -f ($Args -join " "), $LASTEXITCODE)
  }
}

function New-Slug {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $slug = $Value.ToLowerInvariant() -replace "[^a-z0-9]+", "-"
  $slug = $slug.Trim("-")
  if ([string]::IsNullOrWhiteSpace($slug)) {
    throw "Thread name must contain at least one letter or number."
  }

  return $slug
}

$repoRoot = Invoke-GitCapture -Args @("rev-parse", "--show-toplevel")
$repoName = Split-Path -Path $repoRoot -Leaf
$currentBranch = Invoke-GitCapture -Args @("branch", "--show-current")
$status = Invoke-GitCapture -Args @("status", "--porcelain")

if ($status -and -not $AllowDirty) {
  throw @"
Current worktree is dirty on branch '$currentBranch'.

Create new threads from a clean tree so uncommitted edits do not leak across branches.
If you really want to proceed, rerun with -AllowDirty.
"@
}

$slug = New-Slug -Value $Name
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$branch = "thread/$stamp-$slug"

if ([string]::IsNullOrWhiteSpace($ParentDir)) {
  $ParentDir = Join-Path (Split-Path -Path $repoRoot -Parent) "_threads"
}

$ParentDir = [System.IO.Path]::GetFullPath($ParentDir)
New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null

$worktreePath = Join-Path $ParentDir ("{0}-{1}-{2}" -f $repoName, $stamp, $slug)

Invoke-Git -Args @("fetch", "origin", "--prune")

& git show-ref --verify --quiet ("refs/heads/{0}" -f $branch)
if ($LASTEXITCODE -eq 0) {
  throw "Local branch '$branch' already exists."
}

& git show-ref --verify --quiet ("refs/remotes/origin/{0}" -f $branch)
if ($LASTEXITCODE -eq 0) {
  throw "Remote branch '$branch' already exists."
}

if (Test-Path $worktreePath) {
  throw "Worktree path already exists: $worktreePath"
}

Invoke-Git -Args @("worktree", "add", "-b", $branch, $worktreePath, $Base)

Write-Host ""
Write-Host "Created isolated thread worktree."
Write-Host ("  Repo:    {0}" -f $repoName)
Write-Host ("  Branch:  {0}" -f $branch)
Write-Host ("  Path:    {0}" -f $worktreePath)
Write-Host ("  Base:    {0}" -f $Base)
Write-Host ""
Write-Host "Next step:"
Write-Host ("  Set-Location '{0}'" -f $worktreePath)

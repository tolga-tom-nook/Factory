#!/usr/bin/env bash
# upload-sybil-music.sh — Upload Sybil music tracks to R2 under sybil-music/ prefix.
#
# Run once after retrieving R2 credentials from GCP Secret Manager:
#   R2_ACCESS_KEY_ID     → GCP SM secret r2-access-key-id (or R2_ACCESS_KEY_ID)
#   R2_SECRET_ACCESS_KEY → GCP SM secret r2-secret-access-key (or R2_SECRET_ACCESS_KEY)
#   R2_BUCKET_NAME       → factory-videos (confirmed in runbook)
#   CF_ACCOUNT_ID        → a1c8a33cbe8a3c9e260480433a0dbb06
#
# Prereqs: AWS CLI v2 installed.
#
# After upload, set SYBIL_MUSIC_BASE_URL on the Cloud Run render service:
#   gcloud run services update video-render-service \
#     --region us-central1 \
#     --update-env-vars SYBIL_MUSIC_BASE_URL=https://media.selfprime.net
# (Replace media.selfprime.net with the actual R2_PUBLIC_DOMAIN from GCP SM)
#
# Track mapping used:
#   forge/chronos  → Chronos Under Stone.mp3
#   forge/eros     → Eros Drift.mp3
#   forge/aether   → Aether Drift.mp3
#   forge/lux      → Lux.mp3
#   forge/phoenix  → Ashrise.mp3         (fire/rising theme)
#   forge/self     → Centered Stillness.mp3 (grounded, pure-space)
#   type/generator            → Interwoven Pulse.mp3
#   type/manifesting_generator → Manifesting Generator.mp3
#   type/projector             → Projector.mp3
#   type/manifestor            → Manifestor.mp3
#   type/reflector             → Moonwater Reflector.mp3

set -euo pipefail

: "${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY}"
: "${CF_ACCOUNT_ID:=a1c8a33cbe8a3c9e260480433a0dbb06}"
: "${R2_BUCKET_NAME:=factory-videos}"

ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

upload() {
  local key="$1"
  local file="$2"
  echo "→ s3://${R2_BUCKET_NAME}/sybil-music/${key}"
  aws s3 cp "$file" \
    "s3://${R2_BUCKET_NAME}/sybil-music/${key}" \
    --endpoint-url "$ENDPOINT" \
    --content-type "audio/mpeg" \
    --no-progress
}

# Restore tracks from git history (they were removed from working tree)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$REPO_ROOT"
GIT_COMMIT="57e658fe45f7c85fba7f6424c1bea1e68a617a60"

echo "Restoring tracks from git history (commit $GIT_COMMIT)…"
git show "$GIT_COMMIT:selfprime_music/Chronos Under Stone.mp3"     > "$TMP/chronos.mp3"
git show "$GIT_COMMIT:selfprime_music/Eros Drift.mp3"              > "$TMP/eros.mp3"
git show "$GIT_COMMIT:selfprime_music/Aether Drift.mp3"            > "$TMP/aether.mp3"
git show "$GIT_COMMIT:selfprime_music/Lux.mp3"                     > "$TMP/lux.mp3"
git show "$GIT_COMMIT:selfprime_music/Ashrise.mp3"                 > "$TMP/phoenix.mp3"
git show "$GIT_COMMIT:selfprime_music/Centered Stillness.mp3"      > "$TMP/self.mp3"
git show "$GIT_COMMIT:selfprime_music/Interwoven Pulse.mp3"        > "$TMP/generator.mp3"
git show "$GIT_COMMIT:selfprime_music/Manifesting Generator.mp3"   > "$TMP/manifesting_generator.mp3"
git show "$GIT_COMMIT:selfprime_music/Projector.mp3"               > "$TMP/projector.mp3"
git show "$GIT_COMMIT:selfprime_music/Manifestor.mp3"              > "$TMP/manifestor.mp3"
git show "$GIT_COMMIT:selfprime_music/Moonwater Reflector.mp3"     > "$TMP/reflector.mp3"

echo ""
echo "Uploading to R2 (${R2_BUCKET_NAME})…"
upload "forge/chronos.mp3"              "$TMP/chronos.mp3"
upload "forge/eros.mp3"                 "$TMP/eros.mp3"
upload "forge/aether.mp3"              "$TMP/aether.mp3"
upload "forge/lux.mp3"                  "$TMP/lux.mp3"
upload "forge/phoenix.mp3"              "$TMP/phoenix.mp3"
upload "forge/self.mp3"                 "$TMP/self.mp3"
upload "type/generator.mp3"             "$TMP/generator.mp3"
upload "type/manifesting_generator.mp3" "$TMP/manifesting_generator.mp3"
upload "type/projector.mp3"             "$TMP/projector.mp3"
upload "type/manifestor.mp3"            "$TMP/manifestor.mp3"
upload "type/reflector.mp3"             "$TMP/reflector.mp3"

echo ""
echo "✓ All 11 tracks uploaded."
echo ""
echo "Next: set SYBIL_MUSIC_BASE_URL on Cloud Run."
echo "  1. Get R2_PUBLIC_DOMAIN from GCP SM (e.g. 'media.selfprime.net')"
echo "  2. Run:"
echo "       gcloud run services update video-render-service \\"
echo "         --region us-central1 \\"
echo "         --update-env-vars SYBIL_MUSIC_BASE_URL=https://\${R2_PUBLIC_DOMAIN}"
echo ""
echo "  3. Verify music resolves:"
echo "       curl -I https://\${R2_PUBLIC_DOMAIN}/sybil-music/forge/self.mp3"
echo "       # expect HTTP 200"

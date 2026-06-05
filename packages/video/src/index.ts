import { InternalError } from '@latimer-woods-tech/errors';

// ---------------------------------------------------------------------------
// Energy Blueprint Video Engine (I1 Slice 0) — shared contract layer.
// Domain types, the signed render request/callback contract + HMAC helper, and
// the pure credit cost function. See docs/architecture/I1_PERSONAL_BLUEPRINT_VIDEO.md.
// ---------------------------------------------------------------------------

export type {
  VideoSource,
  VideoFormat,
  ShareVisibility,
  VideoObjectStatus,
  CreditTxnKind,
  CompositionSpec,
  VideoObject,
  VideoSubscription,
  AccountLink,
  ModerationRecord,
  SegmentContext,
  SegmentResult,
  SegmentRenderer,
} from './engine-types.js';

export type {
  ResolvedSegment,
  RenderRequest,
  RenderCallback,
  VerifyFailureReason,
} from './render-contract.js';
export {
  RENDER_HMAC_SECRET_NAME,
  RENDER_REPLAY_TOLERANCE_SECONDS,
  RENDER_CONTRACT_VERSION,
  signRenderPayload,
  verifyRenderSignature,
} from './render-contract.js';

export type { CreditPolicy, CostFn } from './credit.js';
export { costFn } from './credit.js';

// ---------------------------------------------------------------------------
// Env / configuration
// ---------------------------------------------------------------------------

/**
 * Environment bindings required by the video package.
 * Wire these from your Hono context or Worker environment.
 */
export interface VideoEnv {
  /** Cloudflare account ID (not the API token). */
  CF_ACCOUNT_ID: string;
  /** Cloudflare API token with Stream:Edit + Stream:Read permissions. */
  CF_STREAM_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Minimal R2 bucket interface
// Mirrors the Cloudflare Workers R2Bucket binding without importing
// @cloudflare/workers-types, keeping the package platform-neutral.
// ---------------------------------------------------------------------------

/**
 * Minimal subset of an R2Object body needed by this package.
 */
export interface R2ObjectBody {
  /** Stream the raw bytes. */
  readonly body: ReadableStream;
  /** Read the full body as an ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Read the full body as a UTF-8 string. */
  text(): Promise<string>;
}

/**
 * Minimal R2Bucket interface compatible with the Cloudflare Workers binding.
 * Accept this type from your Worker/Hono environment and pass it through.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Cloudflare Stream processing state for an uploaded video.
 */
export type VideoStatus =
  | 'queued'
  | 'inprogress'
  | 'peerupload'
  | 'uploading'
  | 'progress'
  | 'ready'
  | 'error';

/**
 * A Cloudflare Stream video resource as returned by the Stream REST API.
 */
export interface StreamVideo {
  /** Unique Stream video identifier. */
  uid: string;
  /** Thumbnail image URL. */
  thumbnail: string;
  /** Thumbnail timestamp as a percentage of video duration (0–1). */
  thumbnailTimestampPct: number;
  /** Whether the video has finished processing and is ready to play. */
  readyToStream: boolean;
  /** Current processing status. */
  status: {
    state: VideoStatus;
    errorReasonCode?: string;
    errorReasonText?: string;
  };
  /** Arbitrary key-value metadata attached on upload. */
  meta: Record<string, string>;
  /** ISO 8601 creation timestamp. */
  created: string;
  /** ISO 8601 last-modified timestamp. */
  modified: string;
  /** Duration in seconds (−1 while still processing). */
  duration: number;
  /** File size in bytes. */
  size: number;
  /** HLS and DASH manifest URLs. */
  playback: { hls: string; dash: string };
  /** Browser-preview URL (non-embeddable). */
  preview: string;
}

/**
 * Type of automated video this render job produces.
 *
 * `personal_blueprint` is the Energy Blueprint Video Engine workload (I1): a
 * per-user, credit-metered personal render. The other members are the existing
 * scheduled-content workloads. New members are additive.
 */
export type RenderJobType =
  | 'marketing'
  | 'training'
  | 'walkthrough'
  | 'personal_blueprint';

/**
 * Lifecycle status of a render job.
 */
export type RenderJobStatus =
  | 'pending'
  | 'rendering'
  | 'uploading'
  | 'done'
  | 'failed';

/**
 * A render job that flows through the automated video production pipeline.
 *
 * @example
 * ```ts
 * const job: RenderJob = {
 *   id: 'job_01J9Z...',
 *   appId: 'prime_self',
 *   type: 'marketing',
 *   topic: 'Q4 launch — peak performance challenge',
 *   script: 'Raise your standard...',
 *   status: 'pending',
 *   createdAt: new Date().toISOString(),
 *   updatedAt: new Date().toISOString(),
 * };
 * ```
 */
export interface RenderJob {
  /** Unique job identifier (ULID or UUID). */
  id: string;
  /** Factory application identifier (e.g. `'prime_self'`). */
  appId: string;
  /** Category of video being produced. */
  type: RenderJobType;
  /** Optional Media Room source brief key for deterministic render inputs. */
  briefKey?: string;
  /** Optional Remotion composition id resolved by Media Room or Schedule Worker. */
  compositionId?: string;
  /** Short topic label driving the script. */
  topic: string;
  /** Full narration script as plain text. */
  script: string;
  /** R2 key or HTTPS URL of the generated narration audio. */
  narrationUrl?: string;
  /** R2 key or HTTPS URL of the rendered MP4 video. */
  videoUrl?: string;
  /** R2 key or HTTPS URL of the video thumbnail. */
  thumbnailUrl?: string;
  /** Cloudflare Stream UID after registration. */
  streamUid?: string;
  /** Current pipeline stage. */
  status: RenderJobStatus;
  /** Human-readable failure reason when `status === 'failed'`. */
  error?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
  /** Atmospheric forge theme for EnergyBlueprintVideo renders. */
  forgeTheme?: string;
  /** HD energy type for body graph colouring. */
  hdType?: string;
  /** Gate numbers to highlight on the body graph. */
  signatureGates?: number[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @internal Looser fetch signature for dependency injection in tests. */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** @internal Shared optional deps for all Stream/R2 calls. */
export interface VideoDeps {
  /** Custom fetch implementation — defaults to global `fetch`. */
  fetch?: FetchFn;
}

function streamBase(env: VideoEnv): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream`;
}

function authHeaders(env: VideoEnv): HeadersInit {
  return {
    Authorization: `Bearer ${env.CF_STREAM_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/** @internal Shared response handler for Cloudflare Stream API calls. */
async function handleStreamResponse<T>(
  res: Response,
  operation: string,
): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new InternalError(`Stream ${operation} failed: HTTP ${res.status}`, {
      status: res.status,
      body,
    });
  }

  const json = (await res.json()) as {
    success: boolean;
    result: T;
    errors: Array<{ message: string }>;
  };

  if (!json.success) {
    const msg = json.errors.map((e) => e.message).join('; ');
    throw new InternalError(`Stream ${operation} returned errors: ${msg}`, {
      operation,
    });
  }

  return json.result;
}

// ---------------------------------------------------------------------------
// Cloudflare Stream API functions
// ---------------------------------------------------------------------------

/**
 * Copies a remote video into Cloudflare Stream by URL.
 * Stream will fetch the video from `sourceUrl` asynchronously.
 *
 * @example
 * ```ts
 * const video = await uploadFromUrl(
 *   'https://r2.example.com/videos/intro.mp4',
 *   { title: 'Product intro', appId: 'prime_self' },
 *   env,
 * );
 * console.log(video.uid); // 'abc123def456...'
 * ```
 */
export async function uploadFromUrl(
  sourceUrl: string,
  meta: Record<string, string>,
  env: VideoEnv,
  deps: VideoDeps = {},
): Promise<StreamVideo> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${streamBase(env)}/copy`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ url: sourceUrl, meta }),
  });
  return handleStreamResponse<StreamVideo>(res, 'upload-from-url');
}

/**
 * Copies a remote video into Cloudflare Stream by URL **as a private asset**
 * (decision D1): the resulting video has `requireSignedURLs: true`, so it can
 * only be played back with a signed token (see {@link getStreamSignedToken}).
 *
 * Identical to {@link uploadFromUrl} except for the privacy flag. Personal
 * Energy Blueprint renders are private first-class assets and must never be
 * publicly playable by default — this is the upload path the render service
 * uses for them.
 *
 * @example
 * ```ts
 * const video = await uploadPrivateFromUrl(
 *   'https://r2.example.com/renders/video-object-123.mp4',
 *   { videoObjectId: '123', userId: 'u_456' },
 *   env,
 * );
 * // video.uid is private; playback needs a signed token.
 * ```
 */
export async function uploadPrivateFromUrl(
  sourceUrl: string,
  meta: Record<string, string>,
  env: VideoEnv,
  deps: VideoDeps = {},
): Promise<StreamVideo> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${streamBase(env)}/copy`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ url: sourceUrl, meta, requireSignedURLs: true }),
  });
  return handleStreamResponse<StreamVideo>(res, 'upload-private-from-url');
}

/**
 * Options for minting a Cloudflare Stream signed-playback token.
 *
 * The token is produced by Stream's `/token` endpoint using the account's
 * configured signing key — no extra binding beyond the existing
 * {@link VideoEnv} (`CF_ACCOUNT_ID` + `CF_STREAM_TOKEN`) is required, since the
 * API signs server-side. (If you later switch to *offline*, key-pair signing,
 * you would add a `CF_STREAM_SIGNING_KEY` binding and sign locally instead;
 * documented here so the contract is explicit.)
 */
export interface StreamSignedTokenOptions {
  /**
   * Token lifetime in seconds from now. Stream maps this to the `exp` claim.
   * Defaults to 3600 (1 hour). Keep playback links short-lived (D1/privacy).
   */
  expiresInSeconds?: number;
  /**
   * Optional `downloadable` flag — when `true`, the signed token also permits
   * MP4 downloads. Defaults to `false` (stream-only) for private readings.
   */
  downloadable?: boolean;
  /**
   * Optional list of access rules (e.g. IP / country restrictions) passed
   * through verbatim to the Stream `/token` API. Shape is API-defined.
   */
  accessRules?: unknown[];
}

/**
 * Mints a **signed playback token** for a private Stream video (D1).
 *
 * Calls Stream's `POST /stream/{uid}/token` endpoint, which signs the token
 * server-side with the account's signing key. The returned token is appended to
 * the HLS/DASH manifest or iframe URL (e.g.
 * `https://videodelivery.net/{token}/manifest/video.m3u8`) to authorise
 * playback of a `requireSignedURLs` asset.
 *
 * Tokens should be short-lived and minted per playback session by the owning
 * app (selfprime), never embedded statically.
 *
 * @example
 * ```ts
 * const token = await getStreamSignedToken(video.uid, env, { expiresInSeconds: 600 });
 * const playbackUrl = `https://videodelivery.net/${token}/manifest/video.m3u8`;
 * ```
 */
export async function getStreamSignedToken(
  uid: string,
  env: VideoEnv,
  options: StreamSignedTokenOptions = {},
  deps: VideoDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const body: Record<string, unknown> = {};
  if (options.expiresInSeconds !== undefined) {
    body['exp'] = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
  } else {
    body['exp'] = Math.floor(Date.now() / 1000) + 3600;
  }
  if (options.downloadable === true) {
    body['downloadable'] = true;
  }
  if (options.accessRules !== undefined) {
    body['accessRules'] = options.accessRules;
  }

  const res = await fetchImpl(`${streamBase(env)}/${uid}/token`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify(body),
  });
  const result = await handleStreamResponse<{ token: string }>(
    res,
    'sign-playback-token',
  );
  return result.token;
}

/**
 * Builds the signed HLS playback URL for a private Stream video from a token
 * minted by {@link getStreamSignedToken}. Convenience over string-templating.
 *
 * @example
 * ```ts
 * const token = await getStreamSignedToken(uid, env);
 * const url = getSignedStreamPlaybackUrl(token); // HLS manifest URL
 * ```
 */
export function getSignedStreamPlaybackUrl(token: string): string {
  return `https://videodelivery.net/${token}/manifest/video.m3u8`;
}

/**
 * Retrieves a single Stream video by its UID.
 *
 * @example
 * ```ts
 * const video = await getStreamVideo('abc123', env);
 * if (video.readyToStream) {
 *   const embedUrl = getStreamEmbedUrl(video.uid);
 * }
 * ```
 */
export async function getStreamVideo(
  uid: string,
  env: VideoEnv,
  deps: VideoDeps = {},
): Promise<StreamVideo> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${streamBase(env)}/${uid}`, {
    headers: authHeaders(env),
  });
  return handleStreamResponse<StreamVideo>(res, 'get-video');
}

/**
 * Lists all Stream videos on the account.
 * For large libraries, paginate by passing `?after=<uid>` as a query param via
 * a future `listStreamVideoPage` helper.
 *
 * @example
 * ```ts
 * const videos = await listStreamVideos(env);
 * const ready = videos.filter(v => v.readyToStream);
 * ```
 */
export async function listStreamVideos(
  env: VideoEnv,
  deps: VideoDeps = {},
): Promise<StreamVideo[]> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(streamBase(env), {
    headers: authHeaders(env),
  });
  return handleStreamResponse<StreamVideo[]>(res, 'list-videos');
}

/**
 * Deletes a Stream video and revokes all playback URLs for that UID.
 * This action is **permanent**.
 *
 * @example
 * ```ts
 * await deleteStreamVideo('abc123', env);
 * ```
 */
export async function deleteStreamVideo(
  uid: string,
  env: VideoEnv,
  deps: VideoDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${streamBase(env)}/${uid}`, {
    method: 'DELETE',
    headers: authHeaders(env),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new InternalError(`Stream delete failed: HTTP ${res.status}`, {
      uid,
      status: res.status,
      body,
    });
  }
}

/**
 * Returns the iframe embed URL for a Cloudflare Stream video.
 * This URL is safe to drop into an `<iframe src="...">` tag directly.
 *
 * @example
 * ```ts
 * const embedUrl = getStreamEmbedUrl('abc123');
 * // 'https://iframe.videodelivery.net/abc123'
 * ```
 */
export function getStreamEmbedUrl(uid: string): string {
  return `https://iframe.videodelivery.net/${uid}`;
}

/**
 * Returns the thumbnail URL for a Cloudflare Stream video.
 *
 * @param uid   Stream video UID.
 * @param time  Timestamp to capture as thumbnail (default `'1s'`).
 *
 * @example
 * ```ts
 * const thumb = getStreamThumbnailUrl('abc123', '5s');
 * ```
 */
export function getStreamThumbnailUrl(uid: string, time = '1s'): string {
  return `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg?time=${encodeURIComponent(time)}`;
}

// ---------------------------------------------------------------------------
// Cloudflare R2 functions
// ---------------------------------------------------------------------------

/**
 * Uploads an `ArrayBuffer` to the R2 bucket at the given key.
 * Returns the key so callers can chain `.then(key => ...)`.
 *
 * @example
 * ```ts
 * const key = await putR2Object(env.VIDEOS_BUCKET, 'renders/job_01.mp4', buffer);
 * ```
 */
export async function putR2Object(
  bucket: R2BucketLike,
  key: string,
  data: ArrayBuffer,
): Promise<string> {
  await bucket.put(key, data);
  return key;
}

/**
 * Fetches an object from the R2 bucket and returns its raw bytes.
 * Throws `InternalError` if the object does not exist.
 *
 * @example
 * ```ts
 * const buffer = await getR2Object(env.VIDEOS_BUCKET, 'renders/job_01.mp4');
 * ```
 */
export async function getR2Object(
  bucket: R2BucketLike,
  key: string,
): Promise<ArrayBuffer> {
  const obj = await bucket.get(key);
  if (!obj) {
    throw new InternalError(`R2 object not found: ${key}`, { key });
  }
  return obj.arrayBuffer();
}

/**
 * Deletes an object from the R2 bucket.
 * No-ops silently if the key does not exist (R2 delete is idempotent).
 *
 * @example
 * ```ts
 * await deleteR2Object(env.VIDEOS_BUCKET, 'renders/job_01.mp4');
 * ```
 */
export async function deleteR2Object(
  bucket: R2BucketLike,
  key: string,
): Promise<void> {
  await bucket.delete(key);
}

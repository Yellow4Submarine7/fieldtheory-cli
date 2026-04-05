import { readJsonLines, writeJsonLines, readJson, writeJson, pathExists } from './fs.js';
import { ensureDataDir, twitterLikesCachePath, twitterLikesBackfillStatePath } from './paths.js';
import { loadChromeSessionConfig } from './config.js';
import { extractChromeXCookies } from './chrome-cookies.js';
import type { BookmarkBackfillState, BookmarkRecord } from './types.js';
import { convertTweetToRecord, mergeRecords, type SyncOptions, type SyncProgress, type SyncResult } from './graphql-bookmarks.js';

const X_PUBLIC_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Likes query ID — Twitter changes these periodically.
// Override via FT_LIKES_QUERY_ID env var if the default stops working.
const LIKES_QUERY_ID = process.env.FT_LIKES_QUERY_ID ?? 'eSSNbhECHHLKBqlQmfgPnA';
const LIKES_OPERATION = 'Likes';

const GRAPHQL_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_uc_gql_enabled: true,
  vibe_api_enabled: true,
  responsive_web_text_conversations_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_media_download_video_enabled: false,
};

export interface LikesSyncOptions extends SyncOptions {
  /** Twitter user ID. If not provided, extracted from Chrome cookies. */
  userId?: string;
}

interface PageResult {
  records: BookmarkRecord[];
  nextCursor?: string;
}

function buildUrl(userId: string, cursor?: string): string {
  const variables: Record<string, unknown> = {
    userId,
    count: 20,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
    withV2Timeline: true,
  };
  if (cursor) variables.cursor = cursor;
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(GRAPHQL_FEATURES),
  });
  return `https://x.com/i/api/graphql/${LIKES_QUERY_ID}/${LIKES_OPERATION}?${params}`;
}

function buildHeaders(csrfToken: string, cookieHeader?: string): Record<string, string> {
  return {
    authorization: `Bearer ${X_PUBLIC_BEARER}`,
    'x-csrf-token': csrfToken,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    cookie: cookieHeader ?? `ct0=${csrfToken}`,
  };
}

export function parseLikesResponse(json: any, now?: string): PageResult {
  const ts = now ?? new Date().toISOString();

  // Likes response: data.user.result.timeline_v2.timeline.instructions
  const instructions =
    json?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    json?.data?.user?.result?.timeline?.timeline?.instructions ??
    [];
  const entries: any[] = [];
  for (const inst of instructions) {
    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      entries.push(...inst.entries);
    }
  }

  const records: BookmarkRecord[] = [];
  let nextCursor: string | undefined;

  for (const entry of entries) {
    if (entry.entryId?.startsWith('cursor-bottom')) {
      nextCursor = entry.content?.value;
      continue;
    }

    const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
    if (!tweetResult) continue;

    const record = convertTweetToRecord(tweetResult, ts);
    if (record) {
      record.ingestedVia = 'graphql-likes';
      records.push(record);
    }
  }

  return { records, nextCursor };
}

async function fetchPageWithRetry(
  csrfToken: string,
  userId: string,
  cursor?: string,
  cookieHeader?: string,
): Promise<PageResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(buildUrl(userId, cursor), {
      headers: buildHeaders(csrfToken, cookieHeader),
    });

    if (response.status === 429) {
      const waitSec = Math.min(15 * Math.pow(2, attempt), 120);
      lastError = new Error(`Rate limited (429) on attempt ${attempt + 1}`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }

    if (response.status >= 500) {
      lastError = new Error(`Server error (${response.status}) on attempt ${attempt + 1}`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GraphQL Likes API returned ${response.status}.\n` +
          `Response: ${text.slice(0, 300)}\n\n` +
          (response.status === 401 || response.status === 403
            ? 'Fix: Your X session may have expired. Open Chrome, go to https://x.com, and make sure you are logged in. Then retry.'
            : 'This may be a temporary issue. Try again in a few minutes.')
      );
    }

    const json = await response.json();
    return parseLikesResponse(json);
  }

  throw lastError ?? new Error('GraphQL Likes API: all retry attempts failed. Try again later.');
}

function parseSnowflake(value?: string | null): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseLikeTimestamp(record: BookmarkRecord): number | null {
  const candidates = [record.postedAt, record.syncedAt];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compareLikeChronology(a: BookmarkRecord, b: BookmarkRecord): number {
  const aTimestamp = parseLikeTimestamp(a);
  const bTimestamp = parseLikeTimestamp(b);
  if (aTimestamp != null && bTimestamp != null && aTimestamp !== bTimestamp) {
    return aTimestamp > bTimestamp ? 1 : -1;
  }

  const aId = parseSnowflake(a.tweetId ?? a.id);
  const bId = parseSnowflake(b.tweetId ?? b.id);
  if (aId != null && bId != null && aId !== bId) {
    return aId > bId ? 1 : -1;
  }

  const aStamp = String(a.postedAt ?? a.syncedAt ?? '');
  const bStamp = String(b.postedAt ?? b.syncedAt ?? '');
  return aStamp.localeCompare(bStamp);
}

async function loadExistingLikes(): Promise<BookmarkRecord[]> {
  const cachePath = twitterLikesCachePath();
  return await readJsonLines<BookmarkRecord>(cachePath);
}

function updateState(
  prev: BookmarkBackfillState,
  input: { added: number; seenIds: string[]; stopReason: string },
): BookmarkBackfillState {
  return {
    provider: 'twitter',
    lastRunAt: new Date().toISOString(),
    totalRuns: prev.totalRuns + 1,
    totalAdded: prev.totalAdded + input.added,
    lastAdded: input.added,
    lastSeenIds: input.seenIds.slice(-20),
    stopReason: input.stopReason,
  };
}

export function formatLikesSyncResult(result: SyncResult): string {
  return [
    'Likes sync complete.',
    `- likes added: ${result.added}`,
    `- total likes: ${result.totalBookmarks}`,
    `- pages fetched: ${result.pages}`,
    `- stop reason: ${result.stopReason}`,
    `- cache: ${result.cachePath}`,
    `- state: ${result.statePath}`,
  ].join('\n');
}

export async function syncLikesGraphQL(options: LikesSyncOptions = {}): Promise<SyncResult> {
  const incremental = options.incremental ?? true;
  const maxPages = options.maxPages ?? 500;
  const delayMs = options.delayMs ?? 600;
  const maxMinutes = options.maxMinutes ?? 30;
  const stalePageLimit = options.stalePageLimit ?? 3;
  const checkpointEvery = options.checkpointEvery ?? 25;

  let csrfToken: string;
  let cookieHeader: string | undefined;
  let userId: string | undefined = options.userId;

  if (options.csrfToken) {
    csrfToken = options.csrfToken;
    cookieHeader = options.cookieHeader;
  } else {
    const chromeConfig = loadChromeSessionConfig();
    const chromeDir = options.chromeUserDataDir ?? chromeConfig.chromeUserDataDir;
    const chromeProfile = options.chromeProfileDirectory ?? chromeConfig.chromeProfileDirectory;
    const cookies = extractChromeXCookies(chromeDir, chromeProfile);
    csrfToken = cookies.csrfToken;
    cookieHeader = cookies.cookieHeader;
    if (!userId) userId = cookies.userId;
  }

  if (!userId) {
    throw new Error(
      'Could not determine your Twitter user ID.\n' +
        'The twid cookie was not found in Chrome.\n\n' +
        'Fix: Pass your user ID explicitly:\n' +
        '  ft sync-likes --user-id YOUR_USER_ID\n\n' +
        'You can find your user ID at https://tweeterid.com or in your Twitter profile URL.',
    );
  }

  ensureDataDir();
  const cachePath = twitterLikesCachePath();
  const statePath = twitterLikesBackfillStatePath();
  let existing = await loadExistingLikes();
  const newestKnownId = incremental
    ? existing.slice().sort((a, b) => compareLikeChronology(b, a))[0]?.id
    : undefined;
  const prevState: BookmarkBackfillState = (await pathExists(statePath))
    ? await readJson<BookmarkBackfillState>(statePath)
    : { provider: 'twitter', totalRuns: 0, totalAdded: 0, lastAdded: 0, lastSeenIds: [] };

  const started = Date.now();
  let page = 0;
  let totalAdded = 0;
  let stalePages = 0;
  let cursor: string | undefined;
  const allSeenIds: string[] = [];
  let stopReason = 'unknown';

  while (page < maxPages) {
    if (Date.now() - started > maxMinutes * 60_000) {
      stopReason = 'max runtime reached';
      break;
    }

    const result = await fetchPageWithRetry(csrfToken, userId, cursor, cookieHeader);
    page += 1;

    if (result.records.length === 0 && !result.nextCursor) {
      stopReason = 'end of likes';
      break;
    }

    const { merged, added } = mergeRecords(existing, result.records);
    existing = merged;
    totalAdded += added;
    result.records.forEach((r) => allSeenIds.push(r.id));
    const reachedLatestStored =
      Boolean(newestKnownId) && result.records.some((record) => record.id === newestKnownId);

    stalePages = added === 0 ? stalePages + 1 : 0;

    options.onProgress?.({
      page,
      totalFetched: allSeenIds.length,
      newAdded: totalAdded,
      running: true,
      done: false,
    });

    if (options.targetAdds && totalAdded >= options.targetAdds) {
      stopReason = 'target additions reached';
      break;
    }
    if (incremental && reachedLatestStored) {
      stopReason = 'caught up to newest stored like';
      break;
    }
    if (incremental && stalePages >= stalePageLimit) {
      stopReason = 'no new likes (stale)';
      break;
    }
    if (!result.nextCursor) {
      stopReason = 'end of likes';
      break;
    }

    if (page % checkpointEvery === 0) await writeJsonLines(cachePath, existing);

    cursor = result.nextCursor;
    if (page < maxPages) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (stopReason === 'unknown') stopReason = page >= maxPages ? 'max pages reached' : 'unknown';

  await writeJsonLines(cachePath, existing);
  await writeJson(
    statePath,
    updateState(prevState, { added: totalAdded, seenIds: allSeenIds.slice(-20), stopReason }),
  );

  options.onProgress?.({
    page,
    totalFetched: allSeenIds.length,
    newAdded: totalAdded,
    running: false,
    done: true,
    stopReason,
  });

  return {
    added: totalAdded,
    totalBookmarks: existing.length,
    pages: page,
    stopReason,
    cachePath,
    statePath,
  };
}

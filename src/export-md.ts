import { readJsonLines } from './fs.js';
import { twitterBookmarksCachePath, twitterLikesCachePath } from './paths.js';
import type { BookmarkRecord } from './types.js';
import fs from 'node:fs';

export interface ExportMdOptions {
  /** Which source to export: 'bookmarks', 'likes', or 'all'. Default: 'all' */
  source?: 'bookmarks' | 'likes' | 'all';
  /** Max tweets per Markdown file. Default: 200 */
  batchSize?: number;
  /** Output directory. Default: current working directory */
  outDir?: string;
  /** Only export records synced after this ISO date (e.g. '2026-04-05T00:00:00Z') */
  since?: string;
}

export interface ExportMdResult {
  files: string[];
  totalRecords: number;
}

function escapeMarkdown(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatRecord(r: BookmarkRecord): string {
  const author = r.authorHandle ? `@${r.authorHandle}` : 'unknown';
  const authorName = r.authorName ?? r.author?.name;
  const date = r.postedAt
    ? new Date(r.postedAt).toISOString().slice(0, 10)
    : r.syncedAt?.slice(0, 10) ?? '?';
  const lines: string[] = [];

  const displayName = authorName ? `${authorName} (${author})` : author;
  lines.push(`### ${displayName} — ${date}`);
  lines.push('');

  // Metadata block
  const meta: string[] = [];
  meta.push(`- **Tweet ID:** ${r.tweetId}`);
  if (r.language) meta.push(`- **Language:** ${r.language}`);
  if (r.postedAt) meta.push(`- **Posted:** ${r.postedAt}`);
  meta.push(`- **Synced:** ${r.syncedAt}`);
  if (r.ingestedVia) meta.push(`- **Source:** ${r.ingestedVia}`);
  if (r.conversationId) meta.push(`- **Conversation ID:** ${r.conversationId}`);
  if (r.inReplyToStatusId) meta.push(`- **In reply to:** ${r.inReplyToStatusId}`);
  if (r.quotedStatusId) meta.push(`- **Quotes:** ${r.quotedStatusId}`);
  if (r.sourceApp) meta.push(`- **App:** ${r.sourceApp}`);
  if (r.possiblySensitive) meta.push(`- **Sensitive:** yes`);
  lines.push(meta.join('\n'));
  lines.push('');

  lines.push(escapeMarkdown(r.text));
  lines.push('');

  if (r.tags?.length) {
    lines.push(`**Tags:** ${r.tags.join(', ')}`);
  }
  if (r.links?.length) {
    lines.push(`**Links:** ${r.links.join(', ')}`);
  }
  if (r.media?.length) {
    lines.push(`**Media:** ${r.media.join(', ')}`);
  }

  const eng = r.engagement;
  if (eng) {
    const parts: string[] = [];
    if (eng.likeCount != null) parts.push(`${eng.likeCount} likes`);
    if (eng.repostCount != null) parts.push(`${eng.repostCount} reposts`);
    if (eng.replyCount != null) parts.push(`${eng.replyCount} replies`);
    if (eng.quoteCount != null) parts.push(`${eng.quoteCount} quotes`);
    if (eng.bookmarkCount != null) parts.push(`${eng.bookmarkCount} bookmarks`);
    if (eng.viewCount != null) parts.push(`${eng.viewCount} views`);
    if (parts.length) lines.push(`**Engagement:** ${parts.join(' · ')}`);
  }

  lines.push(`[View on X](${r.url})`);
  lines.push('');
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

export async function exportToMarkdown(options: ExportMdOptions = {}): Promise<ExportMdResult> {
  const source = options.source ?? 'all';
  const batchSize = options.batchSize ?? 200;
  const outDir = options.outDir ?? process.cwd();
  const since = options.since;

  let records: BookmarkRecord[] = [];

  if (source === 'bookmarks' || source === 'all') {
    const bookmarks = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
    records.push(...bookmarks);
  }
  if (source === 'likes' || source === 'all') {
    const likes = await readJsonLines<BookmarkRecord>(twitterLikesCachePath());
    records.push(...likes);
  }

  // Deduplicate by id
  const seen = new Set<string>();
  records = records.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // Filter by --since (compare against syncedAt)
  if (since) {
    const sinceTime = new Date(since).getTime();
    records = records.filter((r) => {
      const t = r.syncedAt ? new Date(r.syncedAt).getTime() : 0;
      return t > sinceTime;
    });
  }

  // Sort by date descending
  records.sort((a, b) => {
    const da = a.postedAt ?? a.syncedAt ?? '';
    const db = b.postedAt ?? b.syncedAt ?? '';
    return String(db).localeCompare(String(da));
  });

  if (records.length === 0) {
    return { files: [], totalRecords: 0 };
  }

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const files: string[] = [];
  const totalBatches = Math.ceil(records.length / batchSize);
  const sourceLabel = source === 'likes' ? 'Liked Tweets' : source === 'bookmarks' ? 'Bookmarks' : 'Bookmarks & Likes';

  for (let i = 0; i < totalBatches; i++) {
    const batch = records.slice(i * batchSize, (i + 1) * batchSize);
    const firstDate = batch[0]?.postedAt ? new Date(batch[0].postedAt).toISOString().slice(0, 10) : '?';
    const lastDate = batch[batch.length - 1]?.postedAt
      ? new Date(batch[batch.length - 1].postedAt!).toISOString().slice(0, 10)
      : '?';

    const header = [
      `# ${sourceLabel} (Part ${i + 1}/${totalBatches})`,
      '',
      `**${batch.length} tweets** — ${lastDate} to ${firstDate}`,
      '',
      '---',
      '',
    ].join('\n');

    const body = batch.map(formatRecord).join('');
    const datePrefix = since ? new Date().toISOString().slice(0, 10) : '';
    const filename = since
      ? (totalBatches === 1
          ? `likes-${datePrefix}.md`
          : `likes-${datePrefix}-${String(i + 1).padStart(2, '0')}.md`)
      : (totalBatches === 1
          ? `tweets-export.md`
          : `tweets-export-${String(i + 1).padStart(2, '0')}.md`);
    const filepath = `${outDir}/${filename}`;

    fs.writeFileSync(filepath, header + body, 'utf8');
    files.push(filepath);
  }

  return { files, totalRecords: records.length };
}

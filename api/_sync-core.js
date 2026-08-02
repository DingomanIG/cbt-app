/*
 * Notion → Supabase 동기화 로직.
 * `scripts/sync-notion-to-supabase.mjs`(CLI)와 `api/sync.js`(웹)가 함께 사용한다.
 * 파일명이 _로 시작하므로 Vercel이 라우트로 배포하지 않는다.
 */
import { createClient } from '@supabase/supabase-js';

const NOTION_VERSION = '2022-06-28';
const UPSERT_CHUNK = 200;
const BLOCK_CONCURRENCY = 6; // Notion은 이 정도 동시 요청까지 429 없이 처리한다

function questionDbs() {
  return [
    { notionDbId: process.env.NOTION_DB_ID, table: 'questions_mock' },
    { notionDbId: process.env.NOTION_DB_ID_GISUL_YESANG, table: 'questions_gisul_yesang' },
    { notionDbId: process.env.NOTION_DB_ID_GISUL, table: 'questions_gisul', hasYear: true },
  ];
}

async function notionFetch(path, init = {}, attempt = 0) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  // 속도 제한에 걸리면 Retry-After 만큼 기다렸다 재시도
  if (res.status === 429 && attempt < 3) {
    const wait = (Number(res.headers.get('retry-after')) || 1) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return notionFetch(path, init, attempt + 1);
  }

  const data = await res.json();
  if (!res.ok) throw new Error(`Notion API error (${path}): ${data.message || res.status}`);
  return data;
}

const notionPost = (path, body) =>
  notionFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
const notionGet = (path) => notionFetch(path);

/* 동시 실행 수를 제한한 map */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function queryAllPages(dbId) {
  const all = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionPost(`/databases/${dbId}/query`, body);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
}

async function fetchAllBlocks(pageId) {
  const all = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
    const data = await notionGet(`/blocks/${pageId}/children?${qs}`);
    all.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
}

function getProp(props, name) {
  const p = props[name];
  if (!p) return null;
  switch (p.type) {
    // Notion은 서식이 바뀌는 지점마다 조각을 나누므로 전부 이어붙인다.
    // (첫 조각만 읽으면 일부만 굵게 처리한 해설의 뒷부분이 통째로 사라진다)
    case 'title': return (p.title || []).map((t) => t.plain_text).join('');
    case 'rich_text': return (p.rich_text || []).map((t) => t.plain_text).join('');
    case 'select': return p.select?.name ?? null;
    case 'checkbox': return !!p.checkbox;
    case 'multi_select': return (p.multi_select || []).map((o) => o.name);
    case 'number': return p.number ?? null;
    default: return null;
  }
}

function mapQuestionRow(page, hasYear) {
  const p = page.properties;
  const answerRaw = getProp(p, '정답');
  const row = {
    notion_page_id: page.id,
    notion_number: getProp(p, '번호'),
    '문제': getProp(p, '문제') || '',
    '보기1': getProp(p, '보기1'), '보기2': getProp(p, '보기2'),
    '보기3': getProp(p, '보기3'), '보기4': getProp(p, '보기4'),
    '보기1_해설': getProp(p, '보기1_해설'), '보기2_해설': getProp(p, '보기2_해설'),
    '보기3_해설': getProp(p, '보기3_해설'), '보기4_해설': getProp(p, '보기4_해설'),
    '정답': answerRaw ? parseInt(answerRaw, 10) : null,
    '해설': getProp(p, '해설'),
    '과목': getProp(p, '과목'),
    '챕터': getProp(p, '챕터'),
    '난이도': getProp(p, '난이도'),
    '관련키워드': getProp(p, '관련키워드') || [],
    '검수완료': getProp(p, '검수완료') || false,
    '반영금지': getProp(p, '반영금지') || false,
    updated_at: new Date().toISOString(),
  };
  if (hasYear) row['년도'] = getProp(p, '년도');
  return row;
}

/* ── 요약노트 블록 → HTML (public/index.html의 note-* 클래스와 짝을 이룬다) ── */
function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function richTextToHtml(richText) {
  return (richText || []).map((rt) => {
    const text = escapeHtml(rt.plain_text || '');
    return rt.annotations?.bold ? `<strong>${text}</strong>` : text;
  }).join('');
}
function blocksToHtml(blocks) {
  return (blocks || []).map((block) => {
    if (block.type === 'paragraph') {
      const rt = block.paragraph?.rich_text || [];
      const isFullyBold = rt.length > 0 && rt.every((r) => r.annotations?.bold);
      const html = richTextToHtml(rt);
      return isFullyBold
        ? `<div class="note-sub-title">${html}</div>`
        : `<div class="note-bullet">${html}</div>`;
    }
    if (block.type === 'bulleted_list_item') {
      return `<div class="note-bullet">${richTextToHtml(block.bulleted_list_item?.rich_text)}</div>`;
    }
    return '';
  }).join('');
}

function mapNoteRow(page, blocks) {
  const p = page.properties;
  return {
    notion_page_id: page.id,
    notion_index: getProp(p, '인덱스'),
    '제목': getProp(p, '제목') || '',
    '챕터': getProp(p, '챕터'),
    '과목': getProp(p, '과목'),
    '관련키워드': getProp(p, '관련키워드') || [],
    '검수완료': getProp(p, '검수완료') || false,
    '반영금지': getProp(p, '반영금지') || false,
    content_html: blocksToHtml(blocks),
    updated_at: new Date().toISOString(),
  };
}

async function upsertRows(supabase, table, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'notion_page_id' });
    if (error) throw new Error(`Supabase upsert failed for ${table}: ${error.message}`);
  }
}

async function syncQuestions(supabase) {
  const targets = questionDbs().filter((d) => d.notionDbId);
  const skipped = questionDbs().filter((d) => !d.notionDbId).map((d) => d.table);

  // 3개 DB를 병렬로 읽는다
  const synced = await Promise.all(
    targets.map(async ({ notionDbId, table, hasYear }) => {
      const pages = await queryAllPages(notionDbId);
      const rows = pages.map((page) => mapQuestionRow(page, hasYear));
      await upsertRows(supabase, table, rows);
      return { table, rows: rows.length };
    })
  );
  return { synced, skipped };
}

async function syncSummaryNotes(supabase) {
  const dbId = process.env.NOTION_DB_ID_NOTES;
  if (!dbId) return null;

  const pages = await queryAllPages(dbId);
  // 본문 블록 조회가 가장 느린 구간이라 동시에 여러 개를 가져온다
  const rows = await mapLimit(pages, BLOCK_CONCURRENCY, async (page) =>
    mapNoteRow(page, await fetchAllBlocks(page.id))
  );
  await upsertRows(supabase, 'summary_notes', rows);
  return { table: 'summary_notes', rows: rows.length };
}

export async function runSync() {
  const startedAt = Date.now();

  const missing = ['NOTION_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`환경변수가 설정되지 않았습니다: ${missing.join(', ')}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { synced, skipped } = await syncQuestions(supabase);
  const notes = await syncSummaryNotes(supabase);
  if (!notes) skipped.push('summary_notes');

  const tables = notes ? [...synced, notes] : synced;
  return {
    tables,
    skipped,
    total: tables.reduce((sum, t) => sum + t.rows, 0),
    elapsedMs: Date.now() - startedAt,
    syncedAt: new Date().toISOString(),
  };
}

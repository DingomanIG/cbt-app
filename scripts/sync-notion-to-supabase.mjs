import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const NOTION_KEY = process.env.NOTION_KEY;
const NOTION_VERSION = '2022-06-28';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const QUESTION_DBS = [
  { notionDbId: process.env.NOTION_DB_ID, table: 'questions_mock' },
  { notionDbId: process.env.NOTION_DB_ID_GISUL_YESANG, table: 'questions_gisul_yesang' },
  { notionDbId: process.env.NOTION_DB_ID_GISUL, table: 'questions_gisul', hasYear: true },
];

async function notionPost(path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion API error (${path}): ${data.message || res.status}`);
  return data;
}

async function notionGet(path) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    headers: { 'Authorization': `Bearer ${NOTION_KEY}`, 'Notion-Version': NOTION_VERSION },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion API error (${path}): ${data.message || res.status}`);
  return data;
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
    case 'title': return p.title?.[0]?.plain_text ?? '';
    case 'rich_text': return p.rich_text?.[0]?.plain_text ?? '';
    case 'select': return p.select?.name ?? null;
    case 'checkbox': return !!p.checkbox;
    case 'multi_select': return (p.multi_select || []).map(o => o.name);
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

/* ── 요약노트 블록 → HTML (public/index.html의 parseNoteBlocks/richTextToHtml 이식) ── */
function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function richTextToHtml(richText) {
  return (richText || []).map(rt => {
    const text = escapeHtml(rt.plain_text || '');
    return rt.annotations?.bold ? `<strong>${text}</strong>` : text;
  }).join('');
}
function blocksToHtml(blocks) {
  return (blocks || []).map(block => {
    if (block.type === 'paragraph') {
      const rt = block.paragraph?.rich_text || [];
      const isFullyBold = rt.length > 0 && rt.every(r => r.annotations?.bold);
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

async function upsertRows(table, rows) {
  if (rows.length === 0) return;
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'notion_page_id' });
    if (error) throw new Error(`Supabase upsert failed for ${table}: ${error.message}`);
  }
}

async function syncQuestions() {
  for (const { notionDbId, table, hasYear } of QUESTION_DBS) {
    if (!notionDbId) { console.log(`[skip] ${table}: env var not set`); continue; }
    console.log(`[sync] ${table} ...`);
    const pages = await queryAllPages(notionDbId);
    const rows = pages.map(page => mapQuestionRow(page, hasYear));
    await upsertRows(table, rows);
    console.log(`[done] ${table}: ${rows.length} rows`);
  }
}

async function syncSummaryNotes() {
  const dbId = process.env.NOTION_DB_ID_NOTES;
  if (!dbId) { console.log('[skip] summary_notes: NOTION_DB_ID_NOTES not set'); return; }
  console.log('[sync] summary_notes ...');
  const pages = await queryAllPages(dbId);
  const rows = [];
  for (const page of pages) {
    const blocks = await fetchAllBlocks(page.id);
    rows.push(mapNoteRow(page, blocks));
  }
  await upsertRows('summary_notes', rows);
  console.log(`[done] summary_notes: ${rows.length} rows`);
}

async function main() {
  const required = ['NOTION_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  await syncQuestions();
  await syncSummaryNotes();
  console.log('Sync complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

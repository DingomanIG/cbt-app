import { createClient } from '@supabase/supabase-js';
import { isProRequest } from './_entitlement.js';

const TABLES = {
  mock: 'questions_mock',
  gisul_yesang: 'questions_gisul_yesang',
  gisul: 'questions_gisul',
};

/* 문항 id는 테이블마다 별개이므로, 계정에 저장할 때 어느 테이블에서 왔는지 함께 남긴다 */
const SOURCE_BY_TABLE = Object.fromEntries(
  Object.entries(TABLES).map(([source, table]) => [table, source])
);

/* 클라이언트가 실제로 쓰는 컬럼만 반환 */
const BASE_COLUMNS = [
  'id', '과목', '챕터', '난이도', '문제',
  '보기1', '보기2', '보기3', '보기4',
  '정답', '해설', '관련키워드',
];

/* 보기별 상세해설은 프로 전용이다.
   무료 사용자에게는 빈 값으로 내려보내는 게 아니라 SELECT 자체에서 뺀다. */
const PRO_COLUMNS = ['보기1_해설', '보기2_해설', '보기3_해설', '보기4_해설'];

function columnsFor(isPro) {
  return (isPro ? [...BASE_COLUMNS, ...PRO_COLUMNS] : BASE_COLUMNS).join(',');
}

const PAGE_SIZE = 1000; // Supabase(PostgREST) 기본 max-rows
const IN_CHUNK = 100;   // .in() URL 길이 제한 회피
const MAX_COUNT = 500;

function candidateQuery(supabase, table, subjects) {
  let query = supabase
    .from(table)
    .select('id')
    .eq('반영금지', false)
    .not('정답', 'is', null); // 정답 누락 문항은 출제 대상에서 제외
  if (subjects.length > 0) query = query.in('과목', subjects);
  return query;
}

/* max-rows(1000) 제한을 넘어서는 테이블도 전부 읽는다 */
async function fetchAllIds(supabase, table, subjects) {
  const ids = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await candidateQuery(supabase, table, subjects)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    ids.push(...data.map((r) => r.id));
    if (data.length < PAGE_SIZE) return ids;
  }
}

/* 부분 Fisher-Yates: 전체를 섞지 않고 앞 n개만 무작위로 뽑는다 */
function sample(arr, n) {
  const a = [...arr];
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* 계정에는 문항 본문이 아니라 참조(source + id)만 저장하므로,
   오답노트·즐겨찾기를 다른 기기에서 열 때 본문을 여기서 받아온다. */
async function fetchByIds(supabase, refs, columns) {
  const byTable = new Map();
  for (const ref of refs) {
    const table = ref && typeof ref === 'object' ? TABLES[ref.source] : undefined;
    if (!table || typeof ref.id !== 'string') continue;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(ref.id);
  }

  const queries = [];
  byTable.forEach((ids, table) => {
    chunk([...new Set(ids)].slice(0, MAX_COUNT), IN_CHUNK).forEach((part) => {
      queries.push(
        supabase.from(table).select(columns).in('id', part)
          .then((r) => ({ ...r, source: SOURCE_BY_TABLE[table] }))
      );
    });
  });
  return Promise.all(queries);
}

export default async function handler(req, res) {
  // 프런트엔드와 동일 출처에서만 호출하므로 CORS 허용 헤더를 두지 않는다
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const columns = columnsFor(await isProRequest(supabase, req));

    // id 목록으로 조회 (오답노트·즐겨찾기 복원)
    if (Array.isArray(body.ids)) {
      const responses = await fetchByIds(supabase, body.ids.slice(0, MAX_COUNT), columns);
      const failed = responses.find((r) => r.error);
      if (failed) return res.status(500).json({ error: failed.error.message });
      return res.status(200).json({
        results: responses.flatMap((r) => r.data.map((row) => ({ ...row, source: r.source }))),
      });
    }

    const rawKeys = Array.isArray(body.dbKeys) && body.dbKeys.length > 0 ? body.dbKeys : ['mock'];
    const tables = rawKeys.map((k) => (typeof k === 'string' ? TABLES[k] : undefined));
    if (tables.some((t) => !t)) {
      return res.status(400).json({ error: '알 수 없는 dbKey입니다' });
    }

    const subjects = Array.isArray(body.subjects)
      ? body.subjects.filter((s) => typeof s === 'string')
      : [];

    const requested = Number(body.count);
    const count = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_COUNT)
      : MAX_COUNT;

    // 1) 후보 id만 모은다 (테이블 전체를 내려받지 않음)
    const idLists = await Promise.all(
      [...new Set(tables)].map(async (table) => ({
        table,
        ids: await fetchAllIds(supabase, table, subjects),
      }))
    );
    const pool = idLists.flatMap(({ table, ids }) => ids.map((id) => ({ table, id })));
    if (pool.length === 0) return res.status(200).json({ results: [] });

    // 2) 여러 테이블을 합친 뒤 필요한 문항 수만큼만 추출
    const picked = sample(pool, count);
    const byTable = new Map();
    picked.forEach(({ table, id }) => {
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table).push(id);
    });

    // 3) 뽑힌 문항의 본문만 조회
    const queries = [];
    byTable.forEach((ids, table) => {
      chunk(ids, IN_CHUNK).forEach((part) => {
        queries.push(
          supabase.from(table).select(columns).in('id', part)
            .then((r) => ({ ...r, source: SOURCE_BY_TABLE[table] }))
        );
      });
    });
    const responses = await Promise.all(queries);

    const failed = responses.find((r) => r.error);
    if (failed) return res.status(500).json({ error: failed.error.message });

    return res.status(200).json({
      results: responses.flatMap((r) => r.data.map((row) => ({ ...row, source: r.source }))),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || '문제를 불러오지 못했습니다' });
  }
}

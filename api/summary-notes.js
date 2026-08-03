import { createClient } from '@supabase/supabase-js';
import { isProRequest } from './_entitlement.js';

// 무료 응답에는 content_html을 아예 담지 않는다. 목록을 훑고 검색하는 데 필요한
// 제목·과목·키워드까지만 내려가고, 본문은 프로에서만 나간다.
const FREE_COLUMNS = ['id', '제목', '과목', '관련키워드'].join(',');
const PRO_COLUMNS  = `${FREE_COLUMNS},content_html`;
const PAGE_SIZE = 1000; // Supabase(PostgREST) 기본 max-rows

export default async function handler(req, res) {
  // 프런트엔드와 동일 출처에서만 호출하므로 CORS 허용 헤더를 두지 않는다
  //
  // ⚠️ 응답이 사용자(프로 여부)마다 달라지므로 절대 공유 캐시에 올리면 안 된다.
  //    예전의 public s-maxage 설정을 그대로 두면 프로 사용자의 요약노트가
  //    CDN에 캐시됐다가 무료 사용자에게 그대로 나간다.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
    }

    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const subjects = Array.isArray(body.subjects)
      ? body.subjects.filter((s) => typeof s === 'string')
      : [];

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 요약노트 본문은 프로 전용이다. 무료는 에러가 아니라 제목 목록만 받고,
    // 화면에는 클라이언트가 잠금 안내를 함께 그린다.
    const isPro = await isProRequest(supabase, req);
    const columns = isPro ? PRO_COLUMNS : FREE_COLUMNS;

    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = supabase.from('summary_notes').select(columns).eq('반영금지', false);
      if (subjects.length > 0) query = query.in('과목', subjects);

      const { data, error } = await query.order('id').range(from, from + PAGE_SIZE - 1);
      if (error) return res.status(500).json({ error: error.message });

      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }

    return res.status(200).json({ results: rows, locked: !isPro });
  } catch (e) {
    return res.status(500).json({ error: e.message || '요약노트를 불러오지 못했습니다' });
  }
}

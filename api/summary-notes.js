import { createClient } from '@supabase/supabase-js';

const COLUMNS = ['id', '제목', '과목', '관련키워드', 'content_html'].join(',');
const PAGE_SIZE = 1000; // Supabase(PostgREST) 기본 max-rows

export default async function handler(req, res) {
  // 프런트엔드와 동일 출처에서만 호출하므로 CORS 허용 헤더를 두지 않는다
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

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

    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = supabase.from('summary_notes').select(COLUMNS).eq('반영금지', false);
      if (subjects.length > 0) query = query.in('과목', subjects);

      const { data, error } = await query.order('id').range(from, from + PAGE_SIZE - 1);
      if (error) return res.status(500).json({ error: error.message });

      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }

    return res.status(200).json({ results: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message || '요약노트를 불러오지 못했습니다' });
  }
}

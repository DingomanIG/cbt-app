import { createClient } from '@supabase/supabase-js';

const TABLES = ['questions_mock', 'questions_gisul_yesang', 'questions_gisul'];

/* 실패한 응답까지 CDN에 1시간 박히면 홈 화면 총 문항이 그동안 "300+"로 뜬다.
   성공했을 때만 캐시를 허용하고, 그 전까지는 캐시하지 않는다. */
function cacheable(res) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 출제 대상과 같은 조건으로 센다 (반영금지 제외, 정답 누락 제외)
    const counts = await Promise.all(TABLES.map((table) =>
      supabase.from(table)
        .select('id', { count: 'exact', head: true })
        .eq('반영금지', false)
        .not('정답', 'is', null)
    ));

    const failed = counts.find((c) => c.error);
    if (failed) return res.status(500).json({ error: failed.error.message });

    cacheable(res);   // 여기까지 왔을 때만 — 자주 바뀌지 않는 값이라 CDN에 맡긴다
    return res.status(200).json({
      questionCount: counts.reduce((sum, c) => sum + (c.count || 0), 0),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || '통계를 불러오지 못했습니다' });
  }
}

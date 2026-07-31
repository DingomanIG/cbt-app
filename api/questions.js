import { createClient } from '@supabase/supabase-js';

const TABLES = {
  mock: 'questions_mock',
  gisul_yesang: 'questions_gisul_yesang',
  gisul: 'questions_gisul',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { subjects, dbKey = 'mock' } = req.body || {};

  const table = TABLES[dbKey];
  if (!table) {
    return res.status(400).json({ error: '알 수 없는 dbKey입니다' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let query = supabase.from(table).select('*').eq('반영금지', false);
  if (subjects && subjects.length > 0) {
    query = query.in('과목', subjects);
  }

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ results: data });
}

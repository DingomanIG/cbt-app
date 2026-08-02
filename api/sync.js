import { runSync } from './_sync-core.js';

/* 길이가 달라도 비교 시간이 노출되지 않도록 상수 시간 비교 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(req) {
  // 관리자 페이지 버튼: x-sync-token 헤더
  const token = process.env.SYNC_TOKEN;
  if (token && safeEqual(req.headers['x-sync-token'], token)) return true;

  // Vercel Cron: Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (cronSecret && typeof auth === 'string' && safeEqual(auth, `Bearer ${cronSecret}`)) return true;

  return false;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // POST = 관리자 버튼, GET = Vercel Cron
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SYNC_TOKEN && !process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'SYNC_TOKEN이 설정되지 않았습니다' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });
  }

  try {
    const result = await runSync();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || '동기화에 실패했습니다' });
  }
}

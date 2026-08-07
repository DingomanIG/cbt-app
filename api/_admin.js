/* 관리자 인증 — /admin.html 이 부르는 엔드포인트들이 공유한다.
 *
 * 비밀번호는 SYNC_TOKEN 하나를 그대로 쓴다. 동기화와 환불이 같은 비밀번호인 게 마음에
 * 걸릴 수 있지만, 지금 관리자는 한 명이고 키를 늘리면 관리 지점만 늘어난다.
 * 운영자가 여럿이 되면 그때 갈라야 한다.
 */

/* 길이가 달라도 비교 시간이 노출되지 않도록 상수 시간 비교 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* 관리자 페이지 버튼: x-sync-token 헤더.
   Vercel Cron 의 CRON_SECRET 은 일부러 받지 않는다 — 자동화가 환불을 부를 일은 없다. */
export function isAdminRequest(req) {
  const token = process.env.SYNC_TOKEN;
  return !!token && safeEqual(req.headers['x-sync-token'], token);
}

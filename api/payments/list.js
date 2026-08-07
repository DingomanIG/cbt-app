/* 결제 내역 + 권한 대사 (읽기 전용) — /admin.html 이 부른다.
 *
 * 대사가 잡아내려는 것은 하나다: **돈과 권한이 어긋난 건.**
 *   - 승인됐는데 프로가 안 붙음  → 사용자가 돈을 내고 못 받은 상태. 가장 급하다
 *   - 결제 없이 프로가 붙어 있음  → 관리자가 수동으로 준 건이거나 잘못 부여된 건
 *   - ready 로 오래 방치된 주문   → 결제창까지 안 갔거나, 돈은 빠졌는데 승인이 유실됐거나.
 *                                  둘 중 어느 쪽인지는 토스에 물어봐야 안다 (reconcile.js)
 *
 * 이 파일은 아무것도 고치지 않는다. 고치는 것은 reconcile.js 와 cancel.js 다.
 */

import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '../_admin.js';

const LIMIT = 30;
const STALE_MINUTES = 15; // 이보다 오래 ready 면 정상 흐름은 아니다

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.SYNC_TOKEN) {
    return res.status(500).json({ error: 'SYNC_TOKEN이 설정되지 않았습니다' });
  }
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: payments, error: payError } = await supabase
      .from('payments')
      .select('order_id,user_id,amount,status,method,created_at,approved_at,canceled_at,cancel_reason,fail_message')
      .order('created_at', { ascending: false })
      .limit(LIMIT);
    if (payError) return res.status(500).json({ error: payError.message });

    const { data: entitlements, error: entError } = await supabase
      .from('user_entitlements')
      .select('user_id,is_pro,expires_at,source,note,granted_at');
    if (entError) return res.status(500).json({ error: entError.message });

    const entByUser = new Map(entitlements.map((e) => [e.user_id, e]));
    const isActive = (e) => !!(e && e.is_pro
      && (!e.expires_at || new Date(e.expires_at).getTime() > Date.now()));

    const staleBefore = Date.now() - STALE_MINUTES * 60 * 1000;

    const rows = payments.map((p) => {
      const ent = entByUser.get(p.user_id);
      const pro = isActive(ent);
      return {
        ...p,
        isPro: pro,
        entSource: ent ? ent.source : null,
        // 돈은 받았는데 권한이 없다 — 사용자가 손해를 보고 있는 상태
        mismatch: p.status === 'approved' && !pro,
        // 오래 ready 인 주문. 토스에 물어봐야 실제 상태를 안다
        stale: p.status === 'ready' && new Date(p.created_at).getTime() < staleBefore,
      };
    });

    const paidUserIds = new Set(
      payments.filter((p) => p.status === 'approved').map((p) => p.user_id)
    );

    return res.status(200).json({
      ok: true,
      rows,
      summary: {
        total: rows.length,
        byStatus: rows.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        }, {}),
        // 최근 결제 기준 매출 (취소분 제외)
        revenue: rows.filter((r) => r.status === 'approved').reduce((s, r) => s + r.amount, 0),
        mismatches: rows.filter((r) => r.mismatch).length,
        stale: rows.filter((r) => r.stale).length,
        // 결제 없이 프로인 계정 — 관리자 수동 부여이거나 잘못 붙은 것
        proWithoutPayment: entitlements
          .filter((e) => isActive(e) && !paidUserIds.has(e.user_id))
          .map((e) => ({ user_id: e.user_id, source: e.source, granted_at: e.granted_at })),
      },
      staleMinutes: STALE_MINUTES,
      limit: LIMIT,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || '조회에 실패했습니다' });
  }
}

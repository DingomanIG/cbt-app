/* 방치된 주문 대사 — /admin.html 의 "미완료 주문 점검" 버튼이 부른다.
 *
 * `ready` 로 오래 남아 있는 주문은 둘 중 하나다.
 *   (a) 사용자가 결제창을 닫았다 — 돈은 안 나갔다. 정리하면 된다
 *   (b) 결제는 됐는데 승인이 유실됐다 — **돈은 나갔는데 프로가 없다.** 찾아내야 한다
 *
 * 우리 DB만 봐서는 둘을 구분할 수 없다. 그래서 한 건씩 토스에 실제 상태를 물어본다.
 * 웹훅이 (b)를 대부분 막아주지만, 웹훅 등록 전에 생긴 주문이나 웹훅 자체가 실패한 건은
 * 여기서만 걸린다. 마지막 그물이다.
 *
 * 기본은 점검만 한다(dryRun). 고치려면 apply: true 를 보낸다.
 */

import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '../_admin.js';
import { fetchPaymentByOrderId, TossError } from '../_toss.js';

const STALE_MINUTES = 15;
const MAX_CHECK = 20; // 토스를 한 번에 너무 많이 부르지 않는다

/* 토스가 알려준 상태 → 우리가 할 일 */
function actionFor(tossStatus) {
  if (tossStatus === 'DONE') return 'grant';                       // 돈이 나갔다. 프로를 줘야 한다
  if (['CANCELED', 'PARTIAL_CANCELED', 'EXPIRED', 'ABORTED'].includes(tossStatus)) return 'fail';
  return 'wait'; // WAITING_FOR_DEPOSIT, IN_PROGRESS — 아직 결정 전
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const apply = body.apply === true;

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const staleBefore = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

    const { data: orders, error } = await supabase
      .from('payments')
      .select('order_id,amount,created_at')
      .eq('status', 'ready')
      .lt('created_at', staleBefore)
      .order('created_at', { ascending: true })
      .limit(MAX_CHECK);
    if (error) return res.status(500).json({ error: error.message });

    const results = [];

    for (const o of orders) {
      let payment = null;
      let tossStatus = null;

      try {
        payment = await fetchPaymentByOrderId(o.order_id);
        tossStatus = payment.status;
      } catch (e) {
        if (e instanceof TossError && e.status >= 400 && e.status < 500) {
          // 토스에 기록 자체가 없다 = 결제창까지 가지 않았다. 버려진 주문이다.
          tossStatus = 'NOT_FOUND';
        } else {
          results.push({ orderId: o.order_id, amount: o.amount, error: e.message });
          continue;
        }
      }

      const action = tossStatus === 'NOT_FOUND' ? 'fail' : actionFor(tossStatus);
      const row = { orderId: o.order_id, amount: o.amount, createdAt: o.created_at, tossStatus, action };

      if (!apply) { results.push({ ...row, applied: false }); continue; }

      if (action === 'grant') {
        // 돈은 이미 나간 건이다. 늦게라도 프로를 붙인다.
        const { error: gErr } = await supabase.rpc('grant_pro_for_payment', {
          p_order_id: o.order_id,
          p_payment_key: payment.paymentKey,
          p_amount: payment.totalAmount,
          p_method: payment.method || null,
          p_toss_status: payment.status,
        });
        results.push({ ...row, applied: !gErr, error: gErr ? gErr.message : undefined });
      } else if (action === 'fail') {
        // 돈이 나가지 않은 건이므로 지우지 않고 failed 로 남긴다.
        // 주문 기록 자체는 보존 대상이고, 나중에 "왜 안 샀는지" 세는 데도 쓰인다.
        const { error: uErr } = await supabase
          .from('payments')
          .update({
            status: 'failed',
            fail_code: tossStatus === 'NOT_FOUND' ? 'NOT_ATTEMPTED' : tossStatus,
            fail_message: tossStatus === 'NOT_FOUND'
              ? '결제창까지 진행되지 않은 주문'
              : `토스 상태: ${tossStatus}`,
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', o.order_id)
          .eq('status', 'ready'); // 그 사이 승인됐다면 건드리지 않는다
        results.push({ ...row, applied: !uErr, error: uErr ? uErr.message : undefined });
      } else {
        results.push({ ...row, applied: false });
      }
    }

    return res.status(200).json({
      ok: true,
      apply,
      checked: results.length,
      recovered: results.filter((r) => r.action === 'grant').length,
      cleaned: results.filter((r) => r.action === 'fail').length,
      results,
      staleMinutes: STALE_MINUTES,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || '대사에 실패했습니다' });
  }
}

/* 결제 웹훅 — 보조 경로다. 본선은 confirm.js 다.
 *
 * 왜 있는가: 결제창을 통과한 뒤 /payment.html 이 승인 API를 부르는 사이에 사용자가
 * 브라우저를 닫거나 네트워크가 끊기면, 돈은 빠져나갔는데 우리 DB는 'ready' 인 채로 남는다.
 * 그 구멍을 토스가 보내주는 상태 변경 알림으로 메운다.
 *
 * ⚠️ 본문을 믿지 않는다. 이 주소는 공개돼 있어 누구나 POST 할 수 있으므로,
 *    본문에서는 어떤 결제를 볼지(paymentKey/orderId)만 꺼내고 **실제 상태는 토스에 되묻는다**.
 *    위조된 본문으로 할 수 있는 최대치는 "존재하는 결제의 진짜 상태를 조회하게 만드는 것"이고,
 *    그건 우리가 어차피 하려던 일이다.
 *
 * ⚠️ 웬만하면 200 을 돌려준다. 4xx/5xx 를 주면 토스가 재시도를 쌓는데,
 *    우리가 이미 처리했거나 우리 몫이 아닌 알림에까지 재시도를 받을 이유가 없다.
 *    실제로 다시 받아야 하는 경우(일시적 장애)에만 5xx 를 준다.
 */

import { createClient } from '@supabase/supabase-js';
import { fetchPayment, fetchPaymentByOrderId, TossError } from '../_toss.js';

/* 토스가 보내는 상태값 중 우리가 반응하는 것 */
const GRANTED = ['DONE'];
const REVOKED = ['CANCELED', 'PARTIAL_CANCELED', 'EXPIRED', 'ABORTED'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      // 우리 설정 문제이므로 재시도를 받는 편이 낫다
      return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
    }

    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    // 토스는 { eventType, data: { paymentKey, orderId, status, ... } } 형태로 보낸다.
    // 스키마가 바뀌어도 견디도록 최상위와 data 양쪽을 본다.
    const d = typeof body.data === 'object' && body.data !== null ? body.data : body;
    const paymentKey = typeof d.paymentKey === 'string' ? d.paymentKey : null;
    const orderId = typeof d.orderId === 'string' ? d.orderId : null;

    if (!paymentKey && !orderId) {
      // 우리가 다룰 수 있는 알림이 아니다. 재시도는 의미가 없다.
      return res.status(200).json({ ignored: '식별자가 없습니다' });
    }

    // ── 진짜 상태를 토스에 되묻는다 (본문의 status 는 쓰지 않는다) ──
    let payment;
    try {
      payment = paymentKey ? await fetchPayment(paymentKey) : await fetchPaymentByOrderId(orderId);
    } catch (e) {
      if (e instanceof TossError && e.status >= 400 && e.status < 500) {
        // 우리 결제가 아니거나 없는 건이다. 재시도해도 결과가 같다.
        return res.status(200).json({ ignored: '조회할 수 없는 결제입니다' });
      }
      throw e; // 토스 장애 등 — 재시도를 받는다
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 우리가 만든 주문만 다룬다 (다른 상점 알림이 잘못 들어와도 조용히 넘긴다)
    const { data: order, error: orderError } = await supabase
      .from('payments')
      .select('order_id,status,amount')
      .eq('order_id', payment.orderId)
      .maybeSingle();

    if (orderError) throw new Error(orderError.message); // 조회 실패는 재시도 대상
    if (!order) return res.status(200).json({ ignored: '우리 주문이 아닙니다' });

    // ── 상태에 따라 처리. 두 함수 모두 멱등이라 겹쳐 들어와도 안전하다 ──
    if (GRANTED.includes(payment.status)) {
      if (order.status === 'approved') {
        return res.status(200).json({ ok: true, noop: '이미 승인됨' });
      }
      const { error } = await supabase.rpc('grant_pro_for_payment', {
        p_order_id: payment.orderId,
        p_payment_key: payment.paymentKey,
        p_amount: payment.totalAmount,
        p_method: payment.method || null,
        p_toss_status: payment.status,
      });
      if (error) {
        // 금액 불일치 같은 위변조는 재시도해도 계속 실패한다. 로그로 남기고 재시도는 끊는다.
        console.error('[webhook] 권한 부여 실패', payment.orderId, error.message);
        return res.status(200).json({ ok: false, error: error.message });
      }
      console.log('[webhook] 승인 보정 완료', payment.orderId);
      return res.status(200).json({ ok: true, granted: true });
    }

    if (REVOKED.includes(payment.status)) {
      if (order.status === 'canceled') {
        return res.status(200).json({ ok: true, noop: '이미 취소됨' });
      }
      const { error } = await supabase.rpc('revoke_pro_for_payment', {
        p_order_id: payment.orderId,
        p_reason: `웹훅: ${payment.status}`,
      });
      if (error) {
        console.error('[webhook] 권한 회수 실패', payment.orderId, error.message);
        return res.status(200).json({ ok: false, error: error.message });
      }
      console.log('[webhook] 취소 반영 완료', payment.orderId, payment.status);
      return res.status(200).json({ ok: true, revoked: true });
    }

    // WAITING_FOR_DEPOSIT, IN_PROGRESS 등 — 아직 결정된 게 없다
    return res.status(200).json({ ok: true, noop: `대기 상태(${payment.status})` });
  } catch (e) {
    // 여기까지 온 것은 일시적 장애로 본다. 5xx 를 주면 토스가 다시 보낸다.
    console.error('[webhook] 처리 실패', e.message);
    return res.status(500).json({ error: e.message || '웹훅 처리에 실패했습니다' });
  }
}

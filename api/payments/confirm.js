/* 결제 승인 — 결제창을 통과한 뒤 /payment.html 이 부른다. 여기가 본선이다.
 *
 * 순서가 중요하다:
 *   1) 우리 DB에서 주문을 찾아 **저장해 둔 금액**을 꺼낸다 (클라이언트가 보낸 amount 는 쓰지 않는다)
 *   2) 그 금액으로 토스 승인 API를 부른다 — 이 호출이 성공한 순간 돈이 빠져나간다
 *   3) grant_pro_for_payment() 로 payments 갱신 + 프로 부여를 한 트랜잭션으로 처리한다
 *
 * ⚠️ 로그인 토큰을 요구하지 않는다. 일부러 그렇다.
 *    결제창을 다녀오는 사이 세션이 만료되면 "돈은 빠졌는데 승인은 못 하는" 상태가 된다.
 *    누구를 프로로 만들지는 주문 행의 user_id 가 이미 알고 있으므로 토큰이 필요 없고,
 *    승인하려면 토스가 발급한 paymentKey 가 있어야 하는데 그건 실제로 결제한 사람만 가진다.
 */

import { createClient } from '@supabase/supabase-js';
import { confirmPayment, TossError } from '../_toss.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
    }

    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const paymentKey = typeof body.paymentKey === 'string' ? body.paymentKey : '';
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    if (!paymentKey || !orderId) {
      return res.status(400).json({ error: '결제 정보가 올바르지 않습니다' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: order, error: orderError } = await supabase
      .from('payments')
      .select('order_id,amount,status')
      .eq('order_id', orderId)
      .maybeSingle();

    if (orderError) return res.status(500).json({ error: '주문을 조회하지 못했습니다' });
    if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다' });

    // 승인 응답과 웹훅이 겹쳐 들어오거나 사용자가 새로고침한 경우.
    // 이미 처리가 끝났으므로 토스를 다시 부르지 않고 성공으로 답한다.
    if (order.status === 'approved') {
      return res.status(200).json({ ok: true, alreadyApproved: true });
    }
    if (order.status === 'canceled') {
      return res.status(409).json({ error: '이미 취소된 주문입니다' });
    }

    // ── 여기서부터 돈이 움직인다 ──
    // 금액은 주문 생성 때 서버가 저장한 값이다. 클라이언트가 보낸 body.amount 는 읽지 않는다.
    let approved;
    try {
      approved = await confirmPayment({
        paymentKey,
        orderId,
        amount: order.amount,
      });
    } catch (e) {
      if (e instanceof TossError) {
        // 승인이 거절됐다 = 돈은 빠져나가지 않았다. 실패로 기록해 두고 사유를 그대로 전한다.
        await supabase
          .from('payments')
          .update({
            status: 'failed',
            fail_code: e.code,
            fail_message: e.message,
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', orderId)
          .eq('status', 'ready'); // 그 사이 다른 경로로 승인됐다면 건드리지 않는다

        return res.status(402).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    // ── 승인 성공. 이 아래에서 실패하면 "돈은 빠졌는데 프로가 안 붙은" 상태다 ──
    // 그래서 payments 갱신과 권한 부여를 SQL 함수 하나(=한 트랜잭션)로 묶어 둔다.
    // 함수 안에서 주문 금액과 승인 금액을 한 번 더 대조한다.
    const { error: grantError } = await supabase.rpc('grant_pro_for_payment', {
      p_order_id: orderId,
      p_payment_key: approved.paymentKey || paymentKey,
      p_amount: approved.totalAmount,
      p_method: approved.method || null,
      p_toss_status: approved.status || null,
    });

    if (grantError) {
      // 사용자에게 "다시 결제하세요"라고 말하면 안 되는 구간이다.
      // payment.html 이 이 응답을 받으면 "다시 결제하지 말고 문의하세요"로 안내한다.
      console.error('[payments/confirm] 승인은 됐으나 권한 부여 실패', orderId, grantError.message);
      return res.status(500).json({
        error: '결제는 완료되었으나 권한 반영이 지연되고 있습니다',
        orderId,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || '결제를 확인하지 못했습니다' });
  }
}

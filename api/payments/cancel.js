/* 환불(결제 취소) — /admin.html 에서 관리자가 부른다.
 *
 * 두 단계로 쓴다:
 *   1) dryRun: true  → 취소하지 않고 주문 내용만 돌려준다 (금액·상태·일시)
 *   2) dryRun 없음   → 토스 취소 API 호출 → revoke_pro_for_payment()
 *
 * 확인 단계를 나눈 이유는 단순하다. 주문번호는 사람이 손으로 옮겨 적는 값이고,
 * 한 글자 틀리면 엉뚱한 사람의 결제를 취소한다. 취소는 되돌릴 수 없다.
 *
 * ⚠️ 순서가 중요하다. 토스를 먼저 부르고 그다음 권한을 회수한다.
 *    반대로 하면 "프로는 뺏었는데 돈은 안 돌려준" 상태가 생긴다.
 *    토스 취소는 성공했는데 회수가 실패하는 경우는 남는데(돈은 돌려주고 프로는 남음),
 *    그건 토스가 보내는 CANCELED 웹훅이 뒤이어 메운다.
 */

import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '../_admin.js';
import { cancelPayment, TossError } from '../_toss.js';

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
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '관리자 환불';
    if (!orderId) return res.status(400).json({ error: '주문번호를 입력해 주세요' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: order, error: orderError } = await supabase
      .from('payments')
      .select('order_id,user_id,amount,status,payment_key,method,created_at,approved_at,canceled_at,cancel_reason')
      .eq('order_id', orderId)
      .maybeSingle();

    if (orderError) return res.status(500).json({ error: '주문을 조회하지 못했습니다' });
    if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다' });

    // ── 1단계: 확인만 ──
    if (body.dryRun) {
      return res.status(200).json({ ok: true, dryRun: true, order });
    }

    // ── 2단계: 실제 취소 ──
    if (order.status === 'canceled') {
      return res.status(200).json({ ok: true, noop: '이미 취소된 주문입니다', order });
    }
    if (order.status !== 'approved') {
      // ready = 결제창까지 못 간 주문, failed = 승인이 거절된 주문. 둘 다 돌려줄 돈이 없다.
      return res.status(400).json({
        error: `승인된 주문이 아닙니다 (현재 상태: ${order.status}). 돌려줄 결제가 없습니다`,
      });
    }
    if (!order.payment_key) {
      return res.status(409).json({ error: '결제 키가 없어 토스에 취소를 요청할 수 없습니다' });
    }

    let canceled;
    try {
      canceled = await cancelPayment({ paymentKey: order.payment_key, cancelReason: reason });
    } catch (e) {
      if (e instanceof TossError) {
        return res.status(402).json({ error: `토스 취소 실패: ${e.message}`, code: e.code });
      }
      throw e;
    }

    const { error: revokeError } = await supabase.rpc('revoke_pro_for_payment', {
      p_order_id: orderId,
      p_reason: reason,
    });

    if (revokeError) {
      // 돈은 이미 돌아갔다. 여기서 실패했다고 취소를 다시 시도하면 안 된다.
      console.error('[payments/cancel] 토스 취소는 됐으나 권한 회수 실패', orderId, revokeError.message);
      return res.status(500).json({
        error: '결제는 취소했으나 권한 회수에 실패했습니다. 다시 취소하지 마시고 웹훅 반영을 기다리거나 직접 확인해 주세요',
        orderId,
        tossCanceled: true,
      });
    }

    return res.status(200).json({
      ok: true,
      orderId,
      amount: order.amount,
      canceledAmount: canceled.cancels && canceled.cancels[0]
        ? canceled.cancels[0].cancelAmount
        : order.amount,
      tossStatus: canceled.status,
      reason,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || '취소에 실패했습니다' });
  }
}

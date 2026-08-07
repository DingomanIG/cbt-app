/* 주문 생성 — 결제창을 띄우기 직전에 부른다.
 *
 * 여기서 하는 일은 하나뿐이다: **결제 금액의 원본을 서버에 박아두는 것.**
 * 이 행의 amount 가 나중에 승인 단계에서 토스가 알려준 금액과 대조되고
 * (sql/003_payments.sql 의 grant_pro_for_payment), 다르면 예외가 난다.
 * 그래서 클라이언트가 금액을 보내오지 않고, 보내와도 읽지 않는다.
 */

import { createClient } from '@supabase/supabase-js';
import { proAmount } from '../_pricing.js';
import { tossClientKey } from '../_toss.js';

const ORDER_NAME = '한식조리기능사 CBT 프로 버전';

/* 토스 orderId 규칙: 영문/숫자/-/_ 로 6~64자.
   uuid 에서 하이픈만 떼어 접두사를 붙인다 (앞자리로 우리 주문임을 알아보기 쉽게). */
function newOrderId() {
  return `cbt_${crypto.randomUUID().replace(/-/g, '')}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: '환경변수가 설정되지 않았습니다' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 주문은 반드시 로그인 사용자의 것이다 — 권한을 붙일 대상이 있어야 하기 때문이다
    const header = req.headers.authorization || req.headers.Authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인해 주세요' });
    }
    const userId = userData.user.id;

    // 키가 없으면 결제창을 띄워봐야 실패한다. 주문 행을 만들기 전에 먼저 막는다.
    let clientKey;
    try {
      clientKey = tossClientKey();
    } catch (e) {
      return res.status(500).json({ error: '결제가 아직 설정되지 않았습니다' });
    }

    // 평생 1회 결제다. 이미 프로인 사람에게 결제창을 띄우면 두 번 받는 셈이 된다.
    const { data: ent } = await supabase
      .from('user_entitlements')
      .select('is_pro,expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    const alreadyPro = !!(ent && ent.is_pro
      && (!ent.expires_at || new Date(ent.expires_at).getTime() > Date.now()));
    if (alreadyPro) {
      return res.status(409).json({ error: '이미 프로 버전을 이용 중입니다' });
    }

    const amount = proAmount();
    const orderId = newOrderId();

    const { error: insertError } = await supabase.from('payments').insert({
      order_id: orderId,
      user_id: userId,
      amount,
      status: 'ready',
    });
    if (insertError) {
      return res.status(500).json({ error: '주문을 만들지 못했습니다' });
    }

    // customerKey 는 토스가 요구하는 구매자 식별자다. 개인정보가 아니어야 하므로 uuid 를 그대로 쓴다.
    return res.status(200).json({
      orderId,
      amount,
      orderName: ORDER_NAME,
      customerKey: userId,
      clientKey,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || '주문을 만들지 못했습니다' });
  }
}

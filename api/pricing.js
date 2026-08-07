import { PRO_PRICE, PRO_LIST_PRICE } from './_pricing.js';
import { isTossConfigured } from './_toss.js';

/* 화면에 표시할 가격을 내려준다. 결제 금액의 판단은 서버가 하며,
   여기서 받은 값을 클라이언트가 되돌려 보내도 승인 단계에서 쓰지 않는다.

   checkoutEnabled 는 "지금 결제를 걸어도 되는가"다. 토스 키가 아직 없는 동안에도
   프로 화면과 약관을 배포할 수 있도록, 화면은 이 값을 보고 결제 버튼과 "준비 중"을 고른다.
   → 결제 오픈이 배포가 아니라 환경변수를 넣는 순간이 된다. */
export default async function handler(req, res) {
  // 결제 오픈은 환경변수를 넣는 즉시 반영돼야 하므로 응답을 캐시하지 않는다.
  // (가격만 내려줄 때는 60초 캐시였지만, 이제 이 응답이 결제 개시 여부를 결정한다)
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  return res.status(200).json({
    price: PRO_PRICE,
    listPrice: PRO_LIST_PRICE,
    checkoutEnabled: isTossConfigured(),
  });
}

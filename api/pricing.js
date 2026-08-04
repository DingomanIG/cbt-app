import { PRO_PRICE, PRO_LIST_PRICE } from './_pricing.js';

/* 화면에 표시할 가격을 내려준다. 결제 금액의 판단은 서버가 하며,
   여기서 받은 값을 클라이언트가 되돌려 보내도 승인 단계에서 쓰지 않는다. */
export default async function handler(req, res) {
  // 모든 사용자에게 같은 값이지만, 가격을 고쳤을 때 바로 반영되도록 짧게 잡는다
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  return res.status(200).json({ price: PRO_PRICE, listPrice: PRO_LIST_PRICE });
}

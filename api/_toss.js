/* 토스페이먼츠 API 호출 — 주문 승인(confirm.js)과 나중의 취소/환불이 함께 쓴다.
 *
 * ⚠️ secret key 는 절대 클라이언트로 나가면 안 된다. 이 파일은 서버(api/)에서만 import 한다.
 *    client key 는 공개되어도 되는 값이라 create.js 가 화면으로 내려보낸다.
 *
 * 테스트 키(`test_ck_…` / `test_sk_…`)는 토스 계약·심사 없이 개발자센터 가입만으로 발급된다.
 * 계약이 끝나면 환경변수만 라이브 키(`live_…`)로 바꾸면 되고 코드는 그대로다.
 */

const TOSS_API = 'https://api.tosspayments.com/v1';

export function tossClientKey() {
  const key = process.env.TOSS_CLIENT_KEY;
  if (!key) throw new Error('TOSS_CLIENT_KEY 환경변수가 없습니다');
  return key;
}

/* 결제를 열어도 되는 상태인가 — 화면이 결제 버튼을 띄울지 "준비 중"을 띄울지 정하는 근거다.
 *
 * 두 키를 모두 본다. client key 만 있으면 결제창은 뜨지만 승인 단계에서 막혀
 * "돈은 빠졌는데 프로가 안 붙는" 최악의 상태가 되기 때문이다.
 *
 * 이 함수 덕분에 결제 오픈이 배포가 아니라 **환경변수를 넣는 순간**이 된다.
 * 계약 전에는 키가 없으니 main 에 머지해 배포해도 사용자에게는 "준비 중"으로만 보인다.
 */
export function isTossConfigured() {
  return !!(process.env.TOSS_CLIENT_KEY && process.env.TOSS_SECRET_KEY);
}

function authHeader() {
  const key = process.env.TOSS_SECRET_KEY;
  if (!key) throw new Error('TOSS_SECRET_KEY 환경변수가 없습니다');
  // 토스는 Basic 인증에 "secretKey:" (콜론 뒤 빈 비밀번호) 를 base64 로 넣는다
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

/* 토스가 돌려준 에러를 그대로 들고 다닌다.
   code 는 사용자에게 보여줄 문구를 고를 때, status 는 우리 잘못인지 구분할 때 쓴다. */
export class TossError extends Error {
  constructor(message, code, status) {
    super(message || '결제 처리 중 오류가 발생했습니다');
    this.name = 'TossError';
    this.code = code || null;
    this.status = status || 0;
  }
}

async function callToss(path, body, idempotencyKey) {
  const headers = {
    Authorization: authHeader(),
    'Content-Type': 'application/json',
  };
  // 같은 요청이 두 번 들어가도 토스 쪽에서 한 번만 처리된다 (승인 응답과 웹훅이 겹칠 때)
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${TOSS_API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new TossError(data.message, data.code, res.status);
  return data;
}

async function getToss(path) {
  const res = await fetch(`${TOSS_API}${path}`, {
    headers: { Authorization: authHeader() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new TossError(data.message, data.code, res.status);
  return data;
}

/* 결제 한 건의 현재 상태를 토스에 직접 물어본다.
 *
 * 웹훅이 이걸 쓴다. 웹훅 요청은 누구나 우리 주소로 보낼 수 있으므로 본문을 믿으면 안 되고,
 * 본문에서 paymentKey 만 꺼낸 뒤 **우리 secret key 로 토스에 되물어** 진짜 상태를 확인한다.
 * 위조된 본문으로는 존재하는 결제의 실제 상태를 조회하게 만드는 것 이상을 할 수 없다.
 */
export function fetchPayment(paymentKey) {
  return getToss(`/payments/${encodeURIComponent(paymentKey)}`);
}

/* paymentKey 없이 orderId 만 온 경우의 조회 경로 */
export function fetchPaymentByOrderId(orderId) {
  return getToss(`/payments/orders/${encodeURIComponent(orderId)}`);
}

/* 결제 승인. 이 호출이 성공한 시점부터 실제로 돈이 빠져나간 것이다.
   amount 는 반드시 서버가 저장해 둔 주문 금액을 넘긴다 — 클라이언트가 보낸 값이 아니다. */
export function confirmPayment({ paymentKey, orderId, amount }) {
  return callToss('/payments/confirm', { paymentKey, orderId, amount }, orderId);
}

/* 취소/환불. 성공한 뒤에 revoke_pro_for_payment() 를 부른다. */
export function cancelPayment({ paymentKey, cancelReason }) {
  return callToss(`/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason });
}

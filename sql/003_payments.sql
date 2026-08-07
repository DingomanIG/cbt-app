-- 결제 이력 테이블 + 승인/취소 처리 함수
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- ⚠️ 이 테이블에도 SELECT 정책만 만듭니다 (002_entitlements.sql 과 같은 이유).
--    사용자는 자기 결제 내역을 "읽기만" 할 수 있고, 쓰기는 service role(서버)만 합니다.
--    결제 금액을 클라이언트가 쓸 수 있으면 100원 결제가 가능해집니다.
--
-- 결제 흐름과 이 테이블의 관계:
--   1) 주문 생성  — 서버가 order_id를 발급하고 status='ready' 로 한 행을 넣는다.
--                   이때 저장한 amount 가 나중에 대조할 "원본"이다 (금액은 api/_pricing.js 에서 읽는다).
--   2) 결제 승인  — 토스 승인 API 성공 후 grant_pro_for_payment() 를 호출한다.
--                   payments 를 approved 로 바꾸는 것과 user_entitlements 부여가 한 트랜잭션이어야
--                   "돈은 빠져나갔는데 프로가 안 붙은" 상태가 생기지 않는다.
--   3) 취소/환불  — 토스 취소 API 성공 후 revoke_pro_for_payment() 를 호출한다.


-- ── 1. 결제 이력 테이블 ──────────────────────────────────
create table if not exists public.payments (
  order_id      text        primary key,           -- 서버가 발급, 토스에 그대로 넘긴다. PK라 재요청해도 중복 주문이 안 생긴다
  -- 회원 탈퇴 후에도 결제 기록은 남아야 하므로 cascade 가 아니다.
  -- (전자상거래법상 대금결제 기록은 보존 대상이다. 계정만 끊고 행은 남긴다.)
  user_id       uuid        references auth.users(id) on delete set null,
  amount        integer     not null check (amount > 0),   -- 원 단위. 승인 시 토스가 알려준 금액과 대조한다
  status        text        not null default 'ready'
                            check (status in ('ready', 'approved', 'canceled', 'failed')),
  payment_key   text        unique,                -- 토스가 발급. 승인 전에는 null. unique 라 같은 결제가 두 줄로 안 들어간다
  method        text,                              -- '카드' | '간편결제' …
  toss_status   text,                              -- 토스 원문 상태(DONE, CANCELED …). 우리 status 와 별개로 그대로 남긴다
  fail_code     text,
  fail_message  text,
  cancel_reason text,
  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  canceled_at   timestamptz,
  updated_at    timestamptz not null default now()
);

-- "이 사용자의 최근 결제"가 가장 잦은 조회다
create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);


-- ── 2. RLS: 본인 결제만 읽을 수 있다 ──────────────────────
alter table public.payments enable row level security;

drop policy if exists "read own payments" on public.payments;

create policy "read own payments" on public.payments
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE 정책은 일부러 만들지 않습니다.


-- ── 3. 승인 처리 (결제 확정 + 프로 부여를 한 트랜잭션으로) ──
--
-- 서버가 토스 승인 API를 호출해 성공한 뒤에만 부릅니다.
-- 멱등: 이미 approved 인 주문을 다시 부르면 아무것도 바꾸지 않고 조용히 끝납니다
--       (토스 재시도나 웹훅이 승인 응답과 겹쳐 들어와도 두 번 부여되지 않습니다).
create or replace function public.grant_pro_for_payment(
  p_order_id    text,
  p_payment_key text,
  p_amount      integer,
  p_method      text default null,
  p_toss_status text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_amount  integer;
  v_status  text;
begin
  select user_id, amount, status
    into v_user_id, v_amount, v_status
    from public.payments
   where order_id = p_order_id
     for update;

  if not found then
    raise exception '주문을 찾을 수 없습니다: %', p_order_id;
  end if;

  if v_status = 'approved' then
    return; -- 이미 처리된 주문 — 중복 부여하지 않는다
  end if;

  -- 승인 금액이 주문 금액과 다르면 위변조다. 절대 통과시키지 않는다.
  if v_amount <> p_amount then
    raise exception '결제 금액이 주문 금액과 다릅니다 (주문 %, 승인 %)', v_amount, p_amount;
  end if;

  update public.payments
     set status      = 'approved',
         payment_key = p_payment_key,
         method      = coalesce(p_method, method),
         toss_status = coalesce(p_toss_status, toss_status),
         approved_at = now(),
         updated_at  = now()
   where order_id = p_order_id;

  -- 평생 이용이므로 expires_at 은 null 이다
  insert into public.user_entitlements (user_id, is_pro, granted_at, expires_at, source, note)
  values (v_user_id, true, now(), null, 'toss', p_order_id)
  on conflict (user_id) do update
     set is_pro     = true,
         granted_at = now(),
         expires_at = null,
         source     = 'toss',
         note       = p_order_id;
end;
$$;


-- ── 4. 취소/환불 처리 (결제 취소 + 프로 회수) ─────────────
--
-- 서버가 토스 취소 API를 호출해 성공한 뒤에만 부릅니다.
create or replace function public.revoke_pro_for_payment(
  p_order_id text,
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_status  text;
begin
  select user_id, status
    into v_user_id, v_status
    from public.payments
   where order_id = p_order_id
     for update;

  if not found then
    raise exception '주문을 찾을 수 없습니다: %', p_order_id;
  end if;

  if v_status = 'canceled' then
    return; -- 이미 취소된 주문
  end if;

  update public.payments
     set status        = 'canceled',
         cancel_reason = coalesce(p_reason, cancel_reason),
         canceled_at   = now(),
         updated_at    = now()
   where order_id = p_order_id;

  -- 다른 주문으로 아직 유효한 프로가 있으면 회수하지 않는다
  if v_user_id is not null and not exists (
    select 1 from public.payments
     where user_id = v_user_id
       and status  = 'approved'
       and order_id <> p_order_id
  ) then
    update public.user_entitlements
       set is_pro = false
     where user_id = v_user_id;
  end if;
end;
$$;


-- ── 5. 함수 실행 권한: 서버(service role)만 ────────────────
-- security definer 함수를 로그인 사용자가 부를 수 있으면 스스로 프로가 될 수 있습니다.
revoke all on function public.grant_pro_for_payment(text, text, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.revoke_pro_for_payment(text, text)
  from public, anon, authenticated;

-- 서버에는 명시적으로 되돌려 준다 (기본 권한 설정에 기대지 않는다)
grant execute on function public.grant_pro_for_payment(text, text, integer, text, text)
  to service_role;
grant execute on function public.revoke_pro_for_payment(text, text)
  to service_role;


-- ── 6. 확인 ──────────────────────────────────────────────
-- rls_enabled = true, policies = 1 이어야 합니다.
select
  c.relname                                     as table_name,
  c.relrowsecurity                              as rls_enabled,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'payments';

-- 함수 실행 권한 확인.
-- 2행이 나와야 하고, anon/authenticated 는 false, service_role 은 true 여야 합니다.
--   행이 0개            → 함수가 만들어지지 않은 것 (3·4번 블록에서 에러가 났다)
--   authenticated=true  → 권한 회수 실패. 로그인 사용자가 스스로 프로가 될 수 있으므로 결제를 붙이면 안 된다
select
  p.proname                                                as function_name,
  has_function_privilege('anon', p.oid, 'execute')          as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
  has_function_privilege('service_role', p.oid, 'execute')  as service_role_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('grant_pro_for_payment', 'revoke_pro_for_payment');


-- ── 7. 운영용 조회 (필요할 때 실행) ───────────────────────
--
-- 최근 결제 20건:
-- select order_id, user_id, amount, status, method, created_at, approved_at
--   from public.payments
--  order by created_at desc
--  limit 20;
--
-- 결제 ↔ 권한 대사 (승인됐는데 프로가 안 붙은 건이 있으면 여기 걸린다):
-- select p.order_id, p.user_id, p.amount, p.status, e.is_pro, e.source
--   from public.payments p
--   left join public.user_entitlements e on e.user_id = p.user_id
--  where p.status = 'approved'
--    and (e.is_pro is null or e.is_pro = false);

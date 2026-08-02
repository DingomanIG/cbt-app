-- 프로(유료) 권한 테이블 + RLS 정책
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- ⚠️ 이 테이블에는 SELECT 정책만 만듭니다.
--    클라이언트는 자기 권한을 "읽기만" 할 수 있고 스스로 프로가 될 수 없습니다.
--    프로 부여는 service role(서버)만 할 수 있습니다 — 지금은 아래 4번 스니펫으로 수동 부여하고,
--    나중에 결제를 붙이면 결제 승인 API가 같은 자리에 upsert 하게 됩니다.


-- ── 1. 권한 테이블 ────────────────────────────────────────
create table if not exists public.user_entitlements (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  is_pro     boolean     not null default false,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,                     -- null = 평생 이용
  source     text        not null default 'manual',  -- 'manual' | 'toss' | 'portone' …
  note       text
);


-- ── 2. RLS: 본인 행을 읽기만 할 수 있다 ────────────────────
alter table public.user_entitlements enable row level security;

drop policy if exists "read own entitlement" on public.user_entitlements;

create policy "read own entitlement" on public.user_entitlements
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE 정책은 일부러 만들지 않습니다.
-- 정책이 없으면 RLS가 거부하므로, service role 키를 가진 서버만 쓸 수 있습니다.


-- ── 3. 확인 ──────────────────────────────────────────────
-- rls_enabled = true, policies = 1 이어야 합니다.
select
  c.relname                                     as table_name,
  c.relrowsecurity                              as rls_enabled,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'user_entitlements';


-- ── 4. 관리자용 수동 부여 (필요할 때만 이메일을 바꿔 실행) ──
--
-- insert into public.user_entitlements (user_id, is_pro, source, note)
-- select id, true, 'manual', '수동 부여'
--   from auth.users
--  where email = 'bonekatana@gmail.com'
-- on conflict (user_id) do update
--   set is_pro = true, granted_at = now(), source = 'manual';
--
-- 회수:
-- update public.user_entitlements set is_pro = false
--  where user_id = (select id from auth.users where email = 'bonekatana@gmail.com');

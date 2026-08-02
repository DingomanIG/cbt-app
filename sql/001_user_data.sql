-- 로그인 사용자별 데이터 테이블 + RLS 정책
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- ⚠️ 문제 테이블(questions_*, summary_notes)에는 정책을 만들지 않습니다.
--    지금처럼 RLS가 켜져 있고 정책이 없는 상태가 정답입니다.
--    공개 읽기 정책을 열면 공개키를 가진 누구나 문제은행 전체를 직접 내려받을 수 있어,
--    api/questions.js의 서버 사이드 샘플링(500문항 상한)이 무력화됩니다.
--    문제는 앞으로도 서버(service role)를 통해서만 나갑니다.


-- ── 1. 오답노트 + 즐겨찾기 ────────────────────────────────
-- 둘 다 "문항에 붙는 표시"라 한 테이블로 둔다.
create table if not exists public.user_question_marks (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  question_id uuid        not null,
  source      text        not null check (source in ('mock', 'gisul_yesang', 'gisul')),
  is_wrong    boolean     not null default false,
  is_starred  boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, question_id)
);

-- 표시가 하나도 없는 행은 남겨둘 이유가 없다
alter table public.user_question_marks
  drop constraint if exists user_question_marks_not_empty;
alter table public.user_question_marks
  add constraint user_question_marks_not_empty check (is_wrong or is_starred);


-- ── 2. 풀이 기록 ─────────────────────────────────────────
create table if not exists public.user_exam_history (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  mode        text        not null check (mode in ('mock', 'gisul', 'chapter')),
  correct     integer     not null check (correct >= 0),
  total       integer     not null check (total > 0),
  score       integer     not null,
  passed      boolean     not null,
  subj_map    jsonb       not null default '{}'::jsonb,
  finished_at timestamptz not null default now()
);

create index if not exists user_exam_history_user_finished_idx
  on public.user_exam_history (user_id, finished_at desc);


-- ── 3. RLS: 본인 행만 읽고 쓸 수 있다 ──────────────────────
alter table public.user_question_marks enable row level security;
alter table public.user_exam_history  enable row level security;

drop policy if exists "own marks"   on public.user_question_marks;
drop policy if exists "own history" on public.user_exam_history;

create policy "own marks" on public.user_question_marks
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own history" on public.user_exam_history
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ── 4. 확인 ──────────────────────────────────────────────
-- 아래 결과에서 두 테이블 모두 rls_enabled = true, policies = 1 이어야 합니다.
select
  c.relname                                     as table_name,
  c.relrowsecurity                              as rls_enabled,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('user_question_marks', 'user_exam_history',
                    'questions_mock', 'questions_gisul_yesang',
                    'questions_gisul', 'summary_notes')
order by c.relname;

create extension if not exists pgcrypto;

create type public.proof_kind as enum ('image', 'link', 'note');
create type public.proof_status as enum ('submitted', 'approved', 'rejected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

-- A room's "day" doesn't have to be midnight-midnight: day_boundary_time is the wall-clock
-- moment (in `timezone`) a new cycle_date begins, e.g. 12:00 for a noon-to-noon room.
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  timezone text not null default 'UTC',
  day_boundary_time time not null default '00:00',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

-- rest_days holds up to 2 weekdays (0=Sunday..6=Saturday, matching both Postgres extract(dow,...)
-- and JS Date.getDay()) the member intends to skip posting. Whether a given rest weekday is
-- actually excused depends on that week's rest credits — see member_week_state.
create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  rest_days smallint[] not null default '{}' check (cardinality(rest_days) <= 2 and rest_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  joined_at timestamptz not null default now(),
  primary key (room_id,user_id)
);

-- The platforms a member chose at onboarding to grow on. Each day's 3 tasks are drawn from this
-- pool at random, so at least 3 rows are required before daily tasks can be generated.
create table public.profile_platforms (
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (char_length(platform) between 1 and 30),
  created_at timestamptz not null default now(),
  primary key (user_id, platform)
);

create table public.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  code text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
  created_by uuid not null references public.profiles(id),
  expires_at timestamptz,
  max_uses integer not null default 1 check (max_uses > 0),
  uses integer not null default 0 check (uses >= 0),
  created_at timestamptz not null default now()
);

-- One row per member per cycle_date per platform, generated (never client-inserted) by
-- get_today_status(). A rest day is recorded as a single platform='__rest__', points=0 marker
-- row rather than left absent, so a repeat call that same day reads the decision back instead
-- of re-evaluating (and re-spending) rest credits.
create table public.daily_tasks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  cycle_date date not null,
  platform text not null check (char_length(platform) between 1 and 30),
  points integer not null check (points between 0 and 50),
  created_at timestamptz not null default now(),
  unique (room_id, user_id, cycle_date, platform)
);
create index daily_tasks_room_date_idx on public.daily_tasks(room_id, cycle_date);
create index daily_tasks_user_date_idx on public.daily_tasks(user_id, cycle_date);

create table public.proofs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.daily_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  task_date date not null default current_date,
  kind public.proof_kind not null,
  link text,
  note text,
  file_path text,
  status public.proof_status not null default 'submitted',
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  unique (task_id),
  check ((kind = 'image' and file_path is not null) or (kind = 'link' and link is not null) or (kind = 'note' and note is not null))
);
create index proofs_room_date_idx on public.proofs(room_id, task_date);
create index room_members_user_idx on public.room_members(user_id);

-- Written only by settle_past_days(): the graded outcome of one room's one cycle_date, computed
-- once the day is over and never recomputed after (settled=true guards re-entry).
create table public.room_day_state (
  room_id uuid not null references public.rooms(id) on delete cascade,
  cycle_date date not null,
  settled boolean not null default false,
  combined_points integer not null default 0,
  grade text not null default 'missed',
  primary key (room_id, cycle_date)
);

-- Each member starts a week (Monday-anchored, independent of the room's own day boundary) with
-- 2 rest credits. A credit is spent either by legitimately resting on a chosen rest weekday, or
-- as a penalty when settle_past_days() finds a required posting day with zero approved proof.
-- rest_days is picked fresh each week (set_week_rest_days) rather than inherited permanently from
-- room_members.rest_days, which now only serves as a pre-fill default for the next week's picker.
-- NULL means "hasn't picked yet this week" — get_today_status() treats that as no rest day today.
create table public.member_week_state (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  rest_credits_remaining smallint not null default 2 check (rest_credits_remaining between 0 and 2),
  rest_days smallint[] check (rest_days is null or (cardinality(rest_days) <= 2 and rest_days <@ array[0,1,2,3,4,5,6]::smallint[])),
  primary key (room_id, user_id, week_start)
);

create table public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index room_messages_room_created_idx on public.room_messages(room_id, created_at);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.profile_platforms enable row level security;
alter table public.room_invites enable row level security;
alter table public.daily_tasks enable row level security;
alter table public.proofs enable row level security;
alter table public.room_day_state enable row level security;
alter table public.member_week_state enable row level security;
alter table public.room_messages enable row level security;
alter publication supabase_realtime add table public.room_messages;
alter publication supabase_realtime add table public.proofs;

-- A SELECT policy on room_members that queries room_members from within its own USING clause
-- causes Postgres to report "infinite recursion detected in policy for relation room_members".
-- Routing the membership check through this SECURITY DEFINER function sidesteps RLS entirely
-- for that one lookup, so it can safely be reused by every policy below that needs it.
create or replace function public.is_current_room_member(target_room uuid)
returns boolean language sql stable security definer set search_path = 'public' as $$
  select auth.uid() is not null
    and exists (select 1 from public.room_members where room_id = target_room and user_id = auth.uid());
$$;
revoke all on function public.is_current_room_member(uuid) from public;
grant execute on function public.is_current_room_member(uuid) to authenticated;

create policy "profiles visible to signed-in users" on public.profiles for select to authenticated using (true);
create policy "users update own profile" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "members see their rooms" on public.rooms for select to authenticated using (public.is_current_room_member(id));
create policy "creator creates a room" on public.rooms for insert to authenticated with check ((select auth.uid()) = created_by);
create policy "owners update rooms" on public.rooms for update to authenticated using (exists (select 1 from public.room_members m where m.room_id = rooms.id and m.user_id = (select auth.uid()) and m.role = 'owner')) with check (exists (select 1 from public.room_members m where m.room_id = rooms.id and m.user_id = (select auth.uid()) and m.role = 'owner'));

create policy "members see room members" on public.room_members for select to authenticated using (public.is_current_room_member(room_id));
-- No insert/update policy for room_members: membership is only ever created or changed by
-- create_room(), join_room_with_invite(), and set_member_rest_days() below, all SECURITY
-- DEFINER, so a client can never add itself to a room or edit rest days by a raw table write.

create policy "user sees own platforms" on public.profile_platforms for select to authenticated using ((select auth.uid()) = user_id);
-- No insert/delete policy: platforms are only ever written by set_profile_platforms(), which
-- enforces the "at least 3" rule that a plain RLS check couldn't express across sibling rows.

create policy "owners see invites" on public.room_invites for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = room_invites.room_id and m.user_id = (select auth.uid()) and m.role = 'owner'));
create policy "owners create invites" on public.room_invites for insert to authenticated with check ((select auth.uid()) = created_by and exists (select 1 from public.room_members m where m.room_id = room_invites.room_id and m.user_id = (select auth.uid()) and m.role = 'owner'));

create policy "members see daily tasks" on public.daily_tasks for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = daily_tasks.room_id and m.user_id = (select auth.uid())));
-- No insert/update/delete policy: daily_tasks rows are only ever created by get_today_status().

create policy "members see proofs" on public.proofs for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = proofs.room_id and m.user_id = (select auth.uid())));
create policy "members submit own proof" on public.proofs for insert to authenticated with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.room_members m where m.room_id = proofs.room_id and m.user_id = (select auth.uid()))
  -- the task must actually be this user's own daily task for that room/date, so a proof can
  -- never be filed against someone else's (e.g. a partner's) assigned task
  and exists (select 1 from public.daily_tasks dt where dt.id = proofs.task_id and dt.user_id = proofs.user_id and dt.room_id = proofs.room_id and dt.cycle_date = proofs.task_date)
);
-- Submitter may only touch their own proof while it is unreviewed (submitted) or was rejected
-- (to resubmit), and every such write must land back in 'submitted' with no review fields set.
-- This is what closes the self-approval hole: a submitter can never set status to 'approved'
-- themselves, only a room partner via review_proof() below can.
create policy "submitter resubmits own proof" on public.proofs for update to authenticated
  using ((select auth.uid()) = user_id and status in ('submitted','rejected'))
  with check ((select auth.uid()) = user_id and status = 'submitted' and reviewed_by is null and reviewed_at is null and rejection_reason is null);

create policy "members see room day state" on public.room_day_state for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = room_day_state.room_id and m.user_id = (select auth.uid())));
-- No write policy: only settle_past_days() writes this table.

create policy "members see week state" on public.member_week_state for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = member_week_state.room_id and m.user_id = (select auth.uid())));
-- No write policy: only get_today_status()/settle_past_days()/set_week_rest_days() write this
-- table. Visible to every room member (not just its owner) so partners can see each other's
-- remaining rest credits.

create policy "members see room messages" on public.room_messages for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = room_messages.room_id and m.user_id = (select auth.uid())));
create policy "members send room messages" on public.room_messages for insert to authenticated with check ((select auth.uid()) = user_id and exists (select 1 from public.room_members m where m.room_id = room_messages.room_id and m.user_id = (select auth.uid())));
-- No update/delete policy: messages are immutable for v1, no editing or deleting.

-- Given a room and an instant, returns the "cycle_date" that instant belongs to: the calendar
-- date (in the room's own timezone) of the most recent day_boundary_time at or before that
-- instant. A 12:00 boundary means 11:59am belongs to yesterday's cycle, 12:01pm to today's.
create or replace function public.room_cycle_date(target_room uuid, moment timestamptz default now())
returns date language sql stable set search_path = '' as $$
  select case when (moment at time zone r.timezone)::time >= r.day_boundary_time
    then (moment at time zone r.timezone)::date
    else ((moment at time zone r.timezone)::date - 1)
  end
  from public.rooms r where r.id = target_room
$$;

create or replace function public.create_room(room_name text, tz text, boundary_time time, creator_rest_days smallint[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_room uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if creator_rest_days is not null and cardinality(creator_rest_days) > 2 then raise exception 'Pick at most 2 rest days'; end if;
  insert into public.rooms(name,timezone,day_boundary_time,created_by)
    values(room_name, coalesce(tz,'UTC'), coalesce(boundary_time,'00:00'), auth.uid())
    returning id into new_room;
  insert into public.room_members(room_id,user_id,role,rest_days) values(new_room,auth.uid(),'owner',coalesce(creator_rest_days,'{}'));
  return new_room;
end; $$;
revoke all on function public.create_room(text,text,time,smallint[]) from public;
grant execute on function public.create_room(text,text,time,smallint[]) to authenticated;

create or replace function public.join_room_with_invite(invite_code text, joiner_rest_days smallint[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if joiner_rest_days is not null and cardinality(joiner_rest_days) > 2 then raise exception 'Pick at most 2 rest days'; end if;
  select room_id into target_room from public.room_invites where code = upper(invite_code) and uses < max_uses and (expires_at is null or expires_at > now()) for update;
  if target_room is null then raise exception 'This invite is invalid or expired'; end if;
  if exists (select 1 from public.room_members where room_id = target_room and user_id = auth.uid()) then
    return target_room;
  end if;
  if (select count(*) from public.room_members where room_id = target_room) >= 2 then
    raise exception 'This room already has 2 members';
  end if;
  insert into public.room_members(room_id,user_id,rest_days) values(target_room,auth.uid(),coalesce(joiner_rest_days,'{}')) on conflict do nothing;
  update public.room_invites set uses = uses + 1 where room_id = target_room and code = upper(invite_code);
  return target_room;
end; $$;
revoke all on function public.join_room_with_invite(text,smallint[]) from public;
grant execute on function public.join_room_with_invite(text,smallint[]) to authenticated;

create or replace function public.set_profile_platforms(platforms text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if platforms is null or cardinality(platforms) < 3 then raise exception 'Pick at least 3 platforms'; end if;
  delete from public.profile_platforms where user_id = auth.uid();
  insert into public.profile_platforms(user_id, platform)
    select auth.uid(), p from unnest(platforms) as p group by p;
end; $$;
revoke all on function public.set_profile_platforms(text[]) from public;
grant execute on function public.set_profile_platforms(text[]) to authenticated;

create or replace function public.set_member_rest_days(target_room uuid, days smallint[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if days is not null and cardinality(days) > 2 then raise exception 'Pick at most 2 rest days'; end if;
  update public.room_members set rest_days = coalesce(days,'{}') where room_id = target_room and user_id = auth.uid();
  if not found then raise exception 'Not a member of this room'; end if;
end; $$;
revoke all on function public.set_member_rest_days(uuid,smallint[]) from public;
grant execute on function public.set_member_rest_days(uuid,smallint[]) to authenticated;

-- Picks this member's rest days for the CURRENT week (the one get_today_status would compute
-- right now). Also updates room_members.rest_days so next week's picker has a sensible default
-- to pre-fill from, but that column is otherwise no longer authoritative for enforcement.
create or replace function public.set_week_rest_days(target_room uuid, days smallint[])
returns void language plpgsql security definer set search_path = '' as $$
declare cdate date; wk_start date;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if days is not null and cardinality(days) > 2 then raise exception 'Pick at most 2 rest days'; end if;
  if not exists (select 1 from public.room_members where room_id = target_room and user_id = auth.uid()) then
    raise exception 'Not a member of this room';
  end if;
  cdate := public.room_cycle_date(target_room);
  wk_start := cdate - (((extract(dow from cdate)::int + 6) % 7));
  insert into public.member_week_state(room_id,user_id,week_start,rest_credits_remaining,rest_days)
    values (target_room, auth.uid(), wk_start, 2, coalesce(days,'{}'))
    on conflict (room_id,user_id,week_start) do update set rest_days = excluded.rest_days;
  update public.room_members set rest_days = coalesce(days,'{}') where room_id = target_room and user_id = auth.uid();
end; $$;
revoke all on function public.set_week_rest_days(uuid,smallint[]) from public;
grant execute on function public.set_week_rest_days(uuid,smallint[]) to authenticated;

-- Grades and closes out every past (cycle_date < today), not-yet-settled day for a room: sums
-- each day's approved points across all members into combined_points, assigns a grade label,
-- and burns one rest credit from any member who had real (non-rest) tasks that day but zero
-- approved proof. Idempotent via room_day_state.settled, so it's safe to call on every page
-- load rather than needing a cron — the tradeoff is a day nobody ever opens the app on never
-- gets settled at all, which is a known gap of this lazy approach.
create or replace function public.settle_past_days(target_room uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare cdate date; d date; combined int; grade text; member record; wk_start date;
begin
  cdate := public.room_cycle_date(target_room);
  for d in
    select distinct dt.cycle_date from public.daily_tasks dt
    where dt.room_id = target_room and dt.cycle_date < cdate
      and not exists (select 1 from public.room_day_state s where s.room_id = target_room and s.cycle_date = dt.cycle_date and s.settled)
    order by dt.cycle_date
  loop
    select coalesce(sum(p.points),0) into combined
      from public.proofs p join public.daily_tasks dt on dt.id = p.task_id
      where dt.room_id = target_room and dt.cycle_date = d and p.status = 'approved';

    grade := case when combined >= 100 then 'lovely' when combined >= 90 then 'almost'
                  when combined >= 80 then 'great' when combined >= 70 then 'okay'
                  when combined >= 50 then 'mid' else 'missed' end;

    insert into public.room_day_state(room_id,cycle_date,settled,combined_points,grade)
      values (target_room, d, true, combined, grade)
      on conflict (room_id,cycle_date) do update set settled = true, combined_points = excluded.combined_points, grade = excluded.grade;

    wk_start := d - (((extract(dow from d)::int + 6) % 7));
    for member in select rm.user_id from public.room_members rm where rm.room_id = target_room loop
      if exists (select 1 from public.daily_tasks dt where dt.room_id = target_room and dt.user_id = member.user_id and dt.cycle_date = d and dt.platform <> '__rest__')
         and not exists (select 1 from public.proofs p join public.daily_tasks dt on dt.id = p.task_id
                          where dt.room_id = target_room and dt.user_id = member.user_id and dt.cycle_date = d and p.status = 'approved') then
        insert into public.member_week_state(room_id,user_id,week_start,rest_credits_remaining)
          values (target_room, member.user_id, wk_start, 2)
          on conflict (room_id,user_id,week_start) do nothing;
        update public.member_week_state set rest_credits_remaining = greatest(0, rest_credits_remaining - 1)
          where room_id = target_room and user_id = member.user_id and week_start = wk_start;
      end if;
    end loop;
  end loop;
end; $$;

-- The single entry point the dashboard calls on load: settles any stale past days for the room,
-- then figures out today (is it an excused rest day, or does it need 3 fresh tasks generated),
-- and returns {cycle_date, is_rest_day, tasks: daily_tasks[]} as jsonb.
create or replace function public.get_today_status(target_room uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cdate date; wk_start date; credits smallint; is_rest boolean := false;
  today_dow smallint; member_rest_days smallint[]; tasks jsonb;
  prefs text[]; chosen text[]; splits int[];
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from public.room_members where room_id = target_room and user_id = auth.uid()) then
    raise exception 'Not a member of this room';
  end if;

  perform public.settle_past_days(target_room);

  cdate := public.room_cycle_date(target_room);
  today_dow := extract(dow from cdate)::int;
  wk_start := cdate - (((extract(dow from cdate)::int + 6) % 7));

  insert into public.member_week_state(room_id,user_id,week_start,rest_credits_remaining)
    values (target_room, auth.uid(), wk_start, 2)
    on conflict (room_id,user_id,week_start) do nothing;

  -- Rest days are picked fresh per week via set_week_rest_days(); NULL here means the member
  -- hasn't picked yet this week, which the client prompts for and which counts as no rest day.
  select rest_credits_remaining, rest_days into credits, member_rest_days
    from public.member_week_state where room_id = target_room and user_id = auth.uid() and week_start = wk_start;

  if not exists (select 1 from public.daily_tasks where room_id = target_room and user_id = auth.uid() and cycle_date = cdate) then
    if member_rest_days is not null and today_dow = any(member_rest_days) and coalesce(credits,0) > 0 then
      insert into public.daily_tasks(room_id,user_id,cycle_date,platform,points) values (target_room, auth.uid(), cdate, '__rest__', 0);
      update public.member_week_state set rest_credits_remaining = rest_credits_remaining - 1
        where room_id = target_room and user_id = auth.uid() and week_start = wk_start;
    else
      select array_agg(platform) into prefs from public.profile_platforms where user_id = auth.uid();
      if prefs is null or array_length(prefs,1) < 3 then
        raise exception 'Pick at least 3 platforms in your profile before today''s tasks can be generated';
      end if;
      select array_agg(p) into chosen from (select p from unnest(prefs) as p order by random() limit 3) s;
      select arr into splits from (values (array[20,20,10]),(array[30,10,10]),(array[40,5,5]),(array[25,15,10]),(array[35,10,5])) as t(arr)
        order by random() limit 1;
      select array_agg(v) into splits from (select v from unnest(splits) v order by random()) s2;
      insert into public.daily_tasks(room_id,user_id,cycle_date,platform,points)
        values (target_room, auth.uid(), cdate, chosen[1], splits[1]),
               (target_room, auth.uid(), cdate, chosen[2], splits[2]),
               (target_room, auth.uid(), cdate, chosen[3], splits[3]);
    end if;
  end if;

  is_rest := exists (select 1 from public.daily_tasks where room_id = target_room and user_id = auth.uid() and cycle_date = cdate and platform = '__rest__');

  select coalesce(jsonb_agg(to_jsonb(dt) order by dt.created_at), '[]'::jsonb) into tasks
    from public.daily_tasks dt where dt.room_id = target_room and dt.user_id = auth.uid() and dt.cycle_date = cdate and dt.platform <> '__rest__';

  return jsonb_build_object('cycle_date', cdate, 'is_rest_day', is_rest, 'tasks', tasks);
end; $$;
revoke all on function public.get_today_status(uuid) from public;
grant execute on function public.get_today_status(uuid) to authenticated;

-- Reviewing a partner's proof always goes through this function rather than a direct table
-- update, so the reviewer identity, the "not your own proof" rule, and the "already reviewed"
-- rule are all enforced in one place instead of relying on a client-trusted RLS update policy.
create or replace function public.review_proof(proof_id uuid, decision public.proof_status, reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.proofs;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  select * into target from public.proofs where id = proof_id for update;
  if target is null then raise exception 'Proof not found'; end if;
  if target.user_id = auth.uid() then raise exception 'You cannot review your own proof'; end if;
  if target.status <> 'submitted' then raise exception 'Proof already reviewed'; end if;
  if not exists (select 1 from public.room_members m where m.room_id = target.room_id and m.user_id = auth.uid()) then
    raise exception 'Not a member of this room';
  end if;
  update public.proofs set status = decision, reviewed_by = auth.uid(), reviewed_at = now(),
    rejection_reason = case when decision = 'rejected' then reason else null end
    where id = proof_id;
end; $$;
revoke all on function public.review_proof(uuid,public.proof_status,text) from public;
grant execute on function public.review_proof(uuid,public.proof_status,text) to authenticated;

-- A solo room (exactly one member) has nobody who could ever pass review_proof()'s "not your own
-- proof" check, so proof would sit at 'submitted' forever. This trigger auto-approves it instead,
-- based on the room's actual membership count at insert time (never client-controlled), so a
-- 2-person room can't be tricked into self-approval by claiming solo client-side.
create or replace function public.auto_approve_solo_proof() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.room_members where room_id = new.room_id) = 1 then
    update public.proofs set status = 'approved', reviewed_by = new.user_id, reviewed_at = now()
      where id = new.id and status = 'submitted';
  end if;
  return new;
end; $$;
revoke all on function public.auto_approve_solo_proof() from public;
create trigger proofs_auto_approve_solo after insert on public.proofs for each row execute function public.auto_approve_solo_proof();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin insert into public.profiles(id,display_name) values(new.id,coalesce(new.raw_user_meta_data->>'display_name','New friend')); return new; end; $$;
revoke all on function public.handle_new_user() from public;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

insert into storage.buckets(id,name,public) values ('proof-images','proof-images',false) on conflict do nothing;
create policy "users upload own proof image" on storage.objects for insert to authenticated with check (bucket_id = 'proof-images' and exists (select 1 from public.proofs p where p.id::text = (storage.foldername(name))[1] and p.user_id = (select auth.uid())));
create policy "room members view proof images" on storage.objects for select to authenticated using (bucket_id = 'proof-images' and exists (select 1 from public.proofs p join public.room_members m on m.room_id = p.room_id where p.id::text = (storage.foldername(name))[1] and m.user_id = (select auth.uid())));

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

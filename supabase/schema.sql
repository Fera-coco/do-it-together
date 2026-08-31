create extension if not exists pgcrypto;

create type public.room_track as enum ('creator', 'social');
create type public.proof_kind as enum ('image', 'link', 'note');
create type public.proof_status as enum ('submitted', 'approved', 'rejected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  track public.room_track not null default 'creator',
  daily_target integer not null default 10 check (daily_target in (10,25,40)),
  timezone text not null default 'Europe/London',
  deadline_time time not null default '23:59',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (room_id,user_id)
);
create table public.room_tasks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  detail text,
  platform text,
  points integer not null default 10 check (points between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
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
create table public.proofs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.room_tasks(id) on delete cascade,
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
  unique (task_id,user_id,task_date),
  check ((kind = 'image' and file_path is not null) or (kind = 'link' and link is not null) or (kind = 'note' and note is not null))
);

create index proofs_room_date_idx on public.proofs(room_id, task_date);
create index room_members_user_idx on public.room_members(user_id);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_tasks enable row level security;
alter table public.room_invites enable row level security;
alter table public.proofs enable row level security;

create policy "profiles visible to signed-in users" on public.profiles for select to authenticated using (true);
create policy "users update own profile" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "members see their rooms" on public.rooms for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = rooms.id and m.user_id = (select auth.uid())));
create policy "creator creates a room" on public.rooms for insert to authenticated with check ((select auth.uid()) = created_by);
create policy "owners update rooms" on public.rooms for update to authenticated using (exists (select 1 from public.room_members m where m.room_id = rooms.id and m.user_id = (select auth.uid()) and m.role = 'owner')) with check (exists (select 1 from public.room_members m where m.room_id = rooms.id and m.user_id = (select auth.uid()) and m.role = 'owner'));
create policy "members see room members" on public.room_members for select to authenticated using (exists (select 1 from public.room_members me where me.room_id = room_members.room_id and me.user_id = (select auth.uid())));
create policy "members see tasks" on public.room_tasks for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = room_tasks.room_id and m.user_id = (select auth.uid())));
create policy "owners manage tasks" on public.room_tasks for all to authenticated using (exists (select 1 from public.room_members m where m.room_id = room_tasks.room_id and m.user_id = (select auth.uid()) and m.role = 'owner')) with check (exists (select 1 from public.room_members m where m.room_id = room_tasks.room_id and m.user_id = (select auth.uid()) and m.role = 'owner'));
create policy "members see proofs" on public.proofs for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = proofs.room_id and m.user_id = (select auth.uid())));
create policy "members submit own proof" on public.proofs for insert to authenticated with check ((select auth.uid()) = user_id and exists (select 1 from public.room_members m where m.room_id = proofs.room_id and m.user_id = (select auth.uid())));
create policy "submitter updates unreviewed proof" on public.proofs for update to authenticated using ((select auth.uid()) = user_id and status = 'submitted') with check ((select auth.uid()) = user_id);
create policy "room partner reviews proof" on public.proofs for update to authenticated using (user_id <> (select auth.uid()) and exists (select 1 from public.room_members m where m.room_id = proofs.room_id and m.user_id = (select auth.uid()))) with check (reviewed_by = (select auth.uid()));
create policy "owners see invites" on public.room_invites for select to authenticated using (exists (select 1 from public.room_members m where m.room_id = room_invites.room_id and m.user_id = (select auth.uid()) and m.role = 'owner'));
create policy "owners create invites" on public.room_invites for insert to authenticated with check ((select auth.uid()) = created_by and exists (select 1 from public.room_members m where m.room_id = room_invites.room_id and m.user_id = (select auth.uid()) and m.role = 'owner'));

create or replace function public.create_room_with_tasks(room_name text, chosen_track public.room_track, target integer, task_rows jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_room uuid; row jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.rooms(name,track,daily_target,created_by) values(room_name,chosen_track,target,auth.uid()) returning id into new_room;
  insert into public.room_members(room_id,user_id,role) values(new_room,auth.uid(),'owner');
  for row in select * from jsonb_array_elements(task_rows) loop
    insert into public.room_tasks(room_id,title,detail,platform,points) values(new_room,row->>'title',row->>'detail',row->>'platform',(row->>'points')::integer);
  end loop;
  return new_room;
end; $$;
revoke all on function public.create_room_with_tasks(text,public.room_track,integer,jsonb) from public;
grant execute on function public.create_room_with_tasks(text,public.room_track,integer,jsonb) to authenticated;

create or replace function public.join_room_with_invite(invite_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_room uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select room_id into target_room from public.room_invites where code = upper(invite_code) and uses < max_uses and (expires_at is null or expires_at > now()) for update;
  if target_room is null then raise exception 'This invite is invalid or expired'; end if;
  insert into public.room_members(room_id,user_id) values(target_room,auth.uid()) on conflict do nothing;
  update public.room_invites set uses = uses + 1 where room_id = target_room and code = upper(invite_code);
  return target_room;
end; $$;
revoke all on function public.join_room_with_invite(text) from public;
grant execute on function public.join_room_with_invite(text) to authenticated;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin insert into public.profiles(id,display_name) values(new.id,coalesce(new.raw_user_meta_data->>'display_name','New friend')); return new; end; $$;
revoke all on function public.handle_new_user() from public;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

insert into storage.buckets(id,name,public) values ('proof-images','proof-images',false) on conflict do nothing;
create policy "users upload own proof image" on storage.objects for insert to authenticated with check (bucket_id = 'proof-images' and exists (select 1 from public.proofs p where p.id::text = (storage.foldername(name))[1] and p.user_id = (select auth.uid())));
create policy "room members view proof images" on storage.objects for select to authenticated using (bucket_id = 'proof-images' and exists (select 1 from public.proofs p join public.room_members m on m.room_id = p.room_id where p.id::text = (storage.foldername(name))[1] and m.user_id = (select auth.uid())));

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

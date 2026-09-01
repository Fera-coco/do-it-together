'use client'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { isConfigured, supabase } from '@/lib/supabase/client'

type RoomSummary = { id: string; name: string; timezone: string; day_boundary_time: string }
type Member = { user_id: string; role: 'owner' | 'member'; rest_days: number[]; profiles: { display_name: string } | null }
type DailyTask = { id: string; user_id: string; platform: string; points: number }
type ProofStatus = 'submitted' | 'approved' | 'rejected'
type Proof = {
  id: string
  task_id: string
  user_id: string
  status: ProofStatus
  kind: 'image' | 'link' | 'note'
  note: string | null
  link: string | null
  file_path: string | null
  profiles: { display_name: string } | null
  daily_tasks: { platform: string; points: number } | null
}
type DayState = { cycle_date: string; combined_points: number; grade: string }
type WeekState = { user_id: string; rest_credits_remaining: number; rest_days: number[] | null }
type ChatMessage = { id: string; user_id: string; body: string; created_at: string }
type Mode = 'auth' | 'platforms' | 'profile' | 'setup' | 'join' | 'room'

const PLATFORM_OPTIONS = ['Instagram', 'TikTok', 'YouTube', 'X (Twitter)', 'LinkedIn', 'Threads', 'Facebook', 'Pinterest', 'Snapchat', 'Other']
const WEEKDAYS = [{ v: 0, l: 'Sun' }, { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' }]
const BOUNDARY_PRESETS = [{ v: '00:00', l: 'Midnight → Midnight' }, { v: '06:00', l: '6am → 6am' }, { v: '12:00', l: 'Noon → Noon' }, { v: '18:00', l: '6pm → 6pm' }]
const ACTIVE_ROOM_KEY = 'dit_active_room'

function gradeLabel(points: number) {
  if (points >= 100) return 'Lovely'
  if (points >= 90) return 'Almost'
  if (points >= 80) return 'Great'
  if (points >= 70) return 'Okay'
  if (points >= 50) return 'Mid'
  return 'Missed'
}
function mondayOf(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}
function formatBoundary(t: string) {
  const [h, m] = t.split(':').map(Number)
  const h12 = ((h + 11) % 12) + 1
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
function formatShortDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
function formatTime(d: string) {
  return new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
function nextBoundary(boundaryTime: string) {
  const [h, m] = boundaryTime.split(':').map(Number)
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next
}
function readStoredRoomId() {
  try { return localStorage.getItem(ACTIVE_ROOM_KEY) } catch { return null }
}
function storeRoomId(id: string) {
  try { localStorage.setItem(ACTIVE_ROOM_KEY, id) } catch { /* private browsing etc — fine to skip */ }
}

function WeekdayPicker({ selected, onToggle }: { selected: number[]; onToggle: (d: number) => void }) {
  return (
    <div className="weekdayPicker">
      {WEEKDAYS.map(w => (
        <button type="button" key={w.v} className={selected.includes(w.v) ? 'picked' : ''} onClick={() => onToggle(w.v)}>{w.l}</button>
      ))}
    </div>
  )
}

export default function Home() {
  const db = useMemo(() => (isConfigured() ? supabase() : null), [])
  const [user, setUser] = useState<any>(null)
  const [room, setRoom] = useState<RoomSummary | null>(null)
  const [myRooms, setMyRooms] = useState<RoomSummary[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [tasks, setTasks] = useState<DailyTask[]>([])
  const [partnerTasks, setPartnerTasks] = useState<DailyTask[]>([])
  const [proofs, setProofs] = useState<Proof[]>([])
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [dayStates, setDayStates] = useState<DayState[]>([])
  const [weekStates, setWeekStates] = useState<WeekState[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [cycleDate, setCycleDate] = useState('')
  const [isRestDay, setIsRestDay] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<Mode>('auth')
  const [cameFromRoom, setCameFromRoom] = useState(false)
  const [authView, setAuthView] = useState<'signup' | 'signin'>('signup')
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [setupRestDays, setSetupRestDays] = useState<number[]>([])
  const [joinRestDays, setJoinRestDays] = useState<number[]>([])
  const [weekPickerDays, setWeekPickerDays] = useState<number[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [proofModalTask, setProofModalTask] = useState<DailyTask | null>(null)
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [rejectingProof, setRejectingProof] = useState<Proof | null>(null)
  const [, setTick] = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!db) return
    db.auth.getUser().then(({ data }) => {
      setUser(data.user)
      if (data.user) checkUserState()
    })
    const { data: { subscription } } = db.auth.onAuthStateChange((_e, s) => {
      setUser(s?.user ?? null)
      if (s?.user) checkUserState()
      else { setRoom(null); setMyRooms([]); setMode('auth') }
    })
    return () => subscription.unsubscribe()
  }, [db])

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!db || !room) return
    const channel = db.channel(`room-messages-${room.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` }, (payload: any) => {
        setMessages(prev => (prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new as ChatMessage]))
      })
      .subscribe()
    return () => { db.removeChannel(channel) }
  }, [db, room?.id])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'nearest' }) }, [messages.length])

  async function checkUserState() {
    if (!db) return
    const { data: platRows } = await db.from('profile_platforms').select('platform')
    if (!platRows || platRows.length < 3) { setMode('platforms'); return }
    const { data: authUser } = await db.auth.getUser()
    const myId = authUser.user?.id
    // Without filtering to my own membership rows, a shared room would come back once per
    // member (RLS on room_members exposes every row in any room I belong to, not just mine).
    const { data: memberships } = await db.from('room_members').select('room_id,rooms(id,name,timezone,day_boundary_time)').eq('user_id', myId)
    const rooms: RoomSummary[] = ((memberships as any) || []).map((m: any) => m.rooms).filter(Boolean)
    setMyRooms(rooms)
    if (!rooms.length) { setMode('profile'); return }
    const stored = readStoredRoomId()
    const active = rooms.find(r => r.id === stored) || rooms[0]
    await loadDashboard(active)
  }

  async function switchRoom(r: RoomSummary) {
    storeRoomId(r.id)
    await loadDashboard(r)
  }

  async function loadDashboard(roomRow: RoomSummary) {
    if (!db) return
    setRoom(roomRow)
    storeRoomId(roomRow.id)
    setShowSettings(false)
    const [{ data: memberRows }, { data: status, error: statusError }] = await Promise.all([
      db.from('room_members').select('user_id,role,rest_days,profiles(display_name)').eq('room_id', roomRow.id),
      db.rpc('get_today_status', { target_room: roomRow.id }),
    ])
    const membersList = (memberRows as any) || []
    setMembers(membersList)
    if (statusError) { setNotice(statusError.message); return }

    const cdate = String(status.cycle_date)
    setCycleDate(cdate)
    setIsRestDay(Boolean(status.is_rest_day))
    setTasks((status.tasks as DailyTask[]) || [])

    const { data: authUser } = await db.auth.getUser()
    const myId = authUser.user?.id
    const me = membersList.find((m: Member) => m.user_id === myId)
    const amOwner = me?.role === 'owner'
    setIsOwner(amOwner)

    const weekStart = mondayOf(cdate)
    const [{ data: allTasks }, { data: proofRows }, { data: dayRows }, { data: weekRows }, { data: chatRows }, inviteResult] = await Promise.all([
      db.from('daily_tasks').select('id,user_id,platform,points').eq('room_id', roomRow.id).eq('cycle_date', cdate).neq('platform', '__rest__'),
      db.from('proofs').select('id,task_id,user_id,status,kind,note,link,file_path,profiles(display_name),daily_tasks(platform,points)').eq('room_id', roomRow.id).eq('task_date', cdate),
      db.from('room_day_state').select('cycle_date,combined_points,grade').eq('room_id', roomRow.id).order('cycle_date', { ascending: false }).limit(7),
      db.from('member_week_state').select('user_id,rest_credits_remaining,rest_days').eq('room_id', roomRow.id).eq('week_start', weekStart),
      db.from('room_messages').select('id,user_id,body,created_at').eq('room_id', roomRow.id).order('created_at', { ascending: true }).limit(100),
      amOwner
        ? db.from('room_invites').select('code,uses,max_uses').eq('room_id', roomRow.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null as any }),
    ])
    setPartnerTasks(((allTasks as any) || []).filter((t: DailyTask) => t.user_id !== myId))
    const proofList: Proof[] = (proofRows as any) || []
    setProofs(proofList)
    setDayStates((((dayRows as any) || []) as DayState[]).slice().reverse())
    const weekList: WeekState[] = (weekRows as any) || []
    setWeekStates(weekList)
    setMessages((chatRows as any) || [])
    setInviteCode(inviteResult.data && inviteResult.data.uses < inviteResult.data.max_uses ? inviteResult.data.code : '')

    const myWeek = weekList.find(w => w.user_id === myId)
    setWeekPickerDays(myWeek?.rest_days || me?.rest_days || [])

    ensureSignedUrls(proofList)
    setMode('room')
  }

  async function ensureSignedUrls(proofList: Proof[]) {
    if (!db) return
    const need = proofList.filter(p => p.kind === 'image' && p.file_path && !signedUrls[p.id])
    if (!need.length) return
    const entries = await Promise.all(need.map(async p => {
      const { data } = await db.storage.from('proof-images').createSignedUrl(p.file_path!, 3600)
      return [p.id, data?.signedUrl || ''] as const
    }))
    setSignedUrls(prev => ({ ...prev, ...Object.fromEntries(entries) }))
  }

  async function auth(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email')), password = String(form.get('password')), name = String(form.get('name'))
    const result = authView === 'signup'
      ? await db.auth.signUp({ email, password, options: { data: { display_name: name } } })
      : await db.auth.signInWithPassword({ email, password })
    if (result.error) setNotice(result.error.message)
    else setNotice(authView === 'signup' ? 'Account created. Check your email if confirmation is turned on.' : 'Welcome back.')
  }

  function togglePlatform(p: string) {
    setSelectedPlatforms(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  async function savePlatforms(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    if (selectedPlatforms.length < 3) { setNotice('Pick at least 3 platforms.'); return }
    const { error } = await db.rpc('set_profile_platforms', { platforms: selectedPlatforms })
    if (error) { setNotice(error.message); return }
    setNotice('')
    await checkUserState()
  }

  function toggleSetupRestDay(d: number) {
    setSetupRestDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : prev.length < 2 ? [...prev, d] : prev)
  }
  function toggleJoinRestDay(d: number) {
    setJoinRestDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : prev.length < 2 ? [...prev, d] : prev)
  }
  function toggleWeekPickerDay(d: number) {
    setWeekPickerDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : prev.length < 2 ? [...prev, d] : prev)
  }

  async function createRoom(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const name = String(form.get('room'))
    const boundary = String(form.get('boundary'))
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const { data: roomId, error } = await db.rpc('create_room', { room_name: name, tz, boundary_time: boundary, creator_rest_days: setupRestDays })
    if (error || !roomId) { setNotice(error?.message || 'Could not create room'); return }
    setNotice('')
    storeRoomId(roomId)
    setCameFromRoom(false)
    await checkUserState()
  }

  async function joinRoom(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const code = String(new FormData(e.currentTarget).get('code')).trim()
    const { data: roomId, error } = await db.rpc('join_room_with_invite', { invite_code: code, joiner_rest_days: joinRestDays })
    if (error) { setNotice(error.message); return }
    setNotice('')
    if (roomId) storeRoomId(roomId)
    setCameFromRoom(false)
    await checkUserState()
  }

  async function generateInvite() {
    if (!db || !room || !user) return
    const { data, error } = await db.from('room_invites').insert({ room_id: room.id, created_by: user.id }).select('code').single()
    if (error) setNotice(error.message)
    else setInviteCode(data.code)
  }

  async function saveWeekRestDays(skip: boolean) {
    if (!db || !room) return
    const { error } = await db.rpc('set_week_rest_days', { target_room: room.id, days: skip ? [] : weekPickerDays })
    if (error) setNotice(error.message)
    else { setNotice(skip ? 'No rest days picked this week.' : 'Rest days saved for this week.'); await loadDashboard(room) }
  }

  async function saveRoomSettings(e: FormEvent<HTMLFormElement>) {
    if (!db || !room) return
    e.preventDefault()
    const boundary = String(new FormData(e.currentTarget).get('boundary'))
    const { error } = await db.from('rooms').update({ day_boundary_time: boundary }).eq('id', room.id)
    if (error) setNotice(error.message)
    else { setNotice('Room clock updated.'); setShowSettings(false); await loadDashboard({ ...room, day_boundary_time: boundary }) }
  }

  async function submitProofModal(e: FormEvent<HTMLFormElement>) {
    if (!db || !room || !user || !proofModalTask) return
    e.preventDefault()
    const text = String(new FormData(e.currentTarget).get('proofText') || '').trim()
    const file = proofFile
    if (!text && !file) { setNotice('Add a link, a note, or a photo.'); return }

    const existing = myProofs.find(p => p.task_id === proofModalTask.id)
    const proofId = existing?.id || crypto.randomUUID()
    let kind: 'image' | 'link' | 'note'
    let link: string | null = null, note: string | null = null, filePath: string | null = null
    if (file) { kind = 'image'; filePath = `${proofId}/${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}` }
    else if (/^https?:\/\//.test(text)) { kind = 'link'; link = text }
    else { kind = 'note'; note = text }

    const payload = { kind, link, note, file_path: filePath, status: 'submitted' as const, reviewed_by: null, reviewed_at: null, rejection_reason: null }
    const { error } = existing
      ? await db.from('proofs').update(payload).eq('id', proofId)
      : await db.from('proofs').insert({ id: proofId, room_id: room.id, task_id: proofModalTask.id, user_id: user.id, task_date: cycleDate, ...payload })
    if (error) { setNotice(error.message); return }

    if (file) {
      const { error: upErr } = await db.storage.from('proof-images').upload(filePath!, file, { upsert: true })
      if (upErr) { setNotice(upErr.message); return }
    }
    setNotice('Proof sent.'); setProofModalTask(null); setProofFile(null); await loadDashboard(room)
  }

  async function approveProof(proof: Proof) {
    if (!db || !room) return
    const { error } = await db.rpc('review_proof', { proof_id: proof.id, decision: 'approved', reason: null })
    if (error) setNotice(error.message)
    else { setNotice('Proof confirmed.'); await loadDashboard(room) }
  }

  async function confirmReject(e: FormEvent<HTMLFormElement>) {
    if (!db || !room || !rejectingProof) return
    e.preventDefault()
    const reason = String(new FormData(e.currentTarget).get('reason') || '').trim() || null
    const { error } = await db.rpc('review_proof', { proof_id: rejectingProof.id, decision: 'rejected', reason })
    if (error) setNotice(error.message)
    else { setNotice('Proof rejected.'); setRejectingProof(null); await loadDashboard(room) }
  }

  async function sendMessage(e: FormEvent<HTMLFormElement>) {
    if (!db || !room || !user) return
    e.preventDefault()
    const body = chatText.trim()
    if (!body) return
    setChatText('')
    const { error } = await db.from('room_messages').insert({ room_id: room.id, user_id: user.id, body })
    if (error) setNotice(error.message)
  }

  function nameFor(userId: string) {
    return members.find(m => m.user_id === userId)?.profiles?.display_name || 'Member'
  }

  if (!db) return <main className="welcome"><div><p className="eyebrow">DO IT TOGETHER</p><h1>Almost<br/><i>ready.</i></h1><p>Add the Supabase public URL and publishable key in <code>.env.local</code> to start your private room.</p></div></main>

  if (mode === 'auth') return <main className="welcome"><div><p className="eyebrow">DO IT TOGETHER</p><h1>Show up.<br/><i>Together.</i></h1><p>Build your own social rhythm, then invite a friend whenever you want accountability.</p></div><form className="card" onSubmit={auth}><h2>{authView === 'signup' ? 'Create your profile' : 'Welcome back'}</h2>{authView === 'signup' && <input required name="name" placeholder="Your name" />}<input required name="email" type="email" placeholder="Email" /><input required name="password" type="password" placeholder="Password" minLength={6} /><button>{authView === 'signup' ? 'Create profile →' : 'Sign in →'}</button><button className="link" type="button" onClick={() => { setAuthView(authView === 'signup' ? 'signin' : 'signup'); setNotice('') }}>{authView === 'signup' ? 'I already have an account' : 'Create a new account'}</button>{notice && <small>{notice}</small>}</form></main>

  if (mode === 'platforms') return <main className="welcome"><div><p className="eyebrow">PICK YOUR PLATFORMS</p><h1>Where do you<br/><i>want to grow?</i></h1><p>Pick at least 3. Every posting day we'll randomly choose 3 of these for you, worth 50 points split unevenly — keeps it interesting.</p></div><form className="card setup" onSubmit={savePlatforms}><div className="chipGrid">{PLATFORM_OPTIONS.map(p => <button type="button" key={p} className={selectedPlatforms.includes(p) ? 'picked' : ''} onClick={() => togglePlatform(p)}>{p}</button>)}</div><button disabled={selectedPlatforms.length < 3}>Continue → ({selectedPlatforms.length}/3)</button>{notice && <small>{notice}</small>}</form></main>

  if (mode === 'profile') return <main className="welcome"><form className="card setup"><p className="eyebrow">{cameFromRoom ? 'ADD A ROOM' : 'YOUR PROFILE IS READY'}</p><h1>How do you want<br/><i>to show up?</i></h1><p>Start alone now, create a shared room for a friend, or join a friend who has already created one.</p><div className="picks"><button type="button" onClick={() => setMode('setup')}><b>Use it solo</b><span>Your own daily posting goals</span></button><button type="button" onClick={() => setMode('setup')}><b>Create a room with a friend</b><span>Make an invite code after setup</span></button><button type="button" onClick={() => setMode('join')}><b>Join a friend</b><span>Enter their room code</span></button></div>{cameFromRoom && <button className="link" type="button" onClick={() => setMode('room')}>Back to dashboard</button>}</form></main>

  if (mode === 'join') return <main className="welcome"><form className="card setup" onSubmit={joinRoom}><p className="eyebrow">JOIN A ROOM</p><h1>Bring your<br/><i>friend's code.</i></h1><input required name="code" placeholder="Invite code" /><label>Your rest days (pick up to 2)</label><WeekdayPicker selected={joinRestDays} onToggle={toggleJoinRestDay} /><button>Join room →</button><button className="link" type="button" onClick={() => setMode(myRooms.length ? 'room' : 'profile')}>Back</button>{notice && <small>{notice}</small>}</form></main>

  if (mode === 'setup') return <main className="welcome"><form className="card setup" onSubmit={createRoom}><p className="eyebrow">CREATE A ROOM</p><h1>Choose your<br/><i>daily rhythm.</i></h1><input required name="room" placeholder="Room name — e.g. The Posting Pact" /><label>When does your day reset?</label><select name="boundary" defaultValue="00:00">{BOUNDARY_PRESETS.map(b => <option key={b.v} value={b.v}>{b.l}</option>)}</select><label>Your rest days (pick up to 2)</label><WeekdayPicker selected={setupRestDays} onToggle={toggleSetupRestDay} /><button>Create room →</button><button className="link" type="button" onClick={() => setMode(myRooms.length ? 'room' : 'profile')}>Back</button>{notice && <small>{notice}</small>}</form></main>

  const myId = user?.id
  const myProofs = proofs.filter(p => p.user_id === myId)
  const pendingReview = proofs.filter(p => p.user_id !== myId && p.status === 'submitted')
  const confirmed = proofs.filter(p => p.status === 'approved').reduce((n, p) => n + (p.daily_tasks?.points || 0), 0)
  const target = 50 * Math.max(members.length, 1)
  const seconds = room ? Math.max(0, Math.floor((nextBoundary(room.day_boundary_time).getTime() - Date.now()) / 1000)) : 0
  const time = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const myWeekState = weekStates.find(w => w.user_id === myId)
  const needsWeekPick = myWeekState?.rest_days == null
  const partnerIds = Array.from(new Set(partnerTasks.map(t => t.user_id)))

  return (
    <main className="dashboard">
      <header>
        <b>↗ <span>do it<br/>together</span></b>
        <div className="roomSwitcher">
          {myRooms.map(r => (
            <button key={r.id} className={r.id === room?.id ? 'active' : ''} onClick={() => switchRoom(r)}>{r.name}</button>
          ))}
          <button className="addRoom" onClick={() => { setCameFromRoom(true); setMode('profile') }} title="Add another room">+</button>
        </div>
        <button className="link" onClick={() => db.auth.signOut()}>Sign out</button>
      </header>

      {needsWeekPick && (
        <section className="progress restBanner">
          <b>Pick your rest days for this week</b>
          <span>Choose up to 2 — until you pick, no day is excused this week.</span>
          <WeekdayPicker selected={weekPickerDays} onToggle={toggleWeekPickerDay} />
          <div className="inlineActions">
            <button onClick={() => saveWeekRestDays(false)}>Save rest days</button>
            <button className="link" type="button" onClick={() => saveWeekRestDays(true)}>No rest days this week</button>
          </div>
        </section>
      )}

      {isRestDay && (
        <section className="progress restBanner">
          <b>🌿 Today's your rest day</b>
          <span>No tasks assigned for you today. {typeof myWeekState?.rest_credits_remaining === 'number' ? `${myWeekState.rest_credits_remaining} rest credit${myWeekState.rest_credits_remaining === 1 ? '' : 's'} left this week.` : ''}</span>
        </section>
      )}

      <section className="hero">
        <div>
          <p className="eyebrow">TODAY'S COMBINED TARGET</p>
          <h1>{target} points<br/><i>{gradeLabel(confirmed).toLowerCase()}.</i></h1>
          <p>The room needs at least 50 combined before the cycle resets, or today's points are at risk — and whoever didn't post loses a rest day.</p>
        </div>
        <div className="count">
          <small>TIME LEFT</small>
          <strong>{time}</strong>
          <span>Resets at {room ? formatBoundary(room.day_boundary_time) : ''} ({room?.timezone}).</span>
          {isOwner && <button className="tinyLink" type="button" onClick={() => setShowSettings(s => !s)}>Adjust clock</button>}
        </div>
      </section>

      {showSettings && room && (
        <form className="card settingsInline" onSubmit={saveRoomSettings}>
          <label>When does your day reset?</label>
          <select name="boundary" defaultValue={room.day_boundary_time.slice(0, 5)}>{BOUNDARY_PRESETS.map(b => <option key={b.v} value={b.v}>{b.l}</option>)}</select>
          <button>Save</button>
          <button className="link" type="button" onClick={() => setShowSettings(false)}>Cancel</button>
        </form>
      )}

      <section className="progress">
        <b>{confirmed}/{target} confirmed points · {gradeLabel(confirmed)}</b>
        <span>{confirmed >= 50 ? 'Floor cleared — keep going for a better grade.' : 'No points count until your partner approves proof.'}</span>
      </section>

      {pendingReview.length > 0 && (
        <section className="reviewSection">
          <h2>Confirm your partner's proof</h2>
          {pendingReview.map(p => (
            <div className="reviewCard" key={p.id}>
              <div>
                <b>{p.profiles?.display_name || 'Your partner'} · {p.daily_tasks?.platform}</b>
                <small>
                  {p.kind === 'image' ? (signedUrls[p.id] ? <a href={signedUrls[p.id]} target="_blank" rel="noreferrer">View photo →</a> : 'Loading photo…')
                    : p.kind === 'link' ? p.link : p.note} · {p.daily_tasks?.points} points
                </small>
              </div>
              {rejectingProof?.id === p.id ? (
                <form className="rejectForm" onSubmit={confirmReject}>
                  <input name="reason" placeholder="Why? (optional)" autoFocus />
                  <button>Confirm reject</button>
                  <button className="link" type="button" onClick={() => setRejectingProof(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <button onClick={() => approveProof(p)}>Confirm</button>
                  <button className="reject" onClick={() => setRejectingProof(p)}>Reject</button>
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {!isRestDay && (
        <section>
          <p className="eyebrow">YOUR DAILY REPS</p>
          <h2>What are you showing up for?</h2>
          {tasks.map(task => {
            const proof = myProofs.find(p => p.task_id === task.id)
            return (
              <article className="task" key={task.id}>
                <div><b>{task.platform}</b><small>Post on {task.platform} today</small><em>{task.points} points</em></div>
                {proof
                  ? <span className={`proof ${proof.status}`}>{proof.status === 'approved' ? 'Confirmed ✓' : proof.status === 'rejected' ? 'Rejected — resubmit' : 'Waiting for partner'}</span>
                  : <button onClick={() => setProofModalTask(task)}>Submit proof →</button>}
              </article>
            )
          })}
        </section>
      )}

      {members.length > 1 && (
        <section>
          <p className="eyebrow">MONITORING</p>
          <h2>Your partner's reps today</h2>
          {partnerIds.length === 0 && <p className="dim">Your partner hasn't checked in yet today.</p>}
          {partnerIds.map(pid => (
            <div key={pid}>
              {partnerTasks.filter(t => t.user_id === pid).map(task => {
                const proof = proofs.find(p => p.task_id === task.id)
                return (
                  <article className="task" key={task.id}>
                    <div><b>{nameFor(pid)} · {task.platform}</b><small>{proof ? (proof.kind === 'image' ? 'Photo submitted' : proof.kind === 'link' ? proof.link : proof.note) : 'Not submitted yet'}</small><em>{task.points} points</em></div>
                    {proof ? <span className={`proof ${proof.status}`}>{proof.status === 'approved' ? 'Confirmed ✓' : proof.status === 'rejected' ? 'Rejected' : 'Awaiting your review'}</span> : <span className="proof">Waiting</span>}
                  </article>
                )
              })}
            </div>
          ))}
        </section>
      )}

      {dayStates.length > 0 && (
        <section className="weekSection">
          <p className="eyebrow">THIS WEEK</p>
          <h2>How the room's doing</h2>
          <div className="weekGrid">
            {dayStates.map(d => (
              <div key={d.cycle_date} className="weekDay">
                <small>{formatShortDate(d.cycle_date)}</small>
                <b>{d.combined_points}</b>
                <span>{d.grade}</span>
              </div>
            ))}
          </div>
          <div className="restCredits">
            {members.map(m => {
              const w = weekStates.find(ws => ws.user_id === m.user_id)
              return <span key={m.user_id}>{m.profiles?.display_name || 'Member'}: {typeof w?.rest_credits_remaining === 'number' ? w.rest_credits_remaining : 2} rest credit(s) left</span>
            })}
          </div>
        </section>
      )}

      {members.length > 1 && (
        <section className="chatSection">
          <p className="eyebrow">ROOM CHAT</p>
          <h2>Check in with your partner</h2>
          <div className="chatLog">
            {messages.length === 0 && <p className="dim">No messages yet — say hi.</p>}
            {messages.map(m => (
              <div key={m.id} className={`chatBubble ${m.user_id === myId ? 'mine' : ''}`}>
                <small>{nameFor(m.user_id)} · {formatTime(m.created_at)}</small>
                <p>{m.body}</p>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form className="chatForm" onSubmit={sendMessage}>
            <input value={chatText} onChange={e => setChatText(e.target.value)} placeholder="Message your partner…" maxLength={500} />
            <button>Send</button>
          </form>
        </section>
      )}

      {isOwner && (
        <section className="invitePanel">
          <small>INVITE A PARTNER</small>
          {inviteCode ? (
            <>
              <strong>{inviteCode}</strong>
              <p>Share this code — they create their own profile, pick their platforms, then choose "Join a friend."</p>
            </>
          ) : (
            <>
              <p>No active invite code yet.</p>
              <button onClick={generateInvite}>Generate invite code →</button>
            </>
          )}
        </section>
      )}

      {proofModalTask && (
        <div className="modalOverlay" onClick={() => { setProofModalTask(null); setProofFile(null) }}>
          <form className="card modalCard" onClick={e => e.stopPropagation()} onSubmit={submitProofModal}>
            <h2>Proof for {proofModalTask.platform}</h2>
            <input name="proofText" placeholder="Paste a link or write a quick note" />
            <label className="fileLabel">
              {proofFile ? proofFile.name : 'Or attach a photo →'}
              <input type="file" accept="image/*" onChange={e => setProofFile(e.target.files?.[0] || null)} hidden />
            </label>
            <button>Submit proof →</button>
            <button className="link" type="button" onClick={() => { setProofModalTask(null); setProofFile(null) }}>Cancel</button>
          </form>
        </div>
      )}

      {notice && <div className="toast">{notice}</div>}
    </main>
  )
}

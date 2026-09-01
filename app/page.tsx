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
  created_at?: string
  profiles: { display_name: string } | null
  daily_tasks: { platform: string; points: number } | null
}
type DayState = { cycle_date: string; combined_points: number; grade: string }
type WeekState = { user_id: string; rest_credits_remaining: number; rest_days: number[] | null }
type ChatMessage = { id: string; user_id: string; body: string; created_at: string }
type HistTask = { id: string; user_id: string; cycle_date: string; platform: string }
type Mode = 'loading' | 'auth' | 'platforms' | 'profile' | 'setup' | 'join' | 'room'
type DashTab = 'today' | 'calendar' | 'feed' | 'chat' | 'progress'

const PLATFORM_OPTIONS = ['Instagram', 'TikTok', 'YouTube', 'X (Twitter)', 'LinkedIn', 'Threads', 'Facebook', 'Pinterest', 'Snapchat', 'Other']
const WEEKDAYS = [{ v: 0, l: 'Sun' }, { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' }]
const BOUNDARY_PRESETS = [{ v: '00:00', l: 'Midnight → Midnight' }, { v: '06:00', l: '6am → 6am' }, { v: '12:00', l: 'Noon → Noon' }, { v: '18:00', l: '6pm → 6pm' }]
const AVATAR_COLORS = ['#e2a23f', '#e28aa5', '#8f7fd6', '#6fb98f', '#e2946b', '#7fa8d6']
const TIMEZONE_OPTIONS: string[] = (() => {
  try { return (Intl as any).supportedValuesOf('timeZone') }
  catch { return ['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Lagos', 'Africa/Nairobi', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'] }
})()
const ACTIVE_ROOM_KEY = 'dit_active_room'
const HISTORY_DAYS = 35
const REMINDER_THRESHOLDS = [7200, 3600, 900]
const NAV_TABS: { id: DashTab; icon: string; label: string }[] = [
  { id: 'today', icon: '◉', label: 'Today' },
  { id: 'calendar', icon: '▦', label: 'Calendar' },
  { id: 'feed', icon: '◌', label: 'Feed' },
  { id: 'chat', icon: '◐', label: 'Chat' },
  { id: 'progress', icon: '↗', label: 'Progress' },
]

function gradeLabel(points: number) {
  if (points >= 100) return 'Lovely'
  if (points >= 90) return 'Almost'
  if (points >= 80) return 'Great'
  if (points >= 70) return 'Okay'
  if (points >= 50) return 'Mid'
  return 'Missed'
}
// Both of these do their arithmetic entirely in UTC-space (Date.UTC / getUTCDay / setUTCDate)
// rather than mixing local-timezone parsing with a final toISOString(). Building a Date from a
// local midnight and then calling toISOString() re-expresses it in UTC, which silently shifts
// the calendar date backward by a day for anyone in a timezone ahead of UTC — that's what made
// mondayOf() compute a week_start one day earlier than the one set_week_rest_days() actually
// wrote server-side, so the client could never find its own saved rest-day row again.
function mondayOf(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}
function daysAgoDate(n: number) {
  const now = new Date()
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  d.setUTCDate(d.getUTCDate() - n)
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
function formatFullDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()
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
// Matches "example.com", "www.example.com/path", "http(s)://example.com" — not just fully
// qualified URLs, since most people paste a bare domain without typing the protocol.
const URL_LIKE = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i
function normalizeLink(text: string) {
  return /^https?:\/\//i.test(text) ? text : `https://${text}`
}
function avatarColor(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
// A day counts toward a streak if every real (non-rest) task that day was approved, or if it
// was an excused rest day. Walking the sorted date list once gives the best-ever run; walking
// backward from the most recent date gives the current run.
function computeStreaks(histTasks: HistTask[], approvedIds: Set<string>, memberIds: string[]) {
  const byUserDate: Record<string, Record<string, HistTask[]>> = {}
  for (const t of histTasks) {
    (byUserDate[t.user_id] ??= {})[t.cycle_date] ??= []
    byUserDate[t.user_id][t.cycle_date].push(t)
  }
  const dayDone = (dayTasks: HistTask[]) => dayTasks.some(t => t.platform === '__rest__') || dayTasks.every(t => approvedIds.has(t.id))
  const result: Record<string, { current: number; best: number }> = {}
  for (const uid of memberIds) {
    const dates = Object.keys(byUserDate[uid] || {}).sort()
    let best = 0, run = 0, current = 0
    for (const d of dates) { if (dayDone(byUserDate[uid][d])) { run++; if (run > best) best = run } else run = 0 }
    for (let i = dates.length - 1; i >= 0; i--) { if (dayDone(byUserDate[uid][dates[i]])) current++; else break }
    result[uid] = { current, best }
  }
  return result
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
  const [feedProofs, setFeedProofs] = useState<Proof[]>([])
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [dayStates, setDayStates] = useState<DayState[]>([])
  const [weekStates, setWeekStates] = useState<WeekState[]>([])
  const [histTasks, setHistTasks] = useState<HistTask[]>([])
  const [approvedTaskIds, setApprovedTaskIds] = useState<Set<string>>(new Set())
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [cycleDate, setCycleDate] = useState('')
  const [isRestDay, setIsRestDay] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<Mode>('loading')
  const [dashTab, setDashTab] = useState<DashTab>('today')
  const [cameFromRoom, setCameFromRoom] = useState(false)
  const [authView, setAuthView] = useState<'signup' | 'signin' | 'forgot' | 'reset'>('signup')
  const [authBusy, setAuthBusy] = useState(false)
  const [proofSubmitting, setProofSubmitting] = useState(false)
  const [isOffline, setIsOffline] = useState(false)
  const recoveryFlowRef = useRef(false)
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [setupRestDays, setSetupRestDays] = useState<number[]>([])
  const [joinRestDays, setJoinRestDays] = useState<number[]>([])
  const [weekPickerDays, setWeekPickerDays] = useState<number[]>([])
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [myPlatforms, setMyPlatforms] = useState<string[]>([])
  const [editPlatforms, setEditPlatforms] = useState<string[]>([])
  const [proofModalTask, setProofModalTask] = useState<DailyTask | null>(null)
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [rejectingProof, setRejectingProof] = useState<Proof | null>(null)
  const [notifPermission, setNotifPermission] = useState<'default' | 'granted' | 'denied' | 'unsupported'>('unsupported')
  const [installPrompt, setInstallPrompt] = useState<any>(null)
  const [isStandalone, setIsStandalone] = useState(false)
  const [tick, setTick] = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const notifiedRef = useRef<Record<string, boolean>>({})

  useEffect(() => {
    if (typeof Notification === 'undefined') return
    setNotifPermission(Notification.permission)
  }, [])

  useEffect(() => {
    if (typeof navigator === 'undefined') return
    setIsOffline(!navigator.onLine)
    const goOnline = () => setIsOffline(false)
    const goOffline = () => setIsOffline(true)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline) }
  }, [])

  // Chrome/Android fires this instead of doing anything on its own; we stash it so an explicit
  // "Download app" button can trigger the native install prompt on demand. Safari (iOS/macOS)
  // never fires it — those users get a manual "Add to Home Screen" hint instead (see isIOS below).
  useEffect(() => {
    const onPrompt = (e: any) => { e.preventDefault(); setInstallPrompt(e) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone === true)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  // Chrome/Android won't fire beforeinstallprompt at all without an active service worker —
  // that was the actual reason "Download app" did nothing on Android before this. The worker
  // itself does no caching, it just needs to exist and be active.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* older/unsupported browser — fine to skip */ })
    }
  }, [])

  // Toasts never had a way to clear themselves — an error or "Proof sent." would sit there until
  // something else happened to overwrite it, which looked like the page had frozen.
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(id)
  }, [notice])

  useEffect(() => {
    if (!db) return
    // A rejected getUser()/checkUserState() call here (a network hiccup, a dropped connection)
    // used to leave `mode` stuck at 'loading' forever with no error and no way out except a
    // hard refresh — this is the splash screen that never goes away. bootAuth retries once
    // before falling back to the sign-in screen, since on a poor connection a lot of these are
    // transient blips rather than a real problem.
    async function bootAuth(retrying = false): Promise<void> {
      if (!db) return
      try {
        const { data } = await db.auth.getUser()
        setUser(data.user)
        if (recoveryFlowRef.current) return
        if (data.user) await checkUserState()
        else setMode('auth')
      } catch {
        if (recoveryFlowRef.current) return
        if (!retrying) { await new Promise(r => setTimeout(r, 1500)); return bootAuth(true) }
        setMode('auth')
      }
    }
    bootAuth()
    const { data: { subscription } } = db.auth.onAuthStateChange((_e, s) => {
      setUser(s?.user ?? null)
      // A password-recovery link lands here with a real (temporary) session already
      // established, but we want the "set a new password" form first, not the dashboard — and
      // that has to stick even though the bootAuth() call above may still independently resolve
      // and see the same signed-in user.
      if (_e === 'PASSWORD_RECOVERY') { recoveryFlowRef.current = true; setMode('auth'); setAuthView('reset'); return }
      if (recoveryFlowRef.current) return
      if (s?.user) checkUserState()
      else { setRoom(null); setMyRooms([]); setMode('auth') }
    })
    return () => subscription.unsubscribe()
  }, [db])

  // Belt-and-suspenders on top of the catch above: whatever the cause, never leave the app
  // stuck showing only the splash for more than a few seconds.
  useEffect(() => {
    if (mode !== 'loading') return
    const t = setTimeout(() => setMode(m => (m === 'loading' ? 'auth' : m)), 6000)
    return () => clearTimeout(t)
  }, [mode])

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Reminders fire while this tab (or installed app) is open, at most once per threshold per
  // cycle_date. True background push (notifications even when the app is fully closed) needs a
  // service worker + a push-subscription store + something to trigger sends on a schedule —
  // real new infrastructure this doesn't attempt yet.
  useEffect(() => {
    if (notifPermission !== 'granted' || !room || !cycleDate) return
    const secs = Math.max(0, Math.floor((nextBoundary(room.day_boundary_time).getTime() - Date.now()) / 1000))
    const myId = user?.id
    const incomplete = tasks.some(t => !proofs.find(p => p.task_id === t.id && p.user_id === myId && p.status !== 'rejected'))
    if (!incomplete) return
    for (const th of REMINDER_THRESHOLDS) {
      const key = `${room.id}-${cycleDate}-${th}`
      if (secs <= th && !notifiedRef.current[key]) {
        notifiedRef.current[key] = true
        try { new Notification('Do It Together', { body: `${Math.round(th / 60)} minutes left to post today.`, icon: '/icon.svg' }) } catch { /* unsupported in this context */ }
      }
    }
  }, [tick, notifPermission, room, cycleDate, tasks, proofs, user])

  useEffect(() => {
    if (!db || !room) return
    const channel = db.channel(`room-messages-${room.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` }, (payload: any) => {
        setMessages(prev => (prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new as ChatMessage]))
      })
      .subscribe()
    return () => { db.removeChannel(channel) }
  }, [db, room?.id])

  // Any proof change in the room (new submission, a review, a resubmit) reloads the dashboard,
  // so a partner sees a fresh photo/link/note — and its review status — without a manual refresh.
  useEffect(() => {
    if (!db || !room) return
    const roomForReload = room
    const channel = db.channel(`room-proofs-${room.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'proofs', filter: `room_id=eq.${room.id}` }, () => {
        loadDashboard(roomForReload)
      })
      .subscribe()
    return () => { db.removeChannel(channel) }
  }, [db, room?.id])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'nearest' }) }, [messages.length])

  async function checkUserState() {
    if (!db) return
    try {
      const { data: platRows } = await db.from('profile_platforms').select('platform')
      if (!platRows || platRows.length < 3) { setMode('platforms'); return }
      // A flaky connection can make this getUser() call resolve with no user (rather than
      // throwing) instead of erroring outright. Left unchecked, myId silently became the string
      // "undefined" in the next query below (?user_id=eq.undefined, a 400 that supabase-js
      // returns as {data: null, error} rather than throwing) — which read as "you have zero
      // rooms" and sent someone who's actually a member of a room back through onboarding.
      const { data: authUser, error: userErr } = await db.auth.getUser()
      if (userErr || !authUser.user) throw userErr || new Error('Lost your session — please sign in again.')
      const myId = authUser.user.id
      // Without filtering to my own membership rows, a shared room would come back once per
      // member (RLS on room_members exposes every row in any room I belong to, not just mine).
      const { data: memberships } = await db.from('room_members').select('room_id,rooms(id,name,timezone,day_boundary_time)').eq('user_id', myId)
      const rooms: RoomSummary[] = ((memberships as any) || []).map((m: any) => m.rooms).filter(Boolean)
      setMyRooms(rooms)
      if (!rooms.length) { setMode('profile'); return }
      const stored = readStoredRoomId()
      const active = rooms.find(r => r.id === stored) || rooms[0]
      await loadDashboard(active)
    } catch (err: any) {
      // A network hiccup here used to leave the splash screen up forever (mode never left
      // 'loading') with no way to recover short of a hard refresh.
      setNotice(err?.message || 'Could not load your account — check your connection and try again.')
      setMode('auth')
    }
  }

  async function switchRoom(r: RoomSummary) {
    storeRoomId(r.id)
    setDashTab('today')
    await loadDashboard(r)
  }

  async function loadDashboard(roomRow: RoomSummary) {
    if (!db) return
    setRoom(roomRow)
    storeRoomId(roomRow.id)
    setShowProfileMenu(false)
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
    const since = daysAgoDate(HISTORY_DAYS - 1)
    const [
      { data: allTasks }, { data: proofRows }, { data: dayRows }, { data: weekRows }, { data: chatRows },
      { data: histTaskRows }, { data: approvedRows }, { data: feedRows }, { data: platRows }, inviteResult,
    ] = await Promise.all([
      db.from('daily_tasks').select('id,user_id,platform,points').eq('room_id', roomRow.id).eq('cycle_date', cdate).neq('platform', '__rest__'),
      // profiles!user_id disambiguates the embed: proofs has two FKs into profiles (user_id
      // and reviewed_by), so a bare "profiles(display_name)" is an ambiguous embed that
      // PostgREST rejects with HTTP 300 — which supabase-js surfaces as {data: null, error},
      // silently emptying this list and reverting a just-submitted proof back to "Submit proof".
      db.from('proofs').select('id,task_id,user_id,status,kind,note,link,file_path,profiles!user_id(display_name),daily_tasks(platform,points)').eq('room_id', roomRow.id).eq('task_date', cdate),
      db.from('room_day_state').select('cycle_date,combined_points,grade').eq('room_id', roomRow.id).order('cycle_date', { ascending: false }).limit(HISTORY_DAYS),
      db.from('member_week_state').select('user_id,rest_credits_remaining,rest_days').eq('room_id', roomRow.id).eq('week_start', weekStart),
      db.from('room_messages').select('id,user_id,body,created_at').eq('room_id', roomRow.id).order('created_at', { ascending: true }).limit(100),
      db.from('daily_tasks').select('id,user_id,cycle_date,platform').eq('room_id', roomRow.id).gte('cycle_date', since),
      db.from('proofs').select('task_id').eq('room_id', roomRow.id).eq('status', 'approved').gte('task_date', since),
      db.from('proofs').select('id,task_id,user_id,status,kind,note,link,file_path,created_at,profiles!user_id(display_name),daily_tasks(platform,points)').eq('room_id', roomRow.id).order('created_at', { ascending: false }).limit(30),
      db.from('profile_platforms').select('platform').eq('user_id', myId),
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
    setHistTasks((histTaskRows as any) || [])
    setApprovedTaskIds(new Set(((approvedRows as any) || []).map((r: any) => r.task_id)))
    const feedList: Proof[] = (feedRows as any) || []
    setFeedProofs(feedList)
    setMyPlatforms(((platRows as any) || []).map((r: any) => r.platform))
    setInviteCode(inviteResult.data && inviteResult.data.uses < inviteResult.data.max_uses ? inviteResult.data.code : '')

    const myWeek = weekList.find(w => w.user_id === myId)
    setWeekPickerDays(myWeek?.rest_days || me?.rest_days || [])

    ensureSignedUrls([...proofList, ...feedList])
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

  async function enableReminders() {
    if (typeof Notification === 'undefined') { setNotice('Notifications are not supported on this device or browser.'); return }
    const perm = await Notification.requestPermission()
    setNotifPermission(perm)
    setNotice(perm === 'granted' ? 'Reminders on — we\'ll nudge you as the clock runs down.' : 'Notifications permission was not granted.')
  }

  async function installApp() {
    if (!installPrompt) return
    installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  async function auth(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email')), password = String(form.get('password')), name = String(form.get('name'))
    setAuthBusy(true)
    try {
      const result = authView === 'signup'
        ? await db.auth.signUp({ email, password, options: { data: { display_name: name } } })
        : await db.auth.signInWithPassword({ email, password })
      if (result.error) setNotice(result.error.message)
      else setNotice(authView === 'signup' ? 'Account created. Check your email if confirmation is turned on.' : 'Welcome back.')
    } catch (err: any) {
      setNotice(err?.message || 'Could not reach the server — check your connection and try again.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function forgotPassword(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const email = String(new FormData(e.currentTarget).get('email') || '').trim()
    setAuthBusy(true)
    try {
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
      setNotice(error ? error.message : "If that email has an account, we've sent a password reset link.")
    } catch (err: any) {
      setNotice(err?.message || 'Could not reach the server — check your connection and try again.')
    } finally {
      setAuthBusy(false)
    }
  }

  async function resetPassword(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const password = String(form.get('password') || '')
    const confirmPassword = String(form.get('confirmPassword') || '')
    if (password.length < 6) { setNotice('Password must be at least 6 characters.'); return }
    if (password !== confirmPassword) { setNotice("Passwords don't match."); return }
    setAuthBusy(true)
    try {
      const { error } = await db.auth.updateUser({ password })
      if (error) { setNotice(error.message); return }
      recoveryFlowRef.current = false
      setNotice('Password updated.')
      setAuthView('signin')
      await checkUserState()
    } catch (err: any) {
      setNotice(err?.message || 'Could not reach the server — check your connection and try again.')
    } finally {
      setAuthBusy(false)
    }
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
    const form = new FormData(e.currentTarget)
    const name = String(form.get('roomName') || '').trim()
    const boundary = String(form.get('boundary'))
    const timezone = String(form.get('timezone'))
    if (!name) { setNotice("Room name can't be empty."); return }
    const { error } = await db.from('rooms').update({ name, day_boundary_time: boundary, timezone }).eq('id', room.id)
    if (error) setNotice(error.message)
    // checkUserState (not just loadDashboard) so the sidebar's room switcher picks up a renamed
    // room too, not just the dashboard currently open on it.
    else { setNotice('Room settings updated.'); setShowProfileMenu(false); await checkUserState() }
  }

  async function leaveRoom() {
    if (!db || !room) return
    if (!window.confirm(`Leave "${room.name}"? You'll lose access to its history unless you're invited back.`)) return
    const { error } = await db.rpc('leave_room', { target_room: room.id })
    if (error) { setNotice(error.message); return }
    setNotice('Left the room.')
    setShowProfileMenu(false)
    await checkUserState()
  }

  async function deleteRoomFn() {
    if (!db || !room) return
    if (!window.confirm(`Delete "${room.name}" for everyone? This cannot be undone.`)) return
    const { error } = await db.rpc('delete_room', { target_room: room.id })
    if (error) { setNotice(error.message); return }
    setNotice('Room deleted.')
    setShowProfileMenu(false)
    await checkUserState()
  }

  async function saveDisplayName(e: FormEvent<HTMLFormElement>) {
    if (!db || !user) return
    e.preventDefault()
    const name = String(new FormData(e.currentTarget).get('displayName') || '').trim()
    if (!name) { setNotice("Name can't be empty."); return }
    const { error } = await db.from('profiles').update({ display_name: name }).eq('id', user.id)
    if (error) { setNotice(error.message); return }
    setNotice('Name updated.')
    if (room) await loadDashboard(room)
  }

  function toggleEditPlatform(p: string) {
    setEditPlatforms(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  async function savePlatformsEdit() {
    if (!db) return
    if (editPlatforms.length < 3) { setNotice('Pick at least 3 platforms.'); return }
    const { error } = await db.rpc('set_profile_platforms', { platforms: editPlatforms })
    if (error) { setNotice(error.message); return }
    setMyPlatforms(editPlatforms)
    setNotice("Platforms updated — this changes what future days draw from, not today's already-assigned tasks.")
  }

  async function submitProofModal(e: FormEvent<HTMLFormElement>) {
    if (!db || !room || !user || !proofModalTask) return
    e.preventDefault()
    const text = String(new FormData(e.currentTarget).get('proofText') || '').trim()
    const file = proofFile
    if (!text && !file) { setNotice('Add a link, a note, or a photo.'); return }

    const task = proofModalTask
    let kind: 'image' | 'link' | 'note'
    let link: string | null = null, note: string | null = null, filePath: string | null = null
    if (file) { kind = 'image'; filePath = `${user.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}` }
    else if (URL_LIKE.test(text)) { kind = 'link'; link = normalizeLink(text) }
    else { kind = 'note'; note = text }

    setProofSubmitting(true)
    try {
      // Upload first — the file is in storage before anything else can reference it, so a
      // partner's realtime reload never asks for a signed URL that isn't ready yet.
      if (file) {
        const { error: upErr } = await db.storage.from('proof-images').upload(filePath!, file)
        if (upErr) { setNotice(upErr.message); return }
      }

      // Upsert on task_id (its unique key) rather than branching on whatever proof the local
      // state happens to already know about — a stale/incomplete local list otherwise tries an
      // INSERT against a task_id that already has a row and crashes on a duplicate-key error.
      const { data, error } = await db.from('proofs')
        .upsert(
          { room_id: room.id, task_id: task.id, user_id: user.id, task_date: cycleDate, kind, link, note, file_path: filePath, status: 'submitted', reviewed_by: null, reviewed_at: null, rejection_reason: null },
          { onConflict: 'task_id' },
        )
        .select('id')
        .single()
      if (error) {
        if (filePath) await db.storage.from('proof-images').remove([filePath])
        setNotice(error.message)
        return
      }

      // Update local state immediately rather than waiting on a reload — the task flips to
      // "Waiting for partner" right away instead of sitting on "Submit proof" until whatever
      // background reload happens to land.
      setProofs(prev => [
        ...prev.filter(p => p.id !== data.id),
        { id: data.id, task_id: task.id, user_id: user.id, status: 'submitted', kind, note, link, file_path: filePath,
          profiles: { display_name: myName }, daily_tasks: { platform: task.platform, points: task.points } },
      ])
      setNotice('Proof sent.')
      setProofModalTask(null)
      setProofFile(null)
      await loadDashboard(room)
    } catch (err: any) {
      setNotice(err?.message || 'Something went wrong sending that proof — try again.')
    } finally {
      setProofSubmitting(false)
    }
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

  function statusFor(uid: string) {
    if (uid === user?.id && isRestDay) return 'Resting today'
    const memberTasks = uid === user?.id ? tasks : partnerTasks.filter(t => t.user_id === uid)
    if (memberTasks.length === 0) return 'Not started'
    const done = memberTasks.filter(t => proofs.find(p => p.task_id === t.id)?.status === 'approved').length
    return done === memberTasks.length ? 'Done for today' : `${done} of ${memberTasks.length} done`
  }

  // Checked before the loading splash so a genuinely misconfigured build (no Supabase env vars)
  // shows this message instead of being masked forever behind the splash — the boot effect that
  // would otherwise move `mode` past 'loading' never runs at all when db is null.
  if (!db) return <main className="welcome"><div><p className="eyebrow">DO IT TOGETHER</p><h1>Almost<br/><i>ready.</i></h1><p>Add the Supabase public URL and publishable key in <code>.env.local</code> to start your private room.</p></div></main>

  if (mode === 'loading') return <main className="splash"><b className="brand">↗ <span>do it<br />together</span></b><span className="splashPulse" /></main>

  if (mode === 'auth') return (
    <main className="welcome">
      <div><p className="eyebrow">DO IT TOGETHER</p><h1>Show up.<br /><i>Together.</i></h1><p>Build your own social rhythm, then invite a friend whenever you want accountability.</p></div>
      {isOffline && <p className="offlineBanner">You're offline — reconnect to sign in.</p>}
      {authView === 'reset' ? (
        <form className="card" onSubmit={resetPassword}>
          <h2>Set a new password</h2>
          <input required name="password" type="password" placeholder="New password" minLength={6} />
          <input required name="confirmPassword" type="password" placeholder="Confirm new password" minLength={6} />
          <button disabled={authBusy}>{authBusy ? 'Saving…' : 'Set password →'}</button>
          {notice && <small>{notice}</small>}
        </form>
      ) : authView === 'forgot' ? (
        <form className="card" onSubmit={forgotPassword}>
          <h2>Reset your password</h2>
          <input required name="email" type="email" placeholder="Email" />
          <button disabled={authBusy}>{authBusy ? 'Sending…' : 'Send reset link →'}</button>
          <button className="link" type="button" onClick={() => { setAuthView('signin'); setNotice('') }}>Back to sign in</button>
          {notice && <small>{notice}</small>}
        </form>
      ) : (
        <form className="card" onSubmit={auth}>
          <h2>{authView === 'signup' ? 'Create your profile' : 'Welcome back'}</h2>
          {authView === 'signup' && <input required name="name" placeholder="Your name" />}
          <input required name="email" type="email" placeholder="Email" />
          <input required name="password" type="password" placeholder="Password" minLength={6} />
          <button disabled={authBusy}>{authBusy ? 'Please wait…' : (authView === 'signup' ? 'Create profile →' : 'Sign in →')}</button>
          {authView === 'signin' && <button className="link" type="button" onClick={() => { setAuthView('forgot'); setNotice('') }}>Forgot password?</button>}
          <button className="link" type="button" onClick={() => { setAuthView(authView === 'signup' ? 'signin' : 'signup'); setNotice('') }}>{authView === 'signup' ? 'I already have an account' : 'Create a new account'}</button>
          {notice && <small>{notice}</small>}
        </form>
      )}
    </main>
  )

  if (mode === 'platforms') return <main className="welcome"><div><p className="eyebrow">PICK YOUR PLATFORMS</p><h1>Where do you<br/><i>want to grow?</i></h1><p>Pick at least 3. Every posting day we'll randomly choose 3 of these for you, worth 50 points split unevenly — keeps it interesting.</p></div><form className="card setup" onSubmit={savePlatforms}><div className="chipGrid">{PLATFORM_OPTIONS.map(p => <button type="button" key={p} className={selectedPlatforms.includes(p) ? 'picked' : ''} onClick={() => togglePlatform(p)}>{p}</button>)}</div><button disabled={selectedPlatforms.length < 3}>Continue → ({selectedPlatforms.length}/3)</button>{notice && <small>{notice}</small>}</form></main>

  if (mode === 'profile') return <main className="welcome"><form className="card setup"><p className="eyebrow">{cameFromRoom ? 'ADD A ROOM' : 'YOUR PROFILE IS READY'}</p><h1>How do you want<br/><i>to show up?</i></h1><p>Start alone now, create a shared room for a friend, or join a friend who has already created one. Rooms are capped at 2 people.</p><div className="picks"><button type="button" onClick={() => setMode('setup')}><b>Use it solo</b><span>Your own daily posting goals</span></button><button type="button" onClick={() => setMode('setup')}><b>Create a room with a friend</b><span>Make an invite code after setup</span></button><button type="button" onClick={() => setMode('join')}><b>Join a friend</b><span>Enter their room code</span></button></div>{cameFromRoom && <button className="link" type="button" onClick={() => setMode('room')}>Back to dashboard</button>}{!cameFromRoom && <button className="link" type="button" onClick={() => checkUserState()}>Already in a room? Check again</button>}</form></main>

  if (mode === 'join') return <main className="welcome"><form className="card setup" onSubmit={joinRoom}><p className="eyebrow">JOIN A ROOM</p><h1>Bring your<br/><i>friend's code.</i></h1><input required name="code" placeholder="Invite code" /><label>Your rest days (pick up to 2)</label><WeekdayPicker selected={joinRestDays} onToggle={toggleJoinRestDay} /><button>Join room →</button><button className="link" type="button" onClick={() => setMode(myRooms.length ? 'room' : 'profile')}>Back</button>{notice && <small>{notice}</small>}</form></main>

  if (mode === 'setup') return <main className="welcome"><form className="card setup" onSubmit={createRoom}><p className="eyebrow">CREATE A ROOM</p><h1>Choose your<br/><i>daily rhythm.</i></h1><input required name="room" placeholder="Room name — e.g. The Posting Pact" /><label>When does your day reset?</label><select name="boundary" defaultValue="00:00">{BOUNDARY_PRESETS.map(b => <option key={b.v} value={b.v}>{b.l}</option>)}</select><label>Your rest days (pick up to 2)</label><WeekdayPicker selected={setupRestDays} onToggle={toggleSetupRestDay} /><button>Create room →</button><button className="link" type="button" onClick={() => setMode(myRooms.length ? 'room' : 'profile')}>Back</button>{notice && <small>{notice}</small>}</form></main>

  const myId = user?.id
  const myName = members.find(m => m.user_id === myId)?.profiles?.display_name || 'You'
  const myProofs = proofs.filter(p => p.user_id === myId)
  const pendingReview = proofs.filter(p => p.user_id !== myId && p.status === 'submitted')
  const confirmed = proofs.filter(p => p.status === 'approved').reduce((n, p) => n + (p.daily_tasks?.points || 0), 0)
  const target = 50 * Math.max(members.length, 1)
  const seconds = room ? Math.max(0, Math.floor((nextBoundary(room.day_boundary_time).getTime() - Date.now()) / 1000)) : 0
  const time = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const myWeekState = weekStates.find(w => w.user_id === myId)
  const needsWeekPick = myWeekState?.rest_days == null
  const myDone = tasks.filter(t => myProofs.find(p => p.task_id === t.id)?.status === 'approved').length
  const streaks = computeStreaks(histTasks, approvedTaskIds, members.map(m => m.user_id))
  const myStreak = streaks[myId || ''] || { current: 0, best: 0 }
  const last7 = dayStates.slice(-7)
  const calendarDays = Array.from({ length: HISTORY_DAYS }, (_, i) => daysAgoDate(HISTORY_DAYS - 1 - i))
  const todayReal = daysAgoDate(0)
  const roomFull = members.length >= 2
  const isIOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent)
  const isAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)

  return (
    <main className="dashboardV2">
      <aside className="sidebar">
        <div className="sidebarTop">
          <b className="brand">↗ <span>do it<br />together</span></b>
          <button className="link sidebarSignout" onClick={() => db.auth.signOut()}>Sign out</button>
        </div>
        <nav>
          {NAV_TABS.map(t => (
            <button key={t.id} className={dashTab === t.id ? 'active' : ''} onClick={() => setDashTab(t.id)}>
              <span className="navIcon">{t.icon}</span><span className="navLabel">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebarRooms">
          {myRooms.map(r => <button key={r.id} className={r.id === room?.id ? 'active' : ''} onClick={() => switchRoom(r)}>{r.name}</button>)}
          <button className="addRoom" onClick={() => { setCameFromRoom(true); setMode('profile') }}>+ Add room</button>
        </div>
      </aside>

      <section className="mainPane">
        {isOffline && <p className="offlineBanner">You're offline — changes won't save until you're back online.</p>}
        <div className="dateRow">
          <span className="dateLabel">{cycleDate ? formatFullDate(cycleDate) : ''}</span>
          <button className="avatarBtn" type="button" onClick={() => { setEditPlatforms(myPlatforms); setShowProfileMenu(true) }}>
            <span className="avatar" style={{ background: avatarColor(myId || '') }}>{myName[0]?.toUpperCase()}</span>
          </button>
        </div>

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

        {dashTab === 'today' && (
          <>
            <section className="hero heroV2">
              <p className="eyebrow">{room?.name}</p>
              <h1>Stay above<br /><i>50 points.</i></h1>
              <p>That's the floor the room needs combined for today to count safely. Push to {target} for a Lovely day.</p>
            </section>

            <section className="statRow">
              <div className="progressRing" style={{ ['--pct' as any]: tasks.length ? `${Math.round((myDone / tasks.length) * 100)}%` : '0%' }}>
                <span>{myDone}/{tasks.length}</span>
              </div>
              <div className="statText">
                <b>{tasks.length > 0 && myDone === tasks.length ? "All done. You're moving." : `${myDone} thing${myDone === 1 ? '' : 's'} done. You're moving.`}</b>
                <span>Complete today's social reps to keep your streak alive.</span>
              </div>
              <div className="streakBadge">
                <strong>{myStreak.current} day streak</strong>
                <small>Personal best: {myStreak.best}</small>
              </div>
            </section>

            <section className="countCard card">
              <small>TODAY CLOSES IN</small>
              <strong>{time}</strong>
              <span>Resets at {room ? formatBoundary(room.day_boundary_time) : ''} ({room?.timezone}). Submit your proof before then.</span>
              <div className="countCardActions">
                {notifPermission !== 'unsupported' && notifPermission !== 'granted' && <button className="tinyLink" type="button" onClick={enableReminders}>🔔 Get reminders</button>}
                {notifPermission === 'granted' && <span className="tinyLink" style={{ cursor: 'default' }}>🔔 Reminders on</span>}
              </div>
            </section>

            <section className="progress">
              <b>{confirmed}/{target} points · {gradeLabel(confirmed)}</b>
              <span>{confirmed >= 50 ? (target - confirmed > 0 ? `Safe for today — ${target - confirmed} more for a perfect day.` : 'Perfect day — Lovely!') : `${50 - confirmed} more combined to clear today's floor.`}</span>
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
                          : p.kind === 'link' ? <a href={p.link!} target="_blank" rel="noreferrer">{p.link}</a> : p.note} · {p.daily_tasks?.points} points
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
                <p className="eyebrow">YOUR SOCIAL REPS</p>
                <h2>Today's list</h2>
                {tasks.map(task => {
                  const proof = myProofs.find(p => p.task_id === task.id)
                  return (
                    <article className="task taskV2" key={task.id}>
                      <span className={`checkDot ${proof?.status === 'approved' ? 'done' : ''}`}>{proof?.status === 'approved' ? '✓' : ''}</span>
                      <div><b>{task.platform}</b><small>Post on {task.platform} today · {task.points} points</small></div>
                      {proof
                        ? <span className={`proof ${proof.status}`}>{proof.status === 'approved' ? 'Confirmed ✓' : proof.status === 'rejected' ? 'Rejected — resubmit' : 'Waiting for partner'}</span>
                        : <button onClick={() => setProofModalTask(task)}>Submit proof →</button>}
                    </article>
                  )
                })}
              </section>
            )}

            {isOwner && (
              <section className="invitePanel">
                <small>INVITE A PARTNER</small>
                {roomFull ? (
                  <p>Room full — 2 of 2 members. Do It Together rooms are pairs, one accountability partner at a time.</p>
                ) : inviteCode ? (
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
          </>
        )}

        {dashTab === 'calendar' && (
          <section>
            <div className="calendarIntro"><p className="eyebrow">CALENDAR</p><h2>Last 5 weeks</h2></div>
            <div className="calendarGrid">
              {calendarDays.map(d => {
                const state = dayStates.find(ds => ds.cycle_date === d)
                // The grid's own cells are built from real calendar dates (daysAgoDate), so the
                // "today" highlight has to match that — not the room's cycleDate, which can
                // legitimately lag behind the real date for most of the day depending on how
                // late the room's day-boundary is set (e.g. an 11:59pm boundary means cycleDate
                // stays "yesterday" until the last minute before midnight).
                const cls = d === todayReal ? 'pending' : (state ? (state.combined_points >= 50 ? 'done' : 'missed') : 'missed')
                return (
                  <div key={d} className={`calendarDay ${cls}`}>
                    <small>{new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</small>
                    <b>{new Date(d + 'T00:00:00').getDate()}</b>
                  </div>
                )
              })}
            </div>
            <div className="legend"><span><i className="done"></i>Done</span><span><i className="pending"></i>Today</span><span><i className="missed"></i>Missed</span></div>
          </section>
        )}

        {dashTab === 'feed' && (
          <section>
            <p className="eyebrow">FROM THE GROUP</p>
            <h2>Recent proof</h2>
            {feedProofs.length === 0 && <p className="dim">Nothing submitted yet.</p>}
            {feedProofs.map(p => (
              <article className="feedItem" key={p.id}>
                <span className="avatar" style={{ background: avatarColor(p.user_id) }}>{(p.profiles?.display_name || nameFor(p.user_id))[0]?.toUpperCase()}</span>
                <div>
                  <b>{p.profiles?.display_name || nameFor(p.user_id)} · {p.daily_tasks?.platform}</b>
                  <small>
                    {p.kind === 'image' ? (signedUrls[p.id] ? <a href={signedUrls[p.id]} target="_blank" rel="noreferrer">View photo →</a> : 'Loading photo…') : p.kind === 'link' ? <a href={p.link!} target="_blank" rel="noreferrer">{p.link}</a> : p.note}
                  </small>
                  <span className={`proof ${p.status}`}>{p.status === 'approved' ? 'Confirmed ✓' : p.status === 'rejected' ? 'Rejected' : 'Awaiting review'}</span>
                </div>
              </article>
            ))}
          </section>
        )}

        {dashTab === 'chat' && (
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

        {dashTab === 'progress' && (
          <section>
            <p className="eyebrow">YOUR PROGRESS</p>
            <h2>{myStreak.current} day streak</h2>
            <p className="dim">Personal best: {myStreak.best} days</p>

            {last7.length > 0 && (
              <div className="weekSection">
                <p className="eyebrow">THIS WEEK</p>
                <div className="weekGrid">
                  {last7.map(d => (
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
              </div>
            )}
          </section>
        )}
      </section>

      <aside className="rightRail">
        <div className="peoplePanel card">
          <div className="peoplePanelHead"><p className="eyebrow">YOUR PEOPLE</p><h2>{room?.name}</h2></div>
          {members.map(m => (
            <div className="personRow" key={m.user_id}>
              <span className="avatar" style={{ background: avatarColor(m.user_id) }}>{(m.profiles?.display_name || 'M')[0]?.toUpperCase()}</span>
              <div><b>{m.profiles?.display_name || 'Member'}{m.user_id === myId ? ' (you)' : ''}</b><small>{statusFor(m.user_id)}</small></div>
              <span className="streakNum">{streaks[m.user_id]?.current ?? 0}<small>days</small></span>
            </div>
          ))}
          {isOwner && !roomFull && <button className="inviteRow" type="button" onClick={() => setDashTab('today')}>+ Invite a friend</button>}
          {roomFull && <p className="dim" style={{ marginTop: 8 }}>Room full (2/2)</p>}
        </div>

        <div className="feedPanel card">
          <div className="feedPanelHead"><p className="eyebrow">FROM THE GROUP</p><h3>Recent proof</h3><button className="link tinyLink" type="button" onClick={() => setDashTab('feed')}>See all</button></div>
          {feedProofs.slice(0, 3).map(p => (
            <div className="feedPreviewItem" key={p.id}>
              <span className="avatar small" style={{ background: avatarColor(p.user_id) }}>{(p.profiles?.display_name || nameFor(p.user_id))[0]?.toUpperCase()}</span>
              <div><b>{p.profiles?.display_name || nameFor(p.user_id)}</b><small>{p.kind === 'image' ? 'posted a photo' : p.kind === 'link' ? 'shared a link' : 'left a note'} on {p.daily_tasks?.platform}</small></div>
            </div>
          ))}
          {feedProofs.length === 0 && <p className="dim">Nothing yet.</p>}
        </div>
      </aside>

      {proofModalTask && (
        <div className="modalOverlay" onClick={() => { setProofModalTask(null); setProofFile(null) }}>
          <form className="card modalCard" onClick={e => e.stopPropagation()} onSubmit={submitProofModal}>
            <h2>Proof for {proofModalTask.platform}</h2>
            <input name="proofText" placeholder="Paste a link or write a quick note" />
            <label className="fileLabel">
              {proofFile ? proofFile.name : 'Or attach a photo →'}
              <input type="file" accept="image/*" onChange={e => setProofFile(e.target.files?.[0] || null)} hidden />
            </label>
            <button disabled={proofSubmitting}>{proofSubmitting ? 'Sending…' : 'Submit proof →'}</button>
            <button className="link" type="button" disabled={proofSubmitting} onClick={() => { setProofModalTask(null); setProofFile(null) }}>Cancel</button>
          </form>
        </div>
      )}

      {showProfileMenu && (
        <div className="modalOverlay" onClick={() => setShowProfileMenu(false)}>
          <div className="card modalCard" onClick={e => e.stopPropagation()}>
            <h2>Your profile</h2>

            <form onSubmit={saveDisplayName}>
              <label>Display name</label>
              <input name="displayName" defaultValue={myName} maxLength={40} />
              <button>Save name</button>
            </form>

            <label>Platforms you're focused on (pick at least 3)</label>
            <div className="chipGrid">
              {PLATFORM_OPTIONS.map(p => (
                <button type="button" key={p} className={editPlatforms.includes(p) ? 'picked' : ''} onClick={() => toggleEditPlatform(p)}>{p}</button>
              ))}
            </div>
            <button type="button" onClick={savePlatformsEdit} disabled={editPlatforms.length < 3}>Save platforms ({editPlatforms.length}/3)</button>

            {room && isOwner && (
              <form onSubmit={saveRoomSettings}>
                <label>Room name</label>
                <input name="roomName" defaultValue={room.name} maxLength={60} required />
                <label>When does your day reset?</label>
                <select name="boundary" defaultValue={room.day_boundary_time.slice(0, 5)}>{BOUNDARY_PRESETS.map(b => <option key={b.v} value={b.v}>{b.l}</option>)}</select>
                <label>Timezone</label>
                <select name="timezone" defaultValue={room.timezone}>{TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}</option>)}</select>
                <button>Save room settings</button>
              </form>
            )}

            {!isStandalone && (installPrompt || isIOS || isAndroid) && (
              <>
                <label>Get the app</label>
                {installPrompt
                  ? <button type="button" onClick={installApp}>⬇ Download app</button>
                  : isIOS
                    ? <p className="dim">Tap the Share icon in Safari, then "Add to Home Screen".</p>
                    : <p className="dim">Open your browser menu and choose "Install app".</p>}
              </>
            )}

            <div className="inlineActions">
              <button className="dangerBtn" type="button" onClick={leaveRoom}>Leave room</button>
              {room && isOwner && <button className="dangerBtn" type="button" onClick={deleteRoomFn}>Delete room</button>}
            </div>

            <button className="link" type="button" onClick={() => setShowProfileMenu(false)}>Close</button>
          </div>
        </div>
      )}

      {notice && <div className="toast">{notice}</div>}
    </main>
  )
}

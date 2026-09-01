'use client'
import { FormEvent, useEffect, useMemo, useState } from 'react'
import { isConfigured, supabase } from '@/lib/supabase/client'

type Track = 'creator' | 'social'
type Room = { id: string; name: string; track: Track; daily_target: number }
type Task = { id: string; title: string; detail: string | null; platform: string | null; points: number }
type ProofStatus = 'submitted' | 'approved' | 'rejected'
type Proof = {
  id: string
  task_id: string
  user_id: string
  status: ProofStatus
  kind: 'image' | 'link' | 'note'
  note: string | null
  link: string | null
  profiles: { display_name: string } | null
}

const creator = [
  { title: 'Post an Instagram Story', detail: 'Share something real from today', platform: 'Instagram', points: 10 },
  { title: 'Post a TikTok', detail: 'Progress over polish', platform: 'TikTok', points: 15 },
  { title: 'Post on another platform', detail: 'Choose the platform you want to grow', platform: 'Other', points: 15 },
]
const social = [
  { title: 'Reach out to someone', detail: 'Send a message, call, or voice note', platform: 'Connection', points: 10 },
  { title: 'Do one thing in public', detail: 'Go somewhere, start something, show up', platform: 'Out and about', points: 15 },
  { title: 'Make a plan with someone', detail: 'Put something on the calendar', platform: 'Connection', points: 15 },
]

export default function Home() {
  const db = useMemo(() => (isConfigured() ? supabase() : null), [])
  const [user, setUser] = useState<any>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [proofs, setProofs] = useState<Proof[]>([])
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'auth' | 'profile' | 'setup' | 'join' | 'room'>('auth')
  const [track, setTrack] = useState<Track>('creator')
  const [authView, setAuthView] = useState<'signup' | 'signin'>('signup')
  const [inviteCode, setInviteCode] = useState('')

  useEffect(() => {
    if (!db) return
    db.auth.getUser().then(({ data }) => {
      setUser(data.user)
      if (data.user) loadRoom()
    })
    const { data: { subscription } } = db.auth.onAuthStateChange((_e, s) => {
      setUser(s?.user ?? null)
      if (s?.user) loadRoom()
    })
    return () => subscription.unsubscribe()
  }, [db])

  async function loadRoom() {
    if (!db) return
    const { data } = await db.from('rooms').select('id,name,track,daily_target').limit(1).maybeSingle()
    if (!data) { setMode('profile'); return }
    setRoom(data)
    setMode('room')
    const today = new Date().toISOString().slice(0, 10)
    const [{ data: roomTasks }, { data: roomProofs }] = await Promise.all([
      db.from('room_tasks').select('id,title,detail,platform,points').eq('room_id', data.id).eq('active', true),
      db.from('proofs').select('id,task_id,user_id,status,kind,note,link,profiles(display_name)').eq('room_id', data.id).eq('task_date', today),
    ])
    setTasks(roomTasks || [])
    setProofs((roomProofs as any) || [])
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

  async function createRoom(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const name = String(form.get('room'))
    const { data: roomId, error } = await db.rpc('create_room_with_tasks', {
      room_name: name,
      chosen_track: track,
      target: Number(form.get('target')),
      task_rows: track === 'creator' ? creator : social,
    })
    if (error || !roomId) { setNotice(error?.message || 'Could not create room'); return }
    const { data: invite } = await db.from('room_invites').insert({ room_id: roomId, created_by: user.id }).select('code').single()
    if (invite) setInviteCode(invite.code)
    await loadRoom()
  }

  async function joinRoom(e: FormEvent<HTMLFormElement>) {
    if (!db) return
    e.preventDefault()
    const code = String(new FormData(e.currentTarget).get('code')).trim()
    const { error } = await db.rpc('join_room_with_invite', { invite_code: code })
    if (error) { setNotice(error.message); return }
    await loadRoom()
  }

  async function submitProof(task: Task) {
    if (!db || !room || !user) return
    const note = window.prompt(`Proof for "${task.title}" — paste a link or write a quick note:`)
    if (!note) return
    const isLink = /^https?:\/\//.test(note)
    // Upsert (not insert) so a proof your partner rejected can be corrected and resubmitted
    // instead of permanently colliding with the unique (task_id,user_id,task_date) row.
    const { error } = await db.from('proofs').upsert(
      {
        room_id: room.id,
        task_id: task.id,
        user_id: user.id,
        task_date: new Date().toISOString().slice(0, 10),
        kind: isLink ? 'link' : 'note',
        link: isLink ? note : null,
        note: isLink ? null : note,
        status: 'submitted',
        reviewed_by: null,
        reviewed_at: null,
        rejection_reason: null,
      },
      { onConflict: 'task_id,user_id,task_date' },
    )
    if (error) setNotice(error.message)
    else { setNotice('Proof sent. Your partner must confirm it before points count.'); loadRoom() }
  }

  async function reviewProof(proof: Proof, decision: 'approved' | 'rejected') {
    if (!db) return
    const reason = decision === 'rejected' ? window.prompt('Optional: why are you rejecting this proof?') : null
    const { error } = await db.rpc('review_proof', { proof_id: proof.id, decision, reason })
    if (error) setNotice(error.message)
    else { setNotice(decision === 'approved' ? 'Proof confirmed.' : 'Proof rejected.'); loadRoom() }
  }

  if (!db) return <main className="welcome"><div><p className="eyebrow">DO IT TOGETHER</p><h1>Almost<br/><i>ready.</i></h1><p>Add the Supabase public URL and publishable key in <code>.env.local</code> to start your private room.</p></div></main>

  if (mode === 'auth') return <main className="welcome"><div><p className="eyebrow">DO IT TOGETHER</p><h1>Show up.<br/><i>Together.</i></h1><p>Build your own social rhythm, then invite a friend whenever you want accountability.</p></div><form className="card" onSubmit={auth}><h2>{authView === 'signup' ? 'Create your profile' : 'Welcome back'}</h2>{authView === 'signup' && <input required name="name" placeholder="Your name" />}<input required name="email" type="email" placeholder="Email" /><input required name="password" type="password" placeholder="Password" minLength={6} /><button>{authView === 'signup' ? 'Create profile →' : 'Sign in →'}</button><button className="link" type="button" onClick={() => { setAuthView(authView === 'signup' ? 'signin' : 'signup'); setNotice('') }}>{authView === 'signup' ? 'I already have an account' : 'Create a new account'}</button>{notice && <small>{notice}</small>}</form></main>

  if (mode === 'profile') return <main className="welcome"><form className="card setup"><p className="eyebrow">YOUR PROFILE IS READY</p><h1>How do you want<br/><i>to show up?</i></h1><p>Start alone now, create a shared room for a friend, or join a friend who has already created one.</p><div className="picks"><button type="button" onClick={() => setMode('setup')}><b>Use it solo</b><span>Your own daily social goals</span></button><button type="button" onClick={() => setMode('setup')}><b>Create a room with a friend</b><span>Make an invite code after setup</span></button><button type="button" onClick={() => setMode('join')}><b>Join a friend</b><span>Enter their room code</span></button></div></form></main>

  if (mode === 'join') return <main className="welcome"><form className="card setup" onSubmit={joinRoom}><p className="eyebrow">JOIN A ROOM</p><h1>Bring your<br/><i>friend's code.</i></h1><input required name="code" placeholder="Invite code" /><button>Join room →</button><button className="link" type="button" onClick={() => setMode('profile')}>Back</button>{notice && <small>{notice}</small>}</form></main>

  if (mode === 'setup') return <main className="welcome"><form className="card setup" onSubmit={createRoom}><p className="eyebrow">CREATE A ROOM</p><h1>Choose your<br/><i>daily rhythm.</i></h1><input required name="room" placeholder="Room name — e.g. The Posting Pact" /><div className="picks"><button type="button" onClick={() => setTrack('creator')} className={track === 'creator' ? 'picked' : ''}><b>Creator</b><span>Post consistently online</span></button><button type="button" onClick={() => setTrack('social')} className={track === 'social' ? 'picked' : ''}><b>Social life</b><span>Show up in real life</span></button></div><select name="target" defaultValue="10"><option value="10">10 points · one rep daily</option><option value="25">25 points · two reps daily</option><option value="40">40 points · three reps daily</option></select><button>Create room →</button><button className="link" type="button" onClick={() => setMode('profile')}>Back</button>{notice && <small>{notice}</small>}</form></main>

  // Proofs are fetched for the whole room (needed for the shared points pool and for reviewing
  // your partner's proofs), so each task card must look up *your own* proof by user_id — not
  // just any proof with a matching task_id — or you'd see your partner's status on your card.
  const myProofs = proofs.filter(p => p.user_id === user?.id)
  const pendingReview = proofs.filter(p => p.user_id !== user?.id && p.status === 'submitted')
  const confirmed = proofs.filter(p => p.status === 'approved').reduce((n, p) => n + (tasks.find(t => t.id === p.task_id)?.points || 0), 0)
  const seconds = Math.max(0, Math.floor((new Date(new Date().setHours(24, 0, 0, 0)).getTime() - Date.now()) / 1000))
  const time = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <main className="dashboard">
      <header>
        <b>↗ <span>do it<br/>together</span></b>
        <p>{room?.track === 'creator' ? 'CREATOR ROOM' : 'SOCIAL LIFE ROOM'} · {room?.name}</p>
        <button className="link" onClick={() => db.auth.signOut()}>Sign out</button>
      </header>

      {inviteCode && <section className="progress"><b>Invite your friend: {inviteCode}</b><span>They create their own profile first, then choose "Join a friend" and enter this code.</span></section>}

      <section className="hero">
        <div>
          <p className="eyebrow">TODAY'S SHARED TARGET</p>
          <h1>{room?.daily_target} points<br/><i>before midnight.</i></h1>
          <p>Both of you must hit the target and confirm each other's proof for today's points to bank.</p>
        </div>
        <div className="count">
          <small>TIME LEFT</small>
          <strong>{time}</strong>
          <span>Check in with your partner before the clock resets.</span>
        </div>
      </section>

      <section className="progress">
        <b>{confirmed}/{room?.daily_target} confirmed points</b>
        <span>{confirmed >= Number(room?.daily_target) ? 'Target reached — keep it going.' : 'No points count until your partner approves proof.'}</span>
      </section>

      {pendingReview.length > 0 && (
        <section className="reviewSection">
          <h2>Confirm your partner's proof</h2>
          {pendingReview.map(p => {
            const task = tasks.find(t => t.id === p.task_id)
            return (
              <div className="reviewCard" key={p.id}>
                <div>
                  <b>{p.profiles?.display_name || 'Your partner'} · {task?.title}</b>
                  <small>{p.kind === 'link' ? p.link : p.note}</small>
                </div>
                <button onClick={() => reviewProof(p, 'approved')}>Confirm</button>
                <button className="reject" onClick={() => reviewProof(p, 'rejected')}>Reject</button>
              </div>
            )
          })}
        </section>
      )}

      <section>
        <p className="eyebrow">YOUR DAILY REPS</p>
        <h2>What are you showing up for?</h2>
        {tasks.map(task => {
          const proof = myProofs.find(p => p.task_id === task.id)
          return (
            <article className="task" key={task.id}>
              <div><b>{task.title}</b><small>{task.detail}</small><em>{task.points} points</em></div>
              {proof
                ? <span className={`proof ${proof.status}`}>{proof.status === 'approved' ? 'Confirmed ✓' : proof.status === 'rejected' ? 'Rejected — resubmit' : 'Waiting for partner'}</span>
                : <button onClick={() => submitProof(task)}>Submit proof →</button>}
            </article>
          )
        })}
      </section>

      {notice && <div className="toast">{notice}</div>}
    </main>
  )
}

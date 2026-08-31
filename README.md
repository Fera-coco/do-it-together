# do it together

A private two-person accountability app for showing up online and offline.

## Stack

- Next.js + TypeScript
- Supabase Auth, Postgres, Storage, and Realtime
- Vercel deployment

## Setup

1. In Supabase SQL Editor, run `supabase/schema.sql`.
2. Copy `.env.example` to `.env.local` and add your Supabase publishable key.
3. Install dependencies with `npm install`, then run `npm run dev`.
4. Add the same environment variables in Vercel before deploying.

Never expose a Supabase service-role key in the browser.

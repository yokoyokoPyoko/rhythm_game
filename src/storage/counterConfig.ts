// Global access counter backend (Supabase) configuration.
//
// Festival use (shared cumulative counts across PCs) requires a Supabase
// project. Fill in the two values below, then rebuild + redeploy.
// Until then the app runs in local-only mode (per-browser localStorage).
//
// Setup (Supabase dashboard → SQL Editor, run once):
//   create table if not exists play_events (
//     id bigint generated always as identity primary key,
//     song_id text not null,
//     played_at timestamptz not null default now(),
//     score integer,
//     rank text
//   );
//   alter table play_events enable row level security;
//   create policy "public read" on play_events for select using (true);
//   -- Single write path (replaces increment_play_count + 1-arg log_play;
//   -- old overloads may remain, they are simply unused):
//   create or replace function log_play(sid text, sc integer default null, rk text default null)
//   returns void language plpgsql security definer as $$
//   begin
//     insert into play_events(song_id, score, rank) values (sid, sc, rk);
//   end $$;
//   grant execute on function log_play(text, integer, text) to anon, authenticated;
//   (Counts and bests are both derived from play_events by aggregation.
//   The legacy high_scores table stays read-only as a fallback.)
//
// Then paste Project URL + anon public key below.

export const SUPABASE_URL: string = 'https://razzgbcnowsnlufdohsf.supabase.co';
export const SUPABASE_ANON_KEY: string = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhenpnYmNub3dzbmx1ZmRvaHNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTQzNDgsImV4cCI6MjEwNDY3MDM0OH0.U9FoslW5RXRy7GA_bIKMOfaL2d4S-tH6tIXUhrpuw4Y';

export const COUNTER_ENABLED = SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';

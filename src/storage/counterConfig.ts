// Global access counter backend (Supabase) configuration.
//
// Festival use (shared cumulative counts across PCs) requires a Supabase
// project. Fill in the two values below, then rebuild + redeploy.
// Until then the app runs in local-only mode (per-browser localStorage).
//
// Setup (Supabase dashboard → SQL Editor, run once):
//   create table if not exists play_counts (
//     song_id text primary key,
//     count integer not null default 0
//   );
//   alter table play_counts enable row level security;
//   create policy "public read" on play_counts for select using (true);
//   create or replace function increment_play_count(sid text)
//   returns integer language plpgsql security definer as $$
//   declare c integer;
//   begin
//     insert into play_counts(song_id, count) values (sid, 1)
//     on conflict (song_id) do update set count = play_counts.count + 1
//     returning play_counts.count into c;
//     return c;
//   end $$;
//   grant execute on function increment_play_count(text) to anon, authenticated;
//
// Then paste Project URL + anon public key below.

export const SUPABASE_URL: string = 'https://razzgbcnowsnlufdohsf.supabase.co';
export const SUPABASE_ANON_KEY: string = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhenpnYmNub3dzbmx1ZmRvaHNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTQzNDgsImV4cCI6MjEwNDY3MDM0OH0.U9FoslW5RXRy7GA_bIKMOfaL2d4S-tH6tIXUhrpuw4Y';

export const COUNTER_ENABLED = SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';

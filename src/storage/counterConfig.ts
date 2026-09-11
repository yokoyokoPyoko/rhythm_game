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

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

export const COUNTER_ENABLED = SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';

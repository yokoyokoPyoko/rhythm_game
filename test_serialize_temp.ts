import { chartToToml } from './src/chart/serialize';

const complexChart = {
  title: 'Zoom RoundTrip',
  artist: 'Tester',
  audio: 'test.flac',
  audio_offset: 0,
  amplitude: 1.0,
  start_position: 0,
  bpm_changes: [
    { beat: 0, bpm: 120, amplitude: 1.0, zoom: 1.0 },
    { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 2.0 },
    { beat: 8.25, bpm: 140, zoom: 0.5 },
    { beat: 12.125, bpm: 180, amplitude: 2.7, zoom: 1.5 },
  ],
  segments: [{ direction: 'down', beats: 2 }],
  rings: [{ beat: 4.0 }],
};

const toml = chartToToml(complexChart as any);
console.log("=== SERIALIZED TOML ===");
console.log(toml);
console.log("=== END ===");

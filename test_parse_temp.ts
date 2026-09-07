import { parseChartText } from './src/chart/loader';

const toml = `title = "Zoom RoundTrip"
artist = "Tester"
audio = "test.flac"
audio_offset = 0
amplitude = 1
start_position = 0

[[sections]]
beat = 0
bpm = 120
amplitude = 1
zoom = 1

[[sections]]
beat = 4.37
bpm = 150
amplitude = 1.3
zoom = 2

[[sections]]
beat = 8.25
bpm = 140
zoom = 0.5

[[sections]]
beat = 12.125
bpm = 180
amplitude = 2.7
zoom = 1.5

[[segments]]
direction = "down"
beats = 2

[[rings]]
beat = 4
`;

try {
  const parsed = parseChartText(toml);
  console.log("=== PARSED ===");
  console.log(JSON.stringify(parsed, null, 2));
  console.log("=== END ===");
} catch (e) {
  console.error("PARSE ERROR:", e);
}

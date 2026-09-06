import { describe, it, expect, vi } from 'vitest';
import { RingState } from '../src/types';
import { calculateCalibrationHitYDist } from '../src/screens/editor/CalibrationModal';

// Setup Mock Data
const createRing = (id: number, hitTime: number, targetY: number, resolved = false): RingState => ({
  id,
  spawnTime: hitTime - 1000,
  hitTime,
  targetY,
  resolved,
  hit: false,
});

describe('T174: Calibration Hit Y-Distance Bug Fix', () => {
  it('should correctly calculate yDist for the actual hit ring, not just timing-closest', () => {
    // Scenario:
    // R1: timing error 10ms, yDist 0
    // R2: timing error 5ms, yDist 100
    // Buggy implementation would pick R2 for yDist because of 5ms < 10ms, even if R2 is not the hit ring (R1 is hit because Y < HIT_Y)
    
    const pressTime = 1005;
    const cursorY = 100;
    const r1 = createRing(1, 1015, 100); // err = 10, yDist = 0
    const r2 = createRing(2, 1010, 200); // err = 5, yDist = 100
    const rings = [r1, r2];

    // The buggy logic (as described) would find bestErr = 5 (R2), so yDist = 100.
    // The correct logic must compute yDist for R1, which is 0.
    
    const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings);
    
    expect(yDist).toBe(0); // Should be 0, the yDist of the ring that *would* be hit.
  });

  it('should correctly handle complex amplitudes and off-grid timings', () => {
    // T127/T174 requirement: Use complex amplitudes (0.7, 1.3, 2.7) and off-grid beats (0.37, 1.23)
    const amplitudes = [0.7, 1.3, 2.7];
    const offGridBeats = [0.37, 1.23];
    
    for (const amp of amplitudes) {
      for (const beat of offGridBeats) {
        const pressTime = beat * 500; // beat * beatMs (BPM 120 -> 500ms/beat)
        const cursorY = 200; // CENTER
        
        // Ring at the same beat, different Y
        const ringY = 200 + (amp * 50); // Complex targetY
        const ring = createRing(1, pressTime, ringY);
        const rings = [ring];
        
        const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings);
        
        expect(yDist).toBeCloseTo(Math.abs(cursorY - ringY), 2);
      }
    }
  });

  it('should not compute yDist for resolved rings', () => {
    const pressTime = 1005;
    const cursorY = 100;
    const r1 = createRing(1, 1015, 100, true); // R1 resolved
    const r2 = createRing(2, 1010, 200); // R2 unresolved
    const rings = [r1, r2];
    
    // R1 resolved, so R2 must be the one.
    const yDist = calculateCalibrationHitYDist(pressTime, cursorY, rings);
    
    expect(yDist).toBe(Math.abs(cursorY - r2.targetY));
  });
});

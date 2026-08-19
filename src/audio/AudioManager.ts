export class AudioManager {
  private static instance: AudioManager | null = null;
  private _ctx: AudioContext | null = null;

  static getInstance(): AudioManager {
    if (!AudioManager.instance) {
      AudioManager.instance = new AudioManager();
    }
    return AudioManager.instance;
  }

  async ensure(): Promise<void> {
    if (!this._ctx) {
      this._ctx = new AudioContext();
    }
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }
  }

  get ctx(): AudioContext {
    if (!this._ctx) {
      throw new Error('AudioContext is not initialized. Call ensure() first.');
    }
    return this._ctx;
  }

  get baseLatency(): number {
    return this._ctx ? this._ctx.baseLatency : 0;
  }

  get outputLatency(): number {
    return this._ctx ? this._ctx.outputLatency : 0;
  }
}

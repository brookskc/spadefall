// Cadence ownership for noncritical presentation work. Simulation and input
// remain frame-rate driven; cached HUD views do not need 60 DOM/canvas writes/s.
export class PresentationSchedule {
  constructor() { this.fast = 0; this.slow = 0; this.network = 0; }

  step(dt) {
    this.fast -= dt; this.slow -= dt; this.network -= dt;
    const due = { fast: this.fast <= 0, slow: this.slow <= 0, network: this.network <= 0 };
    if (due.fast) this.fast = 1 / 20;
    if (due.slow) this.slow = 0.1;
    if (due.network) this.network = 0.25;
    return due;
  }

  reset() { this.fast = this.slow = this.network = 0; }
}

// Animation clock. Normally wall time; during video export a virtual time that advances exactly
// one frame per rendered frame, so eased motion looks the same at any encode speed.

let virtual: number | null = null;

export const clock = {
  now(): number {
    return virtual ?? performance.now();
  },
  /** Start (or move) virtual time, in ms. */
  set(ms: number) {
    virtual = ms;
  },
  /** Back to wall time. */
  release() {
    virtual = null;
  },
  get exporting(): boolean {
    return virtual !== null;
  },
};

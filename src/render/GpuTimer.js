/**
 * GPU time per pass via EXT_disjoint_timer_query_webgl2 (render owner). TIME_ELAPSED queries can't nest, so labels
 * form a stack: push() ends the running query and starts one for the new label, pop() resumes the outer label.
 * Results arrive a few frames later (poll() never blocks: it stops at the first unavailable query).
 *
 *   timer.enabled = true;   // off by default: zero overhead
 *   timer.window()          // { frames, ms: { label: avg ms/frame }, total }
 */
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.available = !!this.ext;
    this.enabled = false;
    this.stack = [];
    this.cur = null;
    this.pending = [];
    this.pool = [];
    this.frame = 0;
    this.reset();
  }

  reset() { this.sum = {}; this.framesDone = new Set(); this.disjoint = 0; }

  get on() { return this.enabled && this.available; }

  push(label) {
    if (!this.on) return;
    this._end();
    this.stack.push(label);
    this._begin(label);
  }

  pop() {
    if (!this.on) return;
    this._end();
    this.stack.pop();
    if (this.stack.length) this._begin(this.stack[this.stack.length - 1]);
  }

  _begin(label) {
    const gl = this.gl, q = this.pool.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.cur = { q, label, frame: this.frame };
  }

  _end() {
    if (!this.cur) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.cur);
    this.cur = null;
  }

  /** Call once per frame after all rendering. */
  endFrame() {
    if (!this.available) return;
    if (this.cur) { this._end(); this.stack.length = 0; }
    this.frame++;
    this.poll();
  }

  poll() {
    const gl = this.gl;
    if (!this.pending.length) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (disjoint) this.disjoint++;
    let i = 0;
    for (; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) {
        const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
        this.sum[p.label] = (this.sum[p.label] || 0) + ms;
        this.framesDone.add(p.frame);
      }
      this.pool.push(p.q);
    }
    if (i) this.pending.splice(0, i);
  }

  /** Average GPU ms per frame for each label since reset(). */
  window() {
    const n = Math.max(1, this.framesDone.size), ms = {};
    let total = 0;
    for (const [k, v] of Object.entries(this.sum)) { ms[k] = +(v / n).toFixed(3); total += v / n; }
    return { frames: this.framesDone.size, ms, total: +total.toFixed(3), disjoint: this.disjoint };
  }
}

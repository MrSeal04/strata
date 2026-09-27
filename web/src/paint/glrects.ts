// WebGL2 instanced rectangles: one draw call for 100k treemap cells (Canvas2D spends 50-100 ms
// per frame at that count, GPU-backed or not). Used on screen only; exports keep the Painter path.

const VS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 rect;
layout(location = 2) in vec4 color;
uniform vec2 size;
out vec4 v_color;
void main() {
  vec2 p = rect.xy + corner * rect.zw;
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
  v_color = color;
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() { outColor = vec4(v_color.rgb * v_color.a, v_color.a); }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

const parsed = new Map<string, [number, number, number]>();

function rgb(color: string): [number, number, number] {
  let c = parsed.get(color);
  if (!c) {
    const hex = color.trim().replace("#", "");
    const full = hex.length === 3 ? hex.split("").map((x) => x + x).join("") : hex;
    const m = /^([0-9a-f]{6})/i.exec(full);
    if (m) {
      const n = parseInt(m[1], 16);
      c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    } else {
      // rgb(...) from d3 interpolators
      const nums = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
      c = [nums[0] | 0, nums[1] | 0, nums[2] | 0];
    }
    parsed.set(color, c);
  }
  return c;
}

export class GlRects {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private rectBuf: WebGLBuffer;
  private colorBuf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private uSize: WebGLUniformLocation;
  private rects = new Float32Array(4 * 1024);
  private colors = new Uint8Array(4 * 1024);
  private n = 0;

  /** Returns null where WebGL2 is unavailable (callers fall back to Canvas2D). */
  static create(): GlRects | null {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: false });
      return gl ? new GlRects(canvas, gl) : null;
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);
    this.uSize = gl.getUniformLocation(prog, "size")!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.rectBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    this.colorBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  begin() {
    this.n = 0;
  }

  /** Queue rects [x, y, w, h, ...] (CSS px) in one color. */
  add(xywh: ArrayLike<number>, color: string, alpha = 1) {
    const count = xywh.length >> 2;
    const need = (this.n + count) * 4;
    if (need > this.rects.length) {
      const cap = Math.max(need, this.rects.length * 2);
      const r = new Float32Array(cap);
      r.set(this.rects);
      this.rects = r;
      const c = new Uint8Array(cap);
      c.set(this.colors);
      this.colors = c;
    }
    const [cr, cg, cb] = rgb(color);
    const ca = Math.round(alpha * 255);
    let o = this.n * 4;
    for (let i = 0; i < count * 4; i += 4, o += 4) {
      this.rects[o] = xywh[i];
      this.rects[o + 1] = xywh[i + 1];
      this.rects[o + 2] = xywh[i + 2];
      this.rects[o + 3] = xywh[i + 3];
      this.colors[o] = cr;
      this.colors[o + 1] = cg;
      this.colors[o + 2] = cb;
      this.colors[o + 3] = ca;
    }
    this.n += count;
  }

  /** Draw everything queued, over a cleared background. */
  flush(width: number, height: number, dpr: number, background: string) {
    const gl = this.gl;
    const W = Math.round(width * dpr);
    const H = Math.round(height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    const [r, g, b] = rgb(background);
    gl.clearColor(r / 255, g / 255, b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.uSize, width, height);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.rects.subarray(0, this.n * 4), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.colors.subarray(0, this.n * 4), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
  }
}

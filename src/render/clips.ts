// 播片：一段画好的像素 GIF（比如 clawd-400 里的），播的时候顶替程序化的 Clawd。
// GIF 是放大过的像素图（clawd-400 是 12px 一格），解码后还原成一格一像素，
// 渲染器再按宠物的像素大小放大，这样播片和平时的 Clawd 像素粒度一样。

export interface ClipFrame {
  image: ImageData;
  /** 这一帧播到第几秒为止（从开头累计） */
  until: number;
  /** 不透明像素的包围盒（原始像素格），空帧为 null */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface Clip {
  /** 原始像素格的宽高 */
  w: number;
  h: number;
  /** 脚底在第几行（所有帧里最低的不透明像素的下沿）：贴着宠物脚下的地面 */
  floor: number;
  frames: ClipFrame[];
  /** 总时长（秒） */
  duration: number;
}

const cache = new Map<string, Promise<Clip | null>>();

/** 解码一个 GIF 播片。WebView 不支持 ImageDecoder 或解码失败时为 null（不播就是了） */
export function loadClip(url: string): Promise<Clip | null> {
  let p = cache.get(url);
  if (!p) {
    p = decode(url).catch((e) => {
      console.warn('播片解码失败', url, e);
      return null;
    });
    cache.set(url, p);
  }
  return p;
}

/** 当前该播哪一帧 */
export function clipFrame(clip: Clip, t: number): ClipFrame {
  return clip.frames.find((f) => t < f.until) ?? clip.frames[clip.frames.length - 1];
}

async function decode(url: string): Promise<Clip | null> {
  if (typeof ImageDecoder === 'undefined') return null;
  const data = await (await fetch(url)).arrayBuffer();
  const dec = new ImageDecoder({ data, type: 'image/gif' });
  try {
    await dec.tracks.ready;
    const count = dec.tracks.selectedTrack?.frameCount ?? 0;
    if (!count) return null;
    const full: { rgba: Uint8ClampedArray; ms: number }[] = [];
    let W = 0;
    let H = 0;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    for (let i = 0; i < count; i++) {
      // ImageDecoder 给的是合成好的整帧（GIF 的局部更新、处置方式都处理过了）
      const { image } = await dec.decode({ frameIndex: i });
      W = image.displayWidth;
      H = image.displayHeight;
      canvas.width = W;
      canvas.height = H;
      g.clearRect(0, 0, W, H);
      g.drawImage(image, 0, 0);
      full.push({ rgba: g.getImageData(0, 0, W, H).data, ms: (image.duration ?? 100_000) / 1000 });
      image.close();
    }
    const px = cellPx(full[0].rgba, W, H);
    return shrink(full, W, H, px);
  } finally {
    dec.close();
  }
}

/** 像素图放大了几倍：所有横向同色段长度的最大公约数 */
export function cellPx(rgba: Uint8ClampedArray, W: number, H: number): number {
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H);
  let g = 0;
  for (let y = 0; y < H; y++) {
    let run = 1;
    for (let x = 1; x <= W; x++) {
      if (x < W && px[y * W + x] === px[y * W + x - 1]) {
        run++;
        continue;
      }
      g = gcd(g, run);
      if (g === 1) return 1;
      run = 1;
    }
  }
  return g || 1;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 每 px×px 一格取中心那个像素，还原成一格一像素 */
export function shrink(full: { rgba: Uint8ClampedArray; ms: number }[], W: number, H: number, px: number): Clip {
  const w = Math.floor(W / px);
  const h = Math.floor(H / px);
  const c = Math.floor(px / 2);
  let until = 0;
  let floor = 0;
  const frames = full.map(({ rgba, ms }) => {
    const out = new Uint8ClampedArray(w * h * 4);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((y * px + c) * W + x * px + c) * 4;
        // 半透明的边一律当不透明：像素风不要半透明
        if (rgba[s + 3] < 128) continue;
        const d = (y * w + x) * 4;
        out[d] = rgba[s];
        out[d + 1] = rgba[s + 1];
        out[d + 2] = rgba[s + 2];
        out[d + 3] = 255;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    until += ms / 1000;
    if (y1 + 1 > floor) floor = y1 + 1;
    return {
      image: new ImageData(out, w, h),
      until,
      box: x1 >= x0 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null,
    };
  });
  return { w, h, floor, frames, duration: until };
}

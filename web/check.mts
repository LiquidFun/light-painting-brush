// Render checks: `npm run check`.
//
// Not a full test suite — it covers the parts where a mistake is silent rather
// than loud: curve interpolation, schema migration, and the arithmetic that
// turns a pattern or a brightness curve into pixels. Those are hard to eyeball
// on a 144x125 canvas and easy to get subtly wrong.
//
// Run through vite-node so the imports resolve the way the app sees them.

import {
  axisExtent,
  createKeyframe,
  createLayer,
  createProject,
  describeOverBudget,
  flatCurve,
  isFlatCurve,
  payloadBytes,
  sampleCurve,
  seedProject,
} from './src/model/project'
import { sanitiseProject, SCHEMA_VERSION } from './src/model/storage'
import { createEvaluator, evaluateField, evaluatePreview } from './src/render/field'
import { BRIGHTNESS_POINTS, MAX_FPS, MIN_FPS } from './src/model/types'
import { DEFAULT_PATH, PATH_KINDS, poseAt, usedParams } from './src/render/paths'
import { createSweepWarp } from './src/render/sweep'
import type { PathParams, Pose } from './src/render/paths'
import type { Project } from './src/model/types'

const out: string[] = []
const ok = (name: string, cond: boolean, extra = '') =>
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

// --- sampleCurve ----------------------------------------------------------
ok('flat curve is flat', isFlatCurve(flatCurve()) && flatCurve().length === BRIGHTNESS_POINTS)
ok('sampleCurve flat = 1', near(sampleCurve(flatCurve(), 0.37), 1))
const ramp = Array.from({ length: BRIGHTNESS_POINTS }, (_, i) => i / (BRIGHTNESS_POINTS - 1))
ok('sampleCurve ends', near(sampleCurve(ramp, 0), 0) && near(sampleCurve(ramp, 1), 1))
ok('sampleCurve midpoint', near(sampleCurve(ramp, 0.5), 0.5, 1e-9))
ok('sampleCurve interpolates between samples', near(sampleCurve(ramp, 0.25), 0.25, 1e-9))
ok('sampleCurve clamps out of range', near(sampleCurve(ramp, -1), 0) && near(sampleCurve(ramp, 2), 1))

// --- period migration -----------------------------------------------------
const v2 = {
  schema: 2,
  id: 'mig1',
  name: 'old',
  ledCount: 144,
  durationMs: 4000,
  fps: 25,
  layers: [
    { id: 'l1', kind: 'pattern', name: 'S', opacity: 1, blend: 'normal', hidden: false,
      pattern: { kind: 'stripes', axis: 'led', period: 0.25, duty: 0.5, softness: 0.1, phase: 0,
                 ramp: { from: '#ff0000', to: '#0000ff' } } },
    { id: 'l2', kind: 'pattern', name: 'T', opacity: 1, blend: 'normal', hidden: false,
      pattern: { kind: 'stripes', axis: 'time', period: 0.5, duty: 0.5, softness: 0, phase: 0,
                 ramp: { from: '#ff0000', to: '#0000ff' } } },
  ],
}
const migrated = sanitiseProject(v2)
const p0 = migrated.layers[0] as any
const p1 = migrated.layers[1] as any
ok('schema is 3', SCHEMA_VERSION === 3)
ok('led-axis period 0.25 -> 36 LEDs', p0.pattern.periodPx === 36, String(p0.pattern.periodPx))
const frames = axisExtent(migrated, 'time')
ok('time-axis period 0.5 -> half the frames', p1.pattern.periodPx === Math.round(0.5 * frames),
   `${p1.pattern.periodPx} of ${frames}`)
// wave wavelength gets the identical treatment
const v2wave = {
  schema: 2, id: 'mig2', name: 'old wave', ledCount: 144, durationMs: 4000, fps: 25,
  layers: [
    { id: 'w1', kind: 'pattern', name: 'W', opacity: 1, blend: 'normal', hidden: false,
      pattern: { kind: 'wave', axis: 'led', wavelength: 0.5, amplitude: 1, phase: 0, speed: 1,
                 ramp: { from: '#000000', to: '#ffffff' } } },
  ],
}
const wave = (sanitiseProject(v2wave).layers[0] as any).pattern
ok('wavelength 0.5 -> 72 LEDs', wave.wavelengthPx === 72, String(wave.wavelengthPx))
const waveKept = sanitiseProject({
  ...v2wave,
  layers: [{ ...v2wave.layers[0], pattern: { ...v2wave.layers[0].pattern, wavelengthPx: 13 } }],
})
ok('wavelengthPx wins over wavelength',
   (waveKept.layers[0] as any).pattern.wavelengthPx === 13)

ok('migrated project gets flat curves',
   isFlatCurve(migrated.brightnessX) && isFlatCurve(migrated.brightnessY))

// a schema 3 file keeps periodPx verbatim
const v3 = JSON.parse(JSON.stringify(v2))
v3.schema = 3
v3.layers[0].pattern = { ...v3.layers[0].pattern, periodPx: 9, period: 0.25 }
ok('periodPx wins over period', (sanitiseProject(v3).layers[0] as any).pattern.periodPx === 9)

// --- curve round trip -----------------------------------------------------
const shaped = { ...createProject('c'), brightnessX: ramp.slice(), brightnessY: flatCurve() }
const round = sanitiseProject(JSON.parse(JSON.stringify(shaped)))
ok('curves survive a round trip', round.brightnessX.every((v, i) => near(v, ramp[i])))
const short = sanitiseProject({ ...shaped, brightnessX: [0, 1] })
ok('short curve is resampled, not rejected',
   short.brightnessX.length === BRIGHTNESS_POINTS && near(short.brightnessX[0], 0) &&
   near(short.brightnessX[BRIGHTNESS_POINTS - 1], 1))
const junk = sanitiseProject({ ...shaped, brightnessX: 'nope', brightnessY: [5, -2] })
ok('junk curve falls back to flat', isFlatCurve(junk.brightnessX))
ok('out-of-range curve values clamp',
   junk.brightnessY.every((v) => v >= 0 && v <= 1))

// --- curves applied to the field -----------------------------------------
function solidProject(): Project {
  const p = createProject('solid')
  const layer = createLayer('pattern') as any  // narrowed by assignment below
  layer.pattern = { kind: 'solid', color: '#ffffff' }
  return { ...p, durationMs: 2000, layers: [layer] }
}
const base = solidProject()
const flatField = evaluateField(base)
const px = (f: typeof flatField, x: number, y: number) => f.data[(y * f.width + x) * 3]
ok('unshaped solid is full brightness', near(px(flatField, 0, 0), 1) && near(px(flatField, 143, 10), 1))

const halfX = flatCurve().map(() => 0.5)
const shadedX = evaluateField({ ...base, brightnessX: halfX })
ok('flat 0.5 X curve halves everything', near(px(shadedX, 70, 5), 0.5, 1e-6), String(px(shadedX, 70, 5)))

const rampX = evaluateField({ ...base, brightnessX: ramp.slice() })
ok('X ramp dark at LED 0', near(px(rampX, 0, 3), 0, 1e-6))
ok('X ramp full at the last LED', near(px(rampX, rampX.width - 1, 3), 1, 1e-6))
ok('X ramp is constant down time', near(px(rampX, 40, 0), px(rampX, 40, 20), 1e-9))

const rampY = evaluateField({ ...base, brightnessY: ramp.slice() })
ok('Y ramp dark at t=0', near(px(rampY, 20, 0), 0, 1e-6))
ok('Y ramp is constant across LEDs', near(px(rampY, 0, 9), px(rampY, 100, 9), 1e-9))

const both = evaluateField({ ...base, brightnessX: halfX, brightnessY: halfX })
ok('the two curves multiply', near(px(both, 70, 5), 0.25, 1e-6), String(px(both, 70, 5)))

// --- stripes period in pixels --------------------------------------------
function stripeProject(periodPx: number, axis: 'led' | 'time'): Project {
  const p = createProject('stripes')
  const layer = createLayer('pattern') as any  // narrowed by assignment below
  layer.pattern = { kind: 'stripes', axis, periodPx, duty: 0.5, softness: 0, phase: 0,
                    ramp: { from: '#000000', to: '#ffffff' } }
  return { ...p, ledCount: 144, durationMs: 2000, layers: [layer] }
}
const stripes = evaluateField(stripeProject(20, 'led'))
// duty 0.5, hard edges: the first half of each 20-LED period is `from` (black).
const row = (x: number) => px(stripes, x, 0)
// Band centres, not edges: LEDs 0/10/20 sit exactly on the boundaries, where the
// two stops meet at their midpoint by design.
ok('stripe period 20: first band is the from stop', row(5) < 0.1, String(row(5)))
ok('stripe period 20: second band is the to stop', row(15) > 0.9, String(row(15)))
ok('stripe period 20 repeats one period on', Math.abs(row(5) - row(25)) < 1e-6,
   `${row(5)} vs ${row(25)}`)
ok('stripe period 20 repeats two periods on', Math.abs(row(15) - row(55)) < 1e-6)
ok('a 20-LED period gives 7 full cycles over 144 LEDs',
   Math.abs(row(5) - row(45)) < 1e-6 && Math.abs(row(5) - row(15)) > 0.5)

// --- wave wavelength in pixels -------------------------------------------
function waveProject(wavelengthPx: number): Project {
  const p = createProject('wave')
  const layer = createLayer('pattern') as any
  layer.pattern = { kind: 'wave', axis: 'led', wavelengthPx, amplitude: 0, phase: 0, speed: 0,
                    ramp: { from: '#000000', to: '#ffffff' } }
  return { ...p, ledCount: 144, durationMs: 2000, layers: [layer] }
}
const w = evaluateField(waveProject(40))
const wv = (x: number) => px(w, x, 0)
// amplitude 0 and speed 0: a pure sine along the LEDs, period 40, peak at a
// quarter of the way in and trough at three quarters.
ok('wave peak at a quarter period', wv(10) > 0.99, String(wv(10)))
ok('wave trough at three quarters', wv(30) < 0.01, String(wv(30)))
ok('wave repeats one wavelength on', Math.abs(wv(10) - wv(50)) < 1e-6)
ok('wave of a different length differs',
   Math.abs(wv(10) - px(evaluateField(waveProject(80)), 10, 0)) > 0.05)

const wide = evaluateField(stripeProject(144, 'led'))
ok('period = full strip does not repeat',
   px(wide, 0, 0) < 0.5 && px(wide, 100, 0) > 0.5)


// --- library previews -----------------------------------------------------
{
  const p = solidProject()
  const thumb = evaluatePreview(p, 44, 30)
  ok('preview is the requested size', thumb.width === 44 && thumb.height === 30,
     `${thumb.width}x${thumb.height}`)
  ok('preview matches the full field for a flat layer',
     near(thumb.data[0], 1) && near(thumb.data[thumb.data.length - 1], 1))

  // A preview must never be bigger than the field it summarises.
  const tiny = evaluatePreview({ ...p, ledCount: 8, durationMs: 400 }, 44, 30)
  ok('preview clamps to the field size', tiny.width === 8 && tiny.height <= 30,
     `${tiny.width}x${tiny.height}`)

  // The Y ramp should still read top-to-bottom at preview resolution.
  const rampPreview = evaluatePreview({ ...p, brightnessY: ramp.slice() }, 44, 30)
  const top = rampPreview.data[0]
  const bottom = rampPreview.data[(29 * 44) * 3]
  ok('preview keeps the time axis', top < 0.05 && bottom > 0.95, `${top} -> ${bottom}`)
}


// --- paint layers ---------------------------------------------------------
{
  // The raster is stored as a data URL and nothing else is accepted, so a
  // project stays one self-contained file and the canvas is never tainted.
  const withPaint = sanitiseProject({
    ...createProject('p'),
    layers: [
      { id: 'pa', kind: 'paint', name: 'Paint', opacity: 1, blend: 'normal', hidden: false,
        src: 'data:image/png;base64,iVBORw0KGgo=' },
      { id: 'pb', kind: 'paint', name: 'Remote', opacity: 1, blend: 'normal', hidden: false,
        src: 'https://example.com/evil.png' },
      { id: 'pc', kind: 'paint', name: 'None', opacity: 1, blend: 'normal', hidden: false },
    ],
  })
  ok('paint layers survive sanitisation', withPaint.layers.length === 3)
  ok('paint keeps a data URL', (withPaint.layers[0] as any).src.startsWith('data:image/'))
  ok('paint rejects a remote src', (withPaint.layers[1] as any).src === '')
  ok('paint tolerates a missing src', (withPaint.layers[2] as any).src === '')

  // An unpainted layer must be fully transparent, not black: it is composited
  // over whatever is beneath it.
  const base = solidProject()
  const solidOnly = evaluateField(base)
  const withBlank = evaluateField({
    ...base,
    layers: [
      ...base.layers,
      { id: 'blank', kind: 'paint', name: 'Paint', opacity: 1, blend: 'normal', hidden: false,
        src: '' } as any,
    ],
  })
  ok('an empty paint layer changes nothing',
     withBlank.data.every((v, i) => near(v, solidOnly.data[i])))
}

// --- frame rate is a free integer now -------------------------------------
{
  const p = createProject('fps')
  ok('fps clamps to the range',
     sanitiseProject({ ...p, fps: 999 }).fps === MAX_FPS &&
     sanitiseProject({ ...p, fps: 1 }).fps === MIN_FPS)
  ok('an off-list fps survives', sanitiseProject({ ...p, fps: 37 }).fps === 37)
  ok('a fractional fps rounds', sanitiseProject({ ...p, fps: 24.6 }).fps === 25)
  ok('a junk fps falls back to 25', sanitiseProject({ ...p, fps: 'x' }).fps === 25)

  // The over-budget advice has to name a rate that actually fits.
  const big = { ...createProject('big'), durationMs: 20000, fps: 50 }
  const limit = 60000
  const msg = describeOverBudget(big, limit) ?? ''
  const named = /drop to (\d+) fps/.exec(msg)
  ok('over-budget names a rate', named !== null, msg)
  if (named) {
    const suggested = Number(named[1])
    ok('the suggested rate fits', payloadBytes({ ...big, fps: suggested }) <= limit,
       `${suggested} fps -> ${payloadBytes({ ...big, fps: suggested })} of ${limit}`)
    ok('the suggested rate is below the current one', suggested < big.fps)
  }
}


// --- project defaults and new fields --------------------------------------
{
  const fresh = createProject('n')
  ok('new projects default to 60 fps', fresh.fps === 60, String(fresh.fps))
  ok('new projects loop, ping-pong and auto-play',
     fresh.playback.loop && fresh.playback.pingPong && fresh.playback.autoPlay)
  ok('new projects carry a brightness', fresh.brightness === 80, String(fresh.brightness))
  ok('a new project starts empty',
     seedProject(fresh).layers.length === 1 &&
     (seedProject(fresh).layers[0] as any).keyframes.length === 0)

  // An existing file must not change behaviour because a default moved.
  const old = sanitiseProject({ id: 'o', name: 'old', layers: [] })
  ok('an old project keeps 25 fps', old.fps === 25, String(old.fps))
  ok('an old project does not gain loop/pingPong/autoPlay',
     !old.playback.loop && !old.playback.pingPong && !old.playback.autoPlay)
  ok('a missing brightness defaults to 80', old.brightness === 80)
  ok('brightness clamps', sanitiseProject({ ...fresh, brightness: 9000 }).brightness === 255)

  // Image orientation
  const img = sanitiseProject({
    ...fresh,
    layers: [{ id: 'i', kind: 'image', name: 'I', opacity: 1, blend: 'normal', hidden: false,
               src: 'data:image/png;base64,x', fit: 'cover', rotation: 270, flipX: true }],
  }).layers[0] as any
  ok('image rotation survives', img.rotation === 270 && img.flipX === true && img.flipY === false)
  ok('a junk rotation falls back to 0',
     (sanitiseProject({ ...fresh, layers: [{ id: 'i', kind: 'image', name: 'I', opacity: 1,
       blend: 'normal', hidden: false, src: '', fit: 'cover', rotation: 45 }] }).layers[0] as any)
       .rotation === 0)
}


// --- previews must not resample images at full resolution -----------------
{
  // A 44x30 thumbnail asking for a 144xN resample is what thrashed the cache
  // and made the library flicker. createEvaluator's sampleSize is what stops it.
  const p = { ...createProject('img'), ledCount: 144, durationMs: 10000, fps: 60 }
  const full = createEvaluator(p)
  const small = createEvaluator(p, { width: 44, height: 30 })
  ok('the evaluator still reports the real field size',
     full.width === 144 && small.width === 144 && full.height === small.height,
     `${small.width}x${small.height}`)

  // A paint layer is authoritative pixel art and must read identically at any
  // sampling grid, since it is not resampled at all.
  const painted: Project = {
    ...p,
    layers: [{ id: 'pp', kind: 'paint', name: 'P', opacity: 1, blend: 'normal',
               hidden: false, src: '' } as any],
  }
  const a = evaluatePreview(painted, 44, 30)
  const b = evaluatePreview(painted, 44, 30)
  ok('preview evaluation is stable across calls',
     a.data.every((v, i) => near(v, b.data[i])))
}


// --- keyframe softness ----------------------------------------------------
{
  // A single white column on black: the alpha profile across the strip is what
  // "soft" actually means, and it used to be flat regardless of every control.
  const columnAt = (softness: number) => {
    const layer = createLayer('keyframes') as any
    layer.keyframes = [{ ...createKeyframe('column', 72, 0, '#ffffff'),
                         radius: 0.35, softness, easing: 'smoothstep', hard: false }]
    const p: Project = { ...createProject('s'), ledCount: 144, durationMs: 1000,
                         fps: 25, layers: [layer] }
    const f = evaluateField(p)
    return (led: number) => f.data[led * 3]
  }

  const hard = columnAt(0)
  const soft = columnAt(0.7)
  ok('both peak at the keyframe', near(hard(72), 1, 1e-3) && near(soft(72), 1, 1e-3))
  ok('softness 0 stays full across the radius', hard(72 + 30) > 0.99, String(hard(72 + 30)))
  ok('softness 0.7 has faded by the same point', soft(72 + 30) < 0.7, String(soft(72 + 30)))
  ok('softer is never brighter further out',
     [10, 20, 30, 40].every((d) => soft(72 + d) <= hard(72 + d) + 1e-9))
  ok('both reach the background outside the radius',
     near(hard(72 + 55), 0, 1e-6) && near(soft(72 + 55), 0, 1e-6))

  // The fade has to be monotonic, or the edge shows a ring.
  const values = Array.from({ length: 50 }, (_, d) => soft(72 + d))
  ok('the soft falloff is monotonic',
     values.every((v, i) => i === 0 || v <= values[i - 1] + 1e-9))

  ok('a keyframe with no softness field loads as a hard edge',
     (sanitiseProject({ ...createProject('k'), layers: [{ id: 'l', kind: 'keyframes',
        name: 'K', opacity: 1, blend: 'normal', hidden: false,
        keyframes: [{ id: 'k1', kind: 'point', led: 0, timeMs: 0, color: '#fff',
                      brightness: 1, radius: 0.3, easing: 'smoothstep', hard: false }] }] })
        .layers[0] as any).keyframes[0].softness === 0)
}


// --- 3D sweep paths -------------------------------------------------------
{
  const pose: Pose = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 1, dz: 0 }
  const at = (p: PathParams, t: number) => { poseAt(p, t, pose); return { ...pose } }
  const unit = (q: Pose) => Math.abs(Math.hypot(q.dx, q.dy, q.dz) - 1) < 1e-9

  for (const { id } of PATH_KINDS) {
    const p = { ...DEFAULT_PATH, kind: id, tilt: 30 }
    // A non-unit direction would stretch the stick, so the LEDs would no longer
    // be 1 m apart end to end.
    ok(`${id}: direction stays a unit vector`,
       [0, 0.13, 0.5, 0.77, 1].every((t) => unit(at(p, t))))
    ok(`${id}: finite everywhere`,
       [0, 0.5, 1].every((t) => {
         const q = at(p, t)
         return [q.ox, q.oy, q.oz, q.dx, q.dy, q.dz].every(Number.isFinite)
       }))
  }

  // Upright means upright: a spin with no tilt traces a line, not a disc.
  const flat = at({ ...DEFAULT_PATH, kind: 'circle', tilt: 0 }, 0.3)
  ok('an untilted spin keeps the stick vertical', near(flat.dy, 1, 1e-9))

  // A tilted spin must actually come back round.
  const spin = { ...DEFAULT_PATH, kind: 'circle' as const, tilt: 45, turns: 1 }
  const start = at(spin, 0)
  const half = at(spin, 0.5)
  const end = at(spin, 1)
  ok('a full turn returns to its start',
     near(start.dx, end.dx, 1e-9) && near(start.dz, end.dz, 1e-9))
  ok('half a turn points the opposite way', near(half.dx, -start.dx, 1e-9))

  // Corkscrew is a spin that also advances.
  const screw = { ...DEFAULT_PATH, kind: 'corkscrew' as const, distance: 4, tilt: 30 }
  ok('a corkscrew advances along its axis',
     near(at(screw, 0).ox, -2) && near(at(screw, 1).ox, 2))

  // Wander must be deterministic, or the preview would never sit still.
  const w = { ...DEFAULT_PATH, kind: 'wander' as const, seed: 7 }
  const once = at(w, 0.42)
  const twice = at(w, 0.42)
  ok('wander is deterministic',
     once.ox === twice.ox && once.oy === twice.oy && once.dz === twice.dz)
  ok('a different seed wanders differently',
     Math.abs(at(w, 0.42).oz - at({ ...w, seed: 8 }, 0.42).oz) > 1e-6)

  ok('each mode only offers parameters it uses',
     PATH_KINDS.every(({ id }) => usedParams(id).length > 0))
}


// --- start angle, mirror and spiral ---------------------------------------
{
  const pose2: Pose = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 1, dz: 0 }
  const at2 = (p: PathParams, t: number) => { poseAt(p, t, pose2); return { ...pose2 } }

  for (const { id } of PATH_KINDS) {
    const p = { ...DEFAULT_PATH, kind: id, tilt: 30, startAngle: 140, mirror: true }
    ok(`${id}: still a unit vector with angle and mirror`,
       [0, 0.3, 1].every((t) => {
         const q = at2(p, t)
         return Math.abs(Math.hypot(q.dx, q.dy, q.dz) - 1) < 1e-9
       }))
  }

  // A start angle on a spin is a phase offset: a quarter turn in should match
  // starting 90 degrees round.
  const spin = { ...DEFAULT_PATH, kind: 'circle' as const, tilt: 45, turns: 1 }
  const quarterIn = at2(spin, 0.25)
  const offset = at2({ ...spin, startAngle: 90 }, 0)
  ok('start angle is a phase offset on a spin',
     near(quarterIn.dx, offset.dx, 1e-9) && near(quarterIn.dz, offset.dz, 1e-9))

  // Mirroring must reverse handedness, not just move the thing.
  const plain = at2(spin, 0.1)
  const mirrored = at2({ ...spin, mirror: true }, 0.1)
  ok('mirror reflects through x', near(mirrored.dx, -plain.dx, 1e-9))
  ok('mirror leaves the other axes alone',
     near(mirrored.dy, plain.dy, 1e-9) && near(mirrored.dz, plain.dz, 1e-9))
  ok('mirroring twice is the identity',
     near(at2({ ...spin, mirror: false }, 0.4).dx, plain.dx === 0 ? 0 : at2(spin, 0.4).dx, 1e-9))

  // Spiral pivots at the middle: the stick's centre stays on the travel axis,
  // which is exactly what distinguishes it from corkscrew.
  const spiral = { ...DEFAULT_PATH, kind: 'spiral' as const, turns: 2, distance: 4 }
  for (const t of [0, 0.17, 0.5, 0.83, 1]) {
    const q = at2(spiral, t)
    const cy = q.oy + q.dy * 0.5
    const cz = q.oz + q.dz * 0.5
    ok(`spiral t=${t}: centre stays on the axis`,
       near(cy, 0.5, 1e-9) && near(cz, 0, 1e-9), `${cy.toFixed(3)} ${cz.toFixed(3)}`)
  }
  ok('spiral advances end to end',
     near(at2(spiral, 0).ox + at2(spiral, 0).dx * 0.5, -2, 1e-9) &&
     near(at2(spiral, 1).ox + at2(spiral, 1).dx * 0.5, 2, 1e-9))

  // Corkscrew keeps an *end* on the axis instead, so the two really differ.
  const screw = { ...DEFAULT_PATH, kind: 'corkscrew' as const, turns: 2, distance: 4, tilt: 40 }
  ok('corkscrew keeps its base on the axis',
     [0, 0.3, 0.6].every((t) => near(at2(screw, t).oy, 0, 1e-9)))
}


// --- rotating-sweep correction --------------------------------------------
{
  const DEG = Math.PI / 180
  const out: [number, number] = [0, 0]

  // The warp must be the exact inverse of the sweep: the design point it picks
  // for a cell has to be where that LED physically lands.
  const c = { enabled: true, startAngle: 0, sweep: 180, pivot: 0 }
  const warp = createSweepWarp(c)
  let worst = 0
  for (const u of [0.1, 0.4, 0.7, 1]) {
    for (const v of [0, 0.2, 0.5, 0.8, 1]) {
      warp(u, v, out)
      const phi = (c.startAngle + c.sweep * v) * DEG
      const px = (u - c.pivot) * Math.cos(phi)
      const py = (u - c.pivot) * Math.sin(phi)
      // Half a turn of a unit stick pivoted at the base: x in [-1,1], y in [0,1].
      // The design is an image, so its row 0 is the top and Y is inverted.
      worst = Math.max(worst, Math.abs(out[0] - (px + 1) / 2), Math.abs(out[1] - (1 - py)))
    }
  }
  ok('the warp inverts the sweep exactly', worst < 1e-12, worst.toExponential(1))

  // Fitted to the reachable area, so nothing can land outside the design.
  for (const cfg of [
    { enabled: true, startAngle: 0, sweep: 180, pivot: 0 },
    { enabled: true, startAngle: -140, sweep: -95, pivot: 0.5 },
    { enabled: true, startAngle: 33, sweep: 360, pivot: 0.2 },
  ]) {
    const w = createSweepWarp(cfg)
    let inside = true
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        w(i / 40, j / 40, out)
        if (!(out[0] >= -1e-9 && out[0] <= 1 + 1e-9 && out[1] >= -1e-9 && out[1] <= 1 + 1e-9)) {
          inside = false
        }
      }
    }
    ok(`sweep ${cfg.sweep}° pivot ${cfg.pivot}: every cell lands inside the design`, inside)
  }

  // Landmarks a person can check against a drawing.
  const half = createSweepWarp({ enabled: true, startAngle: 0, sweep: 180, pivot: 0 })
  // Pointing straight up mid-sweep must show the *top* of the drawing, not the
  // bottom. Getting this backwards renders every corrected project upside down.
  half(1, 0.5, out)
  ok('tip pointing up shows the top of the design',
     near(out[0], 0.5, 1e-12) && near(out[1], 0, 1e-12), out.join(', '))
  half(1, 0, out)
  ok('tip pointing right shows the right edge, at the bottom',
     near(out[0], 1, 1e-12) && near(out[1], 1, 1e-12), out.join(', '))
  // Base and tip at the same instant must differ only in radius, not in row.
  half(0.2, 0.5, out)
  const near1 = [...out]
  half(0.9, 0.5, out)
  ok('further along the stick is further up the design at mid-sweep',
     out[1] < near1[1], `${out[1]} < ${near1[1]}`)

  // Reversing the sign must mirror the result, since it is the same arc travelled
  // the other way.
  const fwd = createSweepWarp({ enabled: true, startAngle: 0, sweep: 180, pivot: 0 })
  const back = createSweepWarp({ enabled: true, startAngle: 0, sweep: -180, pivot: 0 })
  fwd(1, 0.25, out)
  const a = [...out]
  back(1, 0.25, out)
  ok('a negative sweep turns the other way', near(out[1], -a[1] + 1, 1e-12) || near(out[1], 1 - a[1], 1e-12))

  // Off by default, and a project without the field loads with it off.
  ok('correction is off by default', createProject('x').sweep.enabled === false)
  ok('a project predating it loads with it off',
     sanitiseProject({ id: 'p', name: 'p', layers: [] }).sweep.enabled === false)
  ok('sweep values are clamped',
     sanitiseProject({ id: 'p', name: 'p', layers: [], sweep: { enabled: true, sweep: 9999, pivot: 5 } })
       .sweep.sweep === 720)

  // Enabling it must actually change the render, and leave it alone when off.
  const base = solidProject()
  const painted = { ...base, sweep: { enabled: true, startAngle: 0, sweep: 180, pivot: 0 } }
  ok('a solid layer is unchanged by the warp',
     evaluateField(painted).data.every((v, i) => near(v, evaluateField(base).data[i])))
}


// --- the rotate path matches the sweep correction -------------------------
{
  // The 3D preview only tells you anything about the correction if the two use
  // the same geometry. Rotate must place LEDs exactly where createSweepWarp
  // assumes they go.
  const cfg = { enabled: true, startAngle: 25, sweep: -140, pivot: 0.3 }
  const p: PathParams = {
    ...DEFAULT_PATH, kind: 'rotate', arc: cfg.sweep, pivot: cfg.pivot,
    startAngle: cfg.startAngle, mirror: false,
  }
  const pose3: Pose = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 1, dz: 0 }
  const DEG = Math.PI / 180

  let worst = 0
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    for (const u of [0, 0.3, 0.7, 1]) {
      poseAt(p, t, pose3)
      // Where the preview puts this LED, relative to the pivot.
      const px = pose3.ox + pose3.dx * u - 0
      const py = pose3.oy + pose3.dy * u - cfg.pivot
      // Where the correction's model says it goes.
      const phi = (cfg.startAngle + cfg.sweep * t) * DEG
      const r = u - cfg.pivot
      worst = Math.max(worst, Math.abs(px - r * Math.cos(phi)), Math.abs(py - r * Math.sin(phi)))
    }
  }
  ok('rotate agrees with the sweep correction', worst < 1e-12, worst.toExponential(1))
  ok('rotate stays in one plane',
     [0, 0.4, 1].every((t) => { poseAt(p, t, pose3); return Math.abs(pose3.dz) < 1e-12 }))

  // The default must show something. Spin at zero tilt does not.
  const dflt = { ...DEFAULT_PATH }
  poseAt(dflt, 0, pose3)
  const a = { ...pose3 }
  poseAt(dflt, 0.5, pose3)
  ok('the default path actually moves',
     Math.hypot(pose3.dx - a.dx, pose3.dy - a.dy, pose3.dz - a.dz) > 0.5)
  ok('spin no longer defaults to a degenerate tilt', DEFAULT_PATH.tilt > 0)
}

console.log(out.join('\n'))
const passed = out.filter((r) => r.startsWith('PASS')).length
console.log(`\n${passed}/${out.length} passed`)
process.exit(passed === out.length ? 0 : 1)

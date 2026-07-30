// Render checks: `npm run check`.
//
// Not a full test suite — it covers the parts where a mistake is silent rather
// than loud: curve interpolation, schema migration, and the arithmetic that
// turns a pattern or a brightness curve into pixels. Those are hard to eyeball
// on a 144x125 canvas and easy to get subtly wrong.
//
// Run through vite-node so the imports resolve the way the app sees them.

import { createProject, flatCurve, isFlatCurve, sampleCurve, axisExtent, createLayer } from './src/model/project'
import { sanitiseProject, SCHEMA_VERSION } from './src/model/storage'
import { evaluateField } from './src/render/field'
import { BRIGHTNESS_POINTS } from './src/model/types'
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

console.log(out.join('\n'))
const passed = out.filter((r) => r.startsWith('PASS')).length
console.log(`\n${passed}/${out.length} passed`)
process.exit(passed === out.length ? 0 : 1)

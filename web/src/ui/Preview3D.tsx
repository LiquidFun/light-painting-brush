// The photograph in three dimensions (REQUIREMENTS §6.8).
//
// The 2D canvas assumes one specific sweep: straight, level, constant speed. This
// shows the same animation swept the ways people actually move a stick — spun,
// corkscrewed, walked — by placing every LED of every frame where it would
// physically be and letting the exposure accumulate.
//
// Loaded on demand. three.js is ~600 KB and most sessions never open this, so it
// is behind a dynamic import and Vite splits it into its own chunk.

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import type { Field } from '../render/field'
import { DEFAULT_PATH, PATH_KINDS, STICK_LENGTH, poseAt, usedParams } from '../render/paths'
import type { PathKind, PathParams, Pose } from '../render/paths'
import { Button, Field as FormField, Row, Slider } from './primitives'

/**
 * Points beyond this are dropped by taking every Nth frame. A minute at 60 fps is
 * 830k points, which draws fine but allocates 20 MB of attributes on every
 * parameter change — and a preview does not need every frame to read correctly.
 */
const MAX_POINTS = 250_000

export function Preview3D({ field }: { field: Field }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [path, setPath] = useState<PathParams>(DEFAULT_PATH)
  const [exposure, setExposure] = useState(1)

  // The scene outlives parameter changes; only the geometry is rebuilt.
  const three = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    points: THREE.Points
    geometry: THREE.BufferGeometry
    material: THREE.PointsMaterial
  } | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 1)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
    camera.position.set(2.6, 1.4, 2.6)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0.5, 0)

    const geometry = new THREE.BufferGeometry()
    const material = new THREE.PointsMaterial({
      size: 0.012,
      vertexColors: true,
      // Light adds to light, which is the whole premise of the photograph.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      sizeAttenuation: true,
    })
    const points = new THREE.Points(geometry, material)
    scene.add(points)

    // A floor grid, so a spin reads as a spin rather than as a flat smear.
    const grid = new THREE.GridHelper(4, 8, 0x333333, 0x1a1a1a)
    ;(grid.material as THREE.Material).opacity = 0.4
    ;(grid.material as THREE.Material).transparent = true
    scene.add(grid)

    three.current = { renderer, scene, camera, controls, points, geometry, material }

    let raf = 0
    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    resize()

    const tick = () => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      controls.dispose()
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      three.current = null
    }
  }, [])

  // Rebuild the point cloud when the animation or the path changes.
  const cloud = useMemo(() => {
    const { width, height, data } = field
    const step = Math.max(1, Math.ceil((width * height) / MAX_POINTS))
    const frames = Math.ceil(height / step)
    const count = frames * width
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const pose: Pose = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 1, dz: 0 }

    let n = 0
    for (let f = 0; f < frames; f++) {
      const y = Math.min(height - 1, f * step)
      poseAt(path, height > 1 ? y / (height - 1) : 0, pose)
      const row = y * width * 3
      for (let x = 0; x < width; x++) {
        // LED 0 sits at the base of the stick, matching the hardware.
        const along = (x / Math.max(1, width - 1)) * STICK_LENGTH
        positions[n * 3] = pose.ox + pose.dx * along
        positions[n * 3 + 1] = pose.oy + pose.dy * along
        positions[n * 3 + 2] = pose.oz + pose.dz * along
        colors[n * 3] = data[row + x * 3]
        colors[n * 3 + 1] = data[row + x * 3 + 1]
        colors[n * 3 + 2] = data[row + x * 3 + 2]
        n++
      }
    }
    return { positions, colors, count, step }
  }, [field, path])

  useEffect(() => {
    const ctx = three.current
    if (!ctx) return
    ctx.geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    ctx.geometry.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3))
    ctx.geometry.computeBoundingSphere()
  }, [cloud])

  useEffect(() => {
    const ctx = three.current
    if (ctx) ctx.material.opacity = exposure
  }, [exposure])

  const used = usedParams(path.kind)
  const set = (patch: Partial<PathParams>) => setPath((p) => ({ ...p, ...patch }))

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div ref={mountRef} className="min-h-0 flex-1 touch-none bg-bg" />

      <div className="max-h-[45%] shrink-0 space-y-3 overflow-y-auto border-t border-line bg-panel p-3 lg:max-h-none lg:w-[300px] lg:border-l lg:border-t-0">
        <FormField
          label="Sweep"
          hint={PATH_KINDS.find((k) => k.id === path.kind)?.note}
        >
          <select
            value={path.kind}
            onChange={(e) => set({ kind: e.target.value as PathKind })}
          >
            {PATH_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </FormField>

        {used.includes('turns') && (
          <Slider
            label="Turns"
            value={Math.round(path.turns * 4)}
            min={1}
            max={40}
            display={`${path.turns.toFixed(2)}×`}
            onChange={(v) => set({ turns: v / 4 })}
          />
        )}
        {used.includes('arc') && (
          <Slider
            label="Arc"
            value={path.arc}
            min={-720}
            max={720}
            display={`${path.arc}°`}
            hint="Match this to the project's sweep correction to see it come out straight."
            onChange={(arc) => set({ arc })}
          />
        )}
        {used.includes('pivot') && (
          <Slider
            label="Pivot"
            value={Math.round(path.pivot * 100)}
            min={0}
            max={100}
            display={path.pivot === 0 ? 'at the base' : `${Math.round(path.pivot * 100)}% along`}
            hint="Where your hand is on the stick."
            onChange={(v) => set({ pivot: v / 100 })}
          />
        )}
        {used.includes('swing') && (
          <Slider
            label="Swing"
            value={path.swing}
            min={10}
            max={340}
            display={`${path.swing}°`}
            onChange={(swing) => set({ swing })}
          />
        )}
        {used.includes('tilt') && (
          <Slider
            label="Tilt"
            value={path.tilt}
            min={0}
            max={90}
            display={path.tilt === 0 ? 'upright' : `${path.tilt}°`}
            hint={path.kind === 'circle' ? 'At 0° a spin traces a line, not a disc.' : undefined}
            onChange={(tilt) => set({ tilt })}
          />
        )}
        {used.includes('distance') && (
          <Slider
            label="Distance"
            value={Math.round(path.distance * 10)}
            min={0}
            max={80}
            display={`${path.distance.toFixed(1)} m`}
            onChange={(v) => set({ distance: v / 10 })}
          />
        )}
        {used.includes('wobble') && (
          <Slider
            label="Wobble"
            value={Math.round(path.wobble * 100)}
            min={0}
            max={60}
            display={`${(path.wobble * 100).toFixed(0)} cm`}
            onChange={(v) => set({ wobble: v / 100 })}
          />
        )}
        {used.includes('seed') && (
          <Slider
            label="Seed"
            value={path.seed}
            min={1}
            max={64}
            display={String(path.seed)}
            onChange={(seed) => set({ seed })}
          />
        )}

        <Slider
          label="Start angle"
          value={path.startAngle}
          min={0}
          max={359}
          display={`${path.startAngle}°`}
          hint={
            path.kind === 'sweep' || path.kind === 'wander'
              ? 'Which way the walk heads.'
              : 'Where in the rotation the animation begins.'
          }
          onChange={(startAngle) => set({ startAngle })}
        />

        <Row>
          <Button active={path.mirror} onClick={() => set({ mirror: !path.mirror })}>
            {path.mirror ? 'Mirrored' : 'Mirror'}
          </Button>
        </Row>

        <Slider
          label="Exposure"
          value={Math.round(exposure * 100)}
          min={5}
          max={100}
          display={`${Math.round(exposure * 100)}%`}
          hint="Brightness of the accumulated light, not of the animation."
          onChange={(v) => setExposure(v / 100)}
        />

        <p className="num text-xs text-mute">
          {cloud.count.toLocaleString()} points
          {cloud.step > 1 && ` · every ${cloud.step}${cloud.step === 2 ? 'nd' : 'th'} frame`}
        </p>
        <p className="text-xs text-mute">
          Drag to orbit, pinch or scroll to zoom. The stick is 1 m with LED 0 at the
          base, and every frame is drawn where it would physically have been.
        </p>
      </div>
    </div>
  )
}

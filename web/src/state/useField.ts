// Re-renders the field on an animation frame after every project change, so a
// drag coalesces into at most one evaluation per frame.
//
// For 144 x 375 cells this is a few hundred thousand operations and stays
// interactive without WebGL. If that stops being true, move this into a Web
// Worker before reaching for shaders.

import { useEffect, useState } from 'react'

import { evaluateField } from '../render/field'
import type { Field } from '../render/field'
import type { Project } from '../model/types'

export function useField(project: Project): Field {
  const [field, setField] = useState<Field>(() => evaluateField(project))

  useEffect(() => {
    const raf = requestAnimationFrame(() => setField(evaluateField(project)))
    return () => cancelAnimationFrame(raf)
  }, [project])

  return field
}

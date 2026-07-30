// The project library (REQUIREMENTS §6.11), on its own tab.
//
// Split out of the project settings panel: they were two unrelated jobs sharing
// one scroll, and picking a project meant scrolling past every slider first.

import { useRef } from 'react'

import { formatSeconds } from '../model/project'
import { downloadJson, parseImport, slug, toExportFile } from '../model/storage'
import type { LibrarySync } from '../model/library'
import type { Project } from '../model/types'
import { Button, Panel, Row } from './primitives'
import { ProjectThumb } from './ProjectThumb'

const SYNC_NOTE: Record<LibrarySync, string> = {
  loading: 'Checking the shared library on the server…',
  saving: 'Saving to the shared library…',
  synced: 'Saved here and in the shared library on the server.',
  offline:
    'Saved in this browser only — the server could not be reached. It will not sync until you reload with a connection.',
  idle: 'Saved in this browser.',
}

export function LibraryPanel({
  project,
  library,
  librarySync,
  onOpen,
  onNew,
  onDelete,
  onImport,
}: {
  project: Project
  library: Project[]
  librarySync: LibrarySync
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onImport: (projects: Project[]) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  const importFile = async (file: File) => {
    const { projects, error } = parseImport(await file.text())
    if (error) {
      window.alert(error)
      return
    }
    onImport(projects)
  }

  return (
    <>
      <Panel title="Library">
        <ul className="space-y-1">
          {library.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onOpen(p.id)}
                className={[
                  'flex min-h-11 flex-1 items-center gap-2 rounded border px-2 py-1 text-left text-sm',
                  p.id === project.id
                    ? 'border-fg bg-raised text-fg font-medium'
                    : 'border-line bg-panel text-dim active:bg-raised',
                ].join(' ')}
              >
                <ProjectThumb project={p} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="num block truncate text-xs text-mute">
                    {formatSeconds(p.durationMs)} · {p.layers.length} layers
                  </span>
                </span>
              </button>
              <Button
                onClick={() => {
                  if (window.confirm(`Delete "${p.name}"? This cannot be undone.`)) {
                    onDelete(p.id)
                  }
                }}
                title={`Delete ${p.name}`}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>

        <Row>
          <Button onClick={onNew}>New</Button>
          <Button
            onClick={() =>
              downloadJson(`${slug(project.name)}.lightstick.json`, toExportFile([project], true))
            }
          >
            Export
          </Button>
          <Button
            onClick={() =>
              downloadJson('lightstick-library.json', toExportFile(library, false))
            }
          >
            Export all
          </Button>
          <Button onClick={() => fileRef.current?.click()}>Import</Button>
        </Row>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importFile(file)
            e.target.value = ''
          }}
        />
        <p className="text-xs text-mute">
          One shared library: everybody with the password sees and can edit these.
          {' '}
          {SYNC_NOTE[librarySync]}
        </p>
      </Panel>
    </>
  )
}

// The shared project library (REQUIREMENTS §5.1): a directory of JSON files, one
// per project. A database is not warranted for a handful of documents that are
// only ever read and written whole.
//
// The server does not understand the project schema and deliberately does not
// validate it — the editor already sanitises everything it loads, and a server
// that knows the schema is a server that has to be redeployed to change it.

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Also the filename, so it must not be able to escape the directory. */
const ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Projects embed images as data URLs (§6.6), so they are much bigger than plain
 * JSON. 8 MB is generous for that and still refuses an accidental upload.
 */
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024

export const isValidId = (id: string): boolean => ID.test(id)

export class Library {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'projects')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }

  /** Every project in the library. Unreadable files are skipped, not fatal. */
  async list(): Promise<unknown[]> {
    const names = await readdir(this.dir)
    const projects: unknown[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        projects.push(JSON.parse(await readFile(path.join(this.dir, name), 'utf8')))
      } catch (err) {
        console.warn(`[library] skipping ${name}: ${String(err)}`)
      }
    }
    return projects
  }

  /** Write via a temp file and rename, so a crash cannot leave half a project. */
  async put(id: string, body: string): Promise<void> {
    const target = this.file(id)
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, body, 'utf8')
    await rename(temp, target)
  }

  /** Returns false if there was nothing to delete. */
  async remove(id: string): Promise<boolean> {
    try {
      await unlink(this.file(id))
      return true
    } catch {
      return false
    }
  }
}

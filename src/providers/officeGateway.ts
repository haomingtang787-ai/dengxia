import fs from 'node:fs'
import { MESSAGES } from '../shared/constants'
import type { OfficePlan } from '../documents/parseTypes'
import { findExistingCandidate } from './libreoffice'
import { windowsOfficeIsolation } from './isolation'
import type { SavedSettings } from './settings'

export type OfficeDescription = {
  path: string | null
  fileFound: boolean
}

export interface OfficeGateway {
  describe(settings: SavedSettings): Promise<OfficeDescription>
}

export function planOfficeConversion(description: OfficeDescription): OfficePlan {
  if (!description.fileFound || !description.path) {
    return { mode: 'skip', code: 'CONVERTER_MISSING', message: MESSAGES.converterMissing }
  }
  const isolation = windowsOfficeIsolation()
  if (!isolation.verified) {
    return { mode: 'skip', code: 'CONVERSION_FAILED', message: isolation.reason }
  }
  return { mode: 'convert', executable: description.path }
}

export class LocalOfficeGateway implements OfficeGateway {
  async describe(settings: SavedSettings): Promise<OfficeDescription> {
    if (settings.libreOfficePath) {
      return { path: settings.libreOfficePath, fileFound: fileExists(settings.libreOfficePath) }
    }
    const found = findExistingCandidate()
    return { path: found, fileFound: Boolean(found) }
  }
}

function fileExists(file: string): boolean {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

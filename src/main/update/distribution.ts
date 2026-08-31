// Runtime read of the packaged distribution metadata (T39). The file sits in
// the packaged resources directory beside app.asar; anything missing or
// malformed reads as null, and null means personal: no updater, ever.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DISTRIBUTION_METADATA_FILE,
  type DistributionMetadata,
  parseDistributionMetadata
} from '../../shared/distribution'

export function readDistributionMetadata(resourcesPath: string): DistributionMetadata | null {
  try {
    return parseDistributionMetadata(
      JSON.parse(readFileSync(join(resourcesPath, DISTRIBUTION_METADATA_FILE), 'utf8'))
    )
  } catch {
    return null
  }
}

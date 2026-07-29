// Picks which transport is live (REQUIREMENTS §7, M4).
//
// Both hooks always run — React forbids conditional hooks — but only the chosen
// one opens a connection, so the idle transport costs nothing but an object.
// This exists so that BLE stays usable until the WiFi path has been flashed and
// proven on hardware; after that, this file and web/src/ble/ both go.

import { useDevice } from '../ble/useDevice'
import { useRelay } from '../transport/useRelay'
import type { Transport } from '../transport/types'

export type TransportKind = 'relay' | 'ble'

export function useTransport(kind: TransportKind): Transport {
  const relay = useRelay(kind === 'relay')
  const ble = useDevice()
  return kind === 'ble' ? ble : relay
}

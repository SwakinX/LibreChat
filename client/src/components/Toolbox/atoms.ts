import { atom } from 'jotai';
import { createStorageAtom } from '~/store/jotai-utils';

/**
 * Persistent pairing code for the local Toolhost. Saved optimistically on
 * submit (there is no verify endpoint) — validity is only proven by the next
 * mutation; a 403 clears the atom and flips {@link pairingRejectedAtom}.
 */
export const pairingCodeAtom = createStorageAtom<string>('toolbox:pairing-code', '');

/** Ephemeral: the stored code was rejected (403) — the status chip shows the
 * rotated-code hint until a new code is saved. */
export const pairingRejectedAtom = atom(false);

/** Sidebar group collapse state. Same key and JSON shape as the previous
 * useLocalStorage value, so existing saved state carries over unchanged. */
export const groupsExpandedAtom = createStorageAtom<Record<string, boolean>>(
  'toolbox:groups-expanded',
  {},
);

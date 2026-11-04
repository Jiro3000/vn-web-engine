import {writable} from 'svelte/store';
import type {RecordStore} from '../../src/platform/store.js';
import type {SaveFilesAdapter} from '../player/save-files.js';
export const yurisSaveAdapter = writable<SaveFilesAdapter>(adapter(null));
function adapter(store: RecordStore | null): SaveFilesAdapter {
  return {
    accept: '.dat,.sav',
    unavailable: store ? null : 'Open a game folder to manage saves.',
    emptyLabel: 'No browser saves yet',
    async list() {
      return [...(await store!.snapshot()).keys()]
        .filter((k) => k.startsWith('file:'))
        .map((k) => ({id: k, label: k.slice(6)}));
    },
    async read(id) {
      const bytes = (await store!.snapshot()).get(id);
      if (!bytes) throw new Error('Save file not found');
      return {name: id.slice(id.lastIndexOf('/') + 1), bytes};
    },
    async import(name, bytes) {
      if (/[\\/]/.test(name) || name === '..') throw new Error('Invalid save name');
      const id = 'file:/' + name.toLowerCase();
      await store!.update((r) => {
        r.set(id, bytes.slice());
      });
      return {id, message: `${name} imported.`};
    },
  };
}
export function setYurisSaveStore(store: RecordStore | null): void {
  yurisSaveAdapter.set(adapter(store));
}

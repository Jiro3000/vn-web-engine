import type {ArtemisVariables} from './variables.js';

export interface ArtemisSaveEffects {
  /** Native onSave is called only for a nonempty scenario filename, before its snapshot. */
  beforeScenario(file: string): void;
  reportEventError(error: unknown): void;
  writeScenario(file: string, includeTransientState: boolean): void;
  writeGlobal(): void;
  writeSystem(): void;
}

/** 0x14013f390 save gate. Serialization/storage remain required host services. */
export class ArtemisSave {
  constructor(
    private readonly variables: ArtemisVariables,
    private readonly effects: ArtemisSaveEffects,
  ) {}
  request(file: string, includeTransientState = false, forceGlobal = false): boolean {
    if (!file && !forceGlobal && !this.variables.globalDirty) return false;
    if (file) {
      try {
        this.effects.beforeScenario(file);
      } catch (error) {
        this.effects.reportEventError(error);
      }
      this.effects.writeScenario(file, includeTransientState);
    }
    if (forceGlobal || this.variables.globalDirty) {
      this.effects.writeGlobal();
      // Native clears g. dirty immediately after saveg.dat, before writing system.dat.
      this.variables.clearGlobalDirty();
      this.effects.writeSystem();
    }
    return true;
  }
}

/**
 * Director shared state — isolated module with no imports to avoid circular dependency issues.
 *
 * The foreman scheduler needs to check directorBusy, and the director scheduler
 * needs to set it. Putting this in scheduler.ts caused module identity issues
 * when the foreman imported it via a circular dep chain.
 */

let _directorBusy = false;
let _planningInProgress = false;

export function isDirectorBusy(): boolean { return _directorBusy; }
export function setDirectorBusy(v: boolean): void { _directorBusy = v; }

export function isDirectorPlanning(): boolean { return _planningInProgress; }
export function setDirectorPlanning(v: boolean): void { _planningInProgress = v; }

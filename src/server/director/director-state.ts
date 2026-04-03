/**
 * Director shared state — isolated module with no imports to avoid circular dependency issues.
 *
 * The foreman scheduler needs to check which machine the director is using,
 * and the director scheduler needs to set it. This module has zero imports
 * to prevent circular dependency / module identity issues.
 */

let _planningInProgress = false;

/** Machine ID currently reserved by the director (null = director idle). */
let _reservedMachineId: string | null = null;

export function getDirectorReservedMachine(): string | null { return _reservedMachineId; }
export function setDirectorReservedMachine(machineId: string | null): void { _reservedMachineId = machineId; }

/** Legacy check — returns true if director has reserved any machine. */
export function isDirectorBusy(): boolean { return _reservedMachineId !== null; }

export function isDirectorPlanning(): boolean { return _planningInProgress; }
export function setDirectorPlanning(v: boolean): void { _planningInProgress = v; }

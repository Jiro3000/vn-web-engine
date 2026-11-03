/**
 * A script error. The native reporters 0x46C2BC/0x46C25C look the code up in the `YSER`
 * table, format it with the arguments, prefix the script file and line (0x46C314), set the
 * quit flag 0x87260C and show the `IDD_YSE` dialog: every script error ends the program.
 */
export class YurisError extends Error {
  constructor(
    readonly code: number,
    readonly args: readonly (number | bigint | string)[] = [],
  ) {
    super(`YU-RIS error ${code}`);
    this.name = 'YurisError';
  }
}

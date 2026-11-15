// mpd-parser ships no type declarations. MpdParser narrows the result to the
// fields it reads.
declare module "mpd-parser" {
  export function parse(
    manifestString: string,
    options?: { manifestUri?: string },
  ): unknown;
}

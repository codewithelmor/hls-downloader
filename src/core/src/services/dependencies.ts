import { IDecryptor, IFS, ILoader, IParser, IPlayerCapture } from ".";

export type Dependencies = {
  loader: ILoader;
  decryptor: IDecryptor;
  parser: IParser;
  fs: IFS;
  /** Absent where the browser cannot inject page scripts (e.g. in tests). */
  playerCapture?: IPlayerCapture;
};

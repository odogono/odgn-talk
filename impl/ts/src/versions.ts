import { costModel, languageVersion } from './generated/machine';
import { unicodeVersion } from './generated/unicode';
import { saveFormatVersion } from './snapshot';

export type Versions = {
  core: string;
  costModel: string;
  language: string;
  saveFormat: string;
  unicode: string;
};

export const coreVersions: Versions = Object.freeze({
  language: languageVersion,
  costModel: String(costModel.version),
  unicode: unicodeVersion,
  core: 'ts/0.1.0',
  saveFormat: String(saveFormatVersion),
});

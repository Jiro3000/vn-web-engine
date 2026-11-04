import {hasSignedFile, type InstallationRecognizer} from '../../platform/installation-detection.js';
export const isYurisInstallation: InstallationRecognizer = (files) =>
  hasSignedFile(files, /(?:^|[\\/])pac[\\/][^\\/]+\.ypf$/i, ['YPF\0']);

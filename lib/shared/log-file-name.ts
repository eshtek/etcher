/**
 * Name of the session log, shared between the main process that writes it and
 * the renderer that tells users where to find it. Kept in its own module so
 * the renderer can have the name without importing the writer, which reaches
 * for main-process-only Electron APIs.
 */
export const LOG_FILE_NAME = 'hexos-imager.log';

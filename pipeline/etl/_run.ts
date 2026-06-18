// Unico helper condiviso dell'ETL.
// `isMain` distingue "stadio lanciato da solo" da "stadio importato dalla pipeline":
// così ogni file-stadio è ESEGUIBILE STANDALONE (per testarlo) e al tempo stesso
// IMPORTABILE dall'orchestratore senza eseguirsi due volte.
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

export const isMain = (importMetaUrl: string): boolean => {
  try {
    return fileURLToPath(importMetaUrl) === argv[1];
  } catch {
    return false;
  }
};

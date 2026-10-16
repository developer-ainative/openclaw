import fs from "node:fs";
import { hasErrnoCode } from "./errno.js";
import { backupLegacyStateSource } from "./state-migrations.source-backup.js";
import type { MigrationMessages } from "./state-migrations.types.js";

/** Doctor preserves retired bytes through the same backup owner as supported imports. */
export async function archiveRetiredStateFiles(params: {
  label: string;
  paths: readonly string[];
  assertCurrent: () => void;
  recoveryInstructions?: string;
}): Promise<MigrationMessages> {
  const result: MigrationMessages = { changes: [], warnings: [] };
  for (const filePath of new Set(params.paths)) {
    try {
      fs.lstatSync(filePath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const backup = await backupLegacyStateSource({
      filePath,
      assertCurrent: params.assertCurrent,
    });
    backup.removeSource(() => undefined);
    result.changes.push(`Archived retired ${params.label}: ${filePath} → ${backup.backupPath}`);
    result.warnings.push(
      `${params.label}: original bytes are preserved at ${backup.backupPath}. ${params.recoveryInstructions ?? "This transient state is no longer used and will be rebuilt when needed."}`,
    );
  }
  return result;
}

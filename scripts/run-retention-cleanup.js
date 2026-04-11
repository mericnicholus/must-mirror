const fs = require('fs');
const path = require('path');
const database = require('../database.js');

const projectRoot = path.resolve(__dirname, '..');
const uploadsRoot = path.join(projectRoot, 'uploads');
const retentionDays = Math.max(1, Number(process.env.DATA_RETENTION_DAYS || process.argv[2] || 30));

function deleteFeedbackFiles(relativePaths = []) {
  const deletedFiles = [];

  for (const relativePath of relativePaths) {
    if (!relativePath) continue;
    const normalizedPath = String(relativePath).replace(/^\/+/, '');
    const absolutePath = path.join(projectRoot, normalizedPath);
    if (!absolutePath.startsWith(uploadsRoot)) continue;

    try {
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
        deletedFiles.push(relativePath);
      }
    } catch (error) {
      console.error(`Failed to delete feedback upload ${relativePath}:`, error.message);
    }
  }

  return deletedFiles;
}

async function main() {
  try {
    await database.initialize();
    const summary = await database.purgeExpiredData(retentionDays);
    const deletedFiles = deleteFeedbackFiles(summary.screenshotPaths || []);

    console.log('Retention cleanup completed successfully.');
    console.log(`Retention days: ${summary.retentionDays}`);
    console.log(`Cutoff date: ${summary.cutoffDate}`);
    console.log('Deleted rows:', summary.deleted);
    console.log(`Deleted feedback uploads: ${deletedFiles.length}`);
  } catch (error) {
    console.error('Retention cleanup failed:', error);
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

main();

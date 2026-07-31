import {
  CAPTAIN_HEADERS,
  DATA_QUALITY_HEADERS,
  captainToRow,
  detectDataQualityIssues,
  fetchAirtableCaptains,
  normalizeAirtableCaptain,
  rowToCaptain,
} from './airtable';
import {
  appendSheetRow,
  ensureWorkbookSheets,
  readSheetRows,
  replaceSheetRows,
} from './google-sheets';

export async function syncAirtableCaptains() {
  const startedAt = Date.now();
  const syncedAt = new Date().toISOString();

  const [{ created: createdSheets }, records] = await Promise.all([
    ensureWorkbookSheets(),
    fetchAirtableCaptains(),
  ]);

  const existingRows = await readSheetRows('Captains', CAPTAIN_HEADERS.length);
  const existingCaptains = existingRows
    .map(rowToCaptain)
    .filter((captain) => captain.airtable_record_id);

  const activeCaptains = records.map((record) => normalizeAirtableCaptain(record, syncedAt));
  const activeRecordIds = new Set(
    activeCaptains.map((captain) => captain.airtable_record_id)
  );

  const inactiveCaptains = existingCaptains
    .filter((captain) => !activeRecordIds.has(captain.airtable_record_id))
    .map((captain) => ({
      ...captain,
      synced_at: syncedAt,
      is_active: 'FALSE',
    }));

  const allCaptains = [...activeCaptains, ...inactiveCaptains].sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active === 'TRUE' ? -1 : 1;
    return String(a.full_name).localeCompare(String(b.full_name));
  });

  const qualityIssues = detectDataQualityIssues(activeCaptains, syncedAt);
  const issueCounts = qualityIssues.reduce((counts, issue) => {
    const type = issue[1];
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});

  await replaceSheetRows(
    'Captains',
    CAPTAIN_HEADERS,
    allCaptains.map(captainToRow)
  );
  await replaceSheetRows('Data Quality', DATA_QUALITY_HEADERS, qualityIssues);

  const durationMs = Date.now() - startedAt;
  await appendSheetRow('Sync Log', [
    syncedAt,
    'airtable',
    'success',
    records.length,
    activeCaptains.length,
    inactiveCaptains.length,
    qualityIssues.length,
    durationMs,
    createdSheets.length
      ? `Initialized sheets: ${createdSheets.join(', ')}`
      : 'Roster synchronized',
  ]);

  return {
    syncedAt,
    recordsFetched: records.length,
    activeCaptains: activeCaptains.length,
    inactiveCaptains: inactiveCaptains.length,
    issuesFound: qualityIssues.length,
    issueCounts,
    createdSheets,
    durationMs,
  };
}

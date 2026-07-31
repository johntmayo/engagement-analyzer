/**
 * Seeds Dashboard Access Source from Captains.dashboard_gmail for local E2E
 * testing when USER_ACCESS_SHEET_ID is not available.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) return;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value.replace(/\\n/g, '\n');
  });
}

function quoteSheetTitle(title) {
  return `'${title.replace(/'/g, "''")}'`;
}

async function main() {
  loadEnv();
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!spreadsheetId || !email || !privateKey) {
    throw new Error('Missing Google Sheets configuration in .env.local');
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const workbook = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const titles = new Set(
    (workbook.data.sheets || []).map((sheet) => sheet.properties.title)
  );
  const needed = [
    'Dashboard Access Source',
    'Dashboard Access',
    'Dashboard Match Review',
    'Email Events',
  ];
  const missing = needed.filter((title) => !titles.has(title));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missing.map((title) => ({
          addSheet: { properties: { title } },
        })),
      },
    });
  }

  const sourceHeaders = [
    'login_email',
    'sheet_url',
    'zone_name',
    'captain_display_name',
    'contact_email',
    'role',
    'active',
    'date_added',
    'notes',
    'last_seen_at',
    'login_count',
  ];
  const captainRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetTitle('Captains')}!A1:T`,
  });
  const captainValues = captainRes.data.values || [];
  const captainHeaders = (captainValues[0] || []).map((value) =>
    String(value || '').trim()
  );
  const emailIdx = captainHeaders.indexOf('dashboard_gmail');
  const nameIdx = captainHeaders.indexOf('full_name');
  const zoneIdx = captainHeaders.indexOf('zones');
  const primaryEmailIdx = captainHeaders.indexOf('email');
  const activeIdx = captainHeaders.indexOf('is_active');
  if (emailIdx < 0) throw new Error('Captains sheet missing dashboard_gmail');

  const now = new Date().toISOString();
  const sample = captainValues
    .slice(1)
    .filter((row) => {
      const active = String(row[activeIdx] || 'TRUE').toUpperCase() !== 'FALSE';
      return active && String(row[emailIdx] || '').trim();
    })
    .slice(0, 25)
    .map((row, index) => [
      String(row[emailIdx]).trim().toLowerCase(),
      '',
      String(row[zoneIdx] || '').split('|')[0] || '',
      row[nameIdx] || '',
      row[primaryEmailIdx] || '',
      'captain',
      'TRUE',
      now.slice(0, 10),
      'seeded from Captains.dashboard_gmail for Analyzer E2E',
      index < 15 ? now : '',
      String(index < 15 ? (index % 5) + 1 : 0),
    ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${quoteSheetTitle('Dashboard Access Source')}!A:K`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetTitle('Dashboard Access Source')}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [sourceHeaders, ...sample] },
  });

  console.log(JSON.stringify({
    ok: true,
    seeded: sample.length,
    withLastSeen: sample.filter((row) => row[9]).length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

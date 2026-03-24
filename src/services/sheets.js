const { google } = require('googleapis');
const { getOAuth2Client } = require('./google-auth');

async function getSheetsApi() {
  return google.sheets({ version: 'v4', auth: getOAuth2Client() });
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = Math.pow(2, i) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Build range with optional sheet name: "SheetName!A:K" or just "A:K"
function r(sheetName, range) {
  if (sheetName) return `'${sheetName}'!${range}`;
  return range;
}

// Find the sheetId (for row deletion) by sheet name instead of assuming first tab
async function getSheetId(sheetsApi, spreadsheetId, sheetName) {
  const meta = await withRetry(() =>
    sheetsApi.spreadsheets.get({ spreadsheetId })
  );
  if (sheetName) {
    const sheet = meta.data.sheets.find((s) => s.properties.title === sheetName);
    if (sheet) return sheet.properties.sheetId;
  }
  // Fallback to first sheet
  return meta.data.sheets[0].properties.sheetId;
}

async function appendRow(spreadsheetId, values, sheetName) {
  const sheets = await getSheetsApi();
  return withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: r(sheetName, 'A:K'),
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [values],
      },
    })
  );
}

async function getAllRows(spreadsheetId, sheetName) {
  const sheets = await getSheetsApi();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: r(sheetName, 'A:K'),
    })
  );
  return res.data.values || [];
}

// Columns: [0]=PROSPECTEUR [1]=VEHICULE [2]=CLIENT [3]=TELEPHONE [4]=DATE [5]=HEURE [6]=CONFIRMATION [7]=STATUT [8]=EVENT_ID [9]=UPDATED_AT [10]=CONF_PAR
const COL = { PROSPECTEUR: 0, VEHICULE: 1, CLIENT: 2, TELEPHONE: 3, DATE: 4, HEURE: 5, CONFIRMATION: 6, STATUT: 7, EVENT_ID: 8, UPDATED_AT: 9, CONF_PAR: 10 };

async function findRow(spreadsheetId, clientName, date, heure, sheetName) {
  const rows = await getAllRows(spreadsheetId, sheetName);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (
      row[COL.CLIENT] &&
      row[COL.CLIENT].toLowerCase() === clientName.toLowerCase() &&
      (!date || row[COL.DATE] === date) &&
      (!heure || row[COL.HEURE] === heure)
    ) {
      return { index: i, row };
    }
  }
  return null;
}

async function findRowByClient(spreadsheetId, clientName, sheetName) {
  const rows = await getAllRows(spreadsheetId, sheetName);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row[COL.CLIENT] && row[COL.CLIENT].toLowerCase() === clientName.toLowerCase()) {
      return { index: i, row };
    }
  }
  return null;
}

async function updateRow(spreadsheetId, rowIndex, values, sheetName) {
  const sheets = await getSheetsApi();
  const range = r(sheetName, `A${rowIndex + 1}:K${rowIndex + 1}`);
  return withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [values],
      },
    })
  );
}

async function updateCell(spreadsheetId, rowIndex, colIndex, value, sheetName) {
  const sheets = await getSheetsApi();
  const colLetter = String.fromCharCode(65 + colIndex);
  const range = r(sheetName, `${colLetter}${rowIndex + 1}`);
  return withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[value]],
      },
    })
  );
}

async function deleteRow(spreadsheetId, rowIndex, sheetName) {
  const sheets = await getSheetsApi();
  const sheetId = await getSheetId(sheets, spreadsheetId, sheetName);

  return withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex,
                endIndex: rowIndex + 1,
              },
            },
          },
        ],
      },
    })
  );
}

// List all sheet tab names in a spreadsheet
async function listSheetTabs(spreadsheetId) {
  const sheets = await getSheetsApi();
  const meta = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId })
  );
  return meta.data.sheets.map((s) => s.properties.title);
}

module.exports = {
  COL,
  appendRow,
  getAllRows,
  findRow,
  findRowByClient,
  updateRow,
  updateCell,
  deleteRow,
  listSheetTabs,
};

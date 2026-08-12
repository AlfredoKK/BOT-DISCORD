const assert = require('node:assert/strict');
const test = require('node:test');

const {
  archiveNames,
  escapeDriveQueryString,
  sanitizeFolderName,
} = require('../src/services/drive-archiver');

test('archive names are based on the Europe/Paris calendar date', () => {
  const names = archiveNames(new Date('2026-08-12T21:15:00+02:00'));

  assert.equal(names.monthName, '2026-08');
  assert.equal(names.fileName, '2026-08-12.png');
});

test('Drive folder names keep channel names usable as agency folders', () => {
  assert.equal(sanitizeFolderName('  LA/CIOTAT  '), 'LA-CIOTAT');
  assert.equal(sanitizeFolderName(''), 'Agence inconnue');
});

test('Drive query strings escape quotes and backslashes', () => {
  assert.equal(escapeDriveQueryString("L'agence \\ test"), "L\\'agence \\\\ test");
});

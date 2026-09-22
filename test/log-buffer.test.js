const assert = require('node:assert/strict');
const test = require('node:test');

const {
  installLogBuffer,
  getRecentLogs,
  clearRecentLogs,
  MAX_LINES,
} = require('../src/services/log-buffer');

// On neutralise la sortie réelle (stdout/stderr) pendant le test pour ne pas
// polluer le rapport, tout en comptant les écritures : la sortie d'origine
// doit toujours être appelée, le tampon ne fait que copier.
installLogBuffer();

function withSilentConsole(fn) {
  const calls = { stdout: 0, stderr: 0 };
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = () => { calls.stdout += 1; return true; };
  process.stderr.write = () => { calls.stderr += 1; return true; };
  try {
    return fn(calls);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('le tampon garde les 80 dernières lignes dans l\'ordre', () => {
  withSilentConsole((calls) => {
    clearRecentLogs();
    installLogBuffer();
    installLogBuffer(); // idempotent : ne doit pas doubler les lignes

    for (let i = 1; i <= 100; i++) console.log(`ligne ${i}`);

    const logs = getRecentLogs();
    assert.equal(MAX_LINES, 80);
    assert.equal(logs.length, 80);
    assert.match(logs[0], /\[LOG\] ligne 21$/);
    assert.match(logs[79], /\[LOG\] ligne 100$/);
    // Horodatage Europe/Paris au format jj/mm/aaaa hh:mm:ss
    assert.match(logs[0], /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} \[LOG\]/);
    // La sortie d'origine est toujours appelée une fois par ligne
    assert.equal(calls.stdout, 100);
  });
});

test('chaque niveau est capturé et formaté comme console', () => {
  withSilentConsole(() => {
    clearRecentLogs();
    installLogBuffer();

    console.warn('attention %s', 'ici');
    console.error('erreur', new Error('boum').message, { code: 42 });
    console.info('info');

    const logs = getRecentLogs();
    assert.equal(logs.length, 3);
    assert.match(logs[0], /\[WARN\] attention ici$/);
    assert.match(logs[1], /\[ERROR\] erreur boum \{ code: 42 \}$/);
    assert.match(logs[2], /\[INFO\] info$/);
  });
});

test('getRecentLogs renvoie une copie', () => {
  withSilentConsole(() => {
    clearRecentLogs();
    installLogBuffer();
    console.log('a');
    const copy = getRecentLogs();
    copy.push('injecté');
    assert.equal(getRecentLogs().length, 1);
  });
});

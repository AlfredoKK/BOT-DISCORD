const assert = require('node:assert/strict');
const test = require('node:test');

const supabase = require('../src/services/supabase');

const ENV = {
  SUPABASE_LICALL_URL: 'https://licall.supabase.co',
  SUPABASE_LICALL_SERVICE_ROLE_KEY: 'licall-key',
  SUPABASE_KALLKALL_URL: 'https://kk.supabase.co',
  SUPABASE_KALLKALL_SERVICE_ROLE_KEY: 'kk-key',
};

test('resolveCompany : classeur Sheets → société, jamais de mélange', () => {
  const licall = { spreadsheet_id: '16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI' };
  const kk = { spreadsheet_id: '1dshz0ZhA44VziYOirOwQj_AQFRJxehsV7yZnZ5LJ0BU' };
  assert.equal(supabase.resolveCompany(licall, null, ENV), 'licall');
  assert.equal(supabase.resolveCompany(kk, null, ENV), 'kallkall');
  // Le classeur l'emporte sur le serveur Discord (une agence Licall dans le serveur KK reste Licall)
  assert.equal(supabase.resolveCompany(licall, '1445676914667946085', ENV), 'licall');
});

test('resolveCompany : serveur Discord en secours, societe explicite prioritaire', () => {
  assert.equal(supabase.resolveCompany({ spreadsheet_id: 'inconnu' }, '1443725425904848959', ENV), 'licall');
  assert.equal(supabase.resolveCompany({ spreadsheet_id: 'inconnu', guild_id: '1445676914667946085' }, null, ENV), 'kallkall');
  assert.equal(supabase.resolveCompany({ societe: 'kallkall', spreadsheet_id: '16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI' }, null, ENV), 'kallkall');
  assert.equal(supabase.resolveCompany({ spreadsheet_id: 'inconnu' }, '999', ENV), null);
});

test('getDbForAgency : pas de société → pas de base ; base non configurée → raison explicite', () => {
  const none = supabase.getDbForAgency({ name: 'X', spreadsheet_id: 'inconnu' }, null, ENV);
  assert.equal(none.db, null);
  assert.match(none.reason, /société indéterminable/);

  const unconfigured = supabase.getDbForAgency({ societe: 'licall' }, null, { ...ENV, SUPABASE_LICALL_SERVICE_ROLE_KEY: '' });
  assert.equal(unconfigured.db, null);
  assert.match(unconfigured.reason, /SUPABASE_LICALL_SERVICE_ROLE_KEY/);

  const ok = supabase.getDbForAgency({ societe: 'licall' }, null, ENV);
  assert.equal(ok.company, 'licall');
  assert.equal(ok.db.url, 'https://licall.supabase.co');
  supabase.resetClientCacheForTests();
});

test('isDbWriteEnabled : coupé par défaut', () => {
  assert.equal(supabase.isDbWriteEnabled({}), false);
  assert.equal(supabase.isDbWriteEnabled({ DB_WRITE_ENABLED: 'false' }), false);
  assert.equal(supabase.isDbWriteEnabled({ DB_WRITE_ENABLED: 'true' }), true);
});

test('client PostgREST : en-têtes service_role, upsert on_conflict, erreurs lisibles', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/rdv')) {
      return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'r1' }]), headers: new Map() };
    }
    return {
      ok: false, status: 409,
      json: async () => ({ code: '23505', message: 'duplicate key', details: 'Key (x) exists' }),
    };
  };
  const db = supabase.createClient({ url: 'https://x.supabase.co', serviceRoleKey: 'k', label: 'Test', fetchImpl });

  const rows = await db.upsert('rdv', [{ gcal_event_id: 'e' }], { onConflict: 'gcal_event_id' });
  assert.deepEqual(rows, [{ id: 'r1' }]);
  assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/rdv?on_conflict=gcal_event_id');
  assert.equal(calls[0].init.headers.apikey, 'k');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].init.headers.Prefer, 'resolution=merge-duplicates,return=representation');

  await assert.rejects(() => db.insert('users', [{}]), /Supabase 409 \[23505\]: duplicate key — Key \(x\) exists/);
});

test('inList : valeurs échappées pour PostgREST', () => {
  assert.equal(supabase.inList(['a', 'b,c']), 'in.("a","b,c")');
});

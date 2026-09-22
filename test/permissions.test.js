const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const { isAdmin, roleNameMatches, requireAdmin } = require('../src/utils/permissions');

function member(roleNames, { administrator = false, ids = [] } = {}) {
  const roles = roleNames.map((name, i) => ({ id: ids[i] || String(1000 + i), name }));
  return {
    permissions: { has: (p) => administrator && p === PermissionFlagsBits.Administrator },
    roles: { cache: { some: (fn) => roles.some(fn), map: (fn) => roles.map(fn) } },
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('la permission Administrator suffit, même sans rôle', () => {
  withEnv({ ADMIN_ROLE_IDS: undefined, ADMIN_ROLE_NAME: undefined }, () => {
    assert.equal(isAdmin(member([], { administrator: true })), true);
  });
});

test('sans rôle ni permission, refus ; membre absent, refus', () => {
  withEnv({ ADMIN_ROLE_IDS: undefined, ADMIN_ROLE_NAME: undefined }, () => {
    assert.equal(isAdmin(member([])), false);
    assert.equal(isAdmin(member(['Membre', 'Support'])), false);
    assert.equal(isAdmin(undefined), false);
    assert.equal(isAdmin({ permissions: null, roles: null }), false);
  });
});

test('nom de rôle : casse et espaces ignorés, variantes "Admins"/"Administrateur" acceptées', () => {
  withEnv({ ADMIN_ROLE_IDS: undefined, ADMIN_ROLE_NAME: undefined }, () => {
    for (const name of ['admin', 'Admin', 'ADMIN', 'admin ', ' Admin', 'Admins', 'Administrateur', 'ADMINISTRATEURS', 'Administrator']) {
      assert.equal(isAdmin(member([name])), true, `rôle "${name}" devrait passer`);
    }
  });
});

test('nom de rôle : les noms qui contiennent "admin" sans en être une déclinaison sont refusés', () => {
  withEnv({ ADMIN_ROLE_IDS: undefined, ADMIN_ROLE_NAME: undefined }, () => {
    for (const name of ['Admin Support', 'superadmin', 'admin-stagiaire', 'admin2', 'Adm', 'Modérateur']) {
      assert.equal(isAdmin(member([name])), false, `rôle "${name}" ne devrait pas passer`);
    }
  });
});

test('ADMIN_ROLE_NAME ajoute des noms aux défauts (trim + minuscules), sans retirer admin', () => {
  withEnv({ ADMIN_ROLE_IDS: undefined, ADMIN_ROLE_NAME: '  Direction ' }, () => {
    assert.equal(isAdmin(member(['direction'])), true);
    assert.equal(isAdmin(member(['DIRECTIONS'])), true);
    assert.equal(isAdmin(member(['Admin'])), true);
  });
});

test('ADMIN_ROLE_IDS autorise par identifiant, en plus du nom', () => {
  withEnv({ ADMIN_ROLE_IDS: '111, 222', ADMIN_ROLE_NAME: undefined }, () => {
    assert.equal(isAdmin(member(['Staff'], { ids: ['222'] })), true);
    assert.equal(isAdmin(member(['Staff'], { ids: ['333'] })), false);
    assert.equal(isAdmin(member(['Admin'], { ids: ['333'] })), true);
  });
});

test('roleNameMatches : cas limites', () => {
  assert.equal(roleNameMatches('Admin', 'admin'), true);
  assert.equal(roleNameMatches('', 'admin'), false);
  assert.equal(roleNameMatches(undefined, 'admin'), false);
  assert.equal(roleNameMatches('admin', ''), false);
  assert.equal(roleNameMatches('Administrateur', 'admin'), true);
  assert.equal(roleNameMatches('admin ', 'admin'), true);
});

test('requireAdmin répond en éphémère et refuse quand le membre n\'est pas admin', async () => {
  await withEnv({ ADMIN_ROLE_IDS: undefined, ADMIN_ROLE_NAME: undefined }, async () => {
    const replies = [];
    const warn = console.warn; console.warn = () => {};
    try {
      const interaction = {
        member: member(['Membre']), user: { tag: 'x#0' }, commandName: 'rdvadmin', guildId: '1',
        deferred: false, replied: false,
        reply: async (opts) => { replies.push(opts); },
        editReply: async () => { throw new Error('ne doit pas être appelé'); },
      };
      assert.equal(await requireAdmin(interaction), false);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].content, 'Commande réservée aux administrateurs.');
      assert.equal(replies[0].ephemeral, true);

      const ok = { member: member(['Admin']), user: {}, commandName: 'rdvadmin', reply: async () => { throw new Error('non'); } };
      assert.equal(await requireAdmin(ok), true);
    } finally { console.warn = warn; }
  });
});

test('Team Lead role is accepted by default, Team Laura is not', () => {
  const { isAdmin, getAdminRoleNames } = require('../src/utils/permissions');
  const member = (names) => ({ permissions: { has: () => false }, roles: { cache: { some: (fn) => names.map((n, i) => ({ id: String(i), name: n })).some(fn) } } });
  assert.ok(getAdminRoleNames().includes('team lead'));
  assert.equal(isAdmin(member(['Team Lead'])), true);
  assert.equal(isAdmin(member(['TEAM LEAD'])), true);
  assert.equal(isAdmin(member(['Team Leader'])), true);
  assert.equal(isAdmin(member(['Team Laura'])), false);
  assert.equal(isAdmin(member(['Support'])), false);
});

test('ADMIN_ROLE_NAME adds names to the defaults instead of replacing them', () => {
  const previous = process.env.ADMIN_ROLE_NAME;
  process.env.ADMIN_ROLE_NAME = 'admin, direction';
  try {
    const { getAdminRoleNames } = require('../src/utils/permissions');
    const names = getAdminRoleNames();
    assert.ok(names.includes('admin') && names.includes('team lead') && names.includes('direction'));
  } finally {
    if (previous === undefined) delete process.env.ADMIN_ROLE_NAME; else process.env.ADMIN_ROLE_NAME = previous;
  }
});

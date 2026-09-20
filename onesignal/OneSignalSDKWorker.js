/*************************************************************************
 * Schulapp – Backend V22 mit schneller Synchronisation + Web-Push
 * -----------------------------------------------------------------------
 * Eine gemeinsame Google-Tabelle kann mehrere Benutzerkonten bedienen.
 * Unterrichtsdaten werden serverseitig nach userId getrennt.
 *
 * Einrichtung:
 *   1. INVITE_CODE und RECOVERY_CODE unten auf zwei verschiedene lange Geheimcodes setzen.
 *   2. setupSheets() einmal ausführen.
 *   3. Als Web-App neu bereitstellen (Ausführen als: Ich, Zugriff: Jeder).
 *   4. /exec-Adresse in der Schulapp unter „Server“ eintragen.
 *************************************************************************/

/** Geheimcode, der nur zum Erstellen neuer Benutzerkonten gebraucht wird. */
var INVITE_CODE = 'HIER-EINEN-LANGEN-EINLADUNGSCODE-EINTRAGEN';

/** Geheimcode nur für Passwort-Wiederherstellung. NICHT an Kolleg:innen weitergeben. */
var RECOVERY_CODE = 'HIER-EINEN-ANDEREN-LANGEN-RECOVERY-CODE-EINTRAGEN';

/** Optional: ID der Tabelle; leer lassen, wenn das Skript an die Tabelle gebunden ist. */
var SHEET_ID = '';

/** Datenblätter der App. userId wird automatisch vom Server gesetzt. */
var SCHEMA = {
  Klassen:     ['id', 'name', 'fach', 'stufe', 'farbe', 'kategorien', 'notenschluessel', 'notiz', 'archiviert', 'updatedAt', 'deleted', 'userId'],
  Kurse:       ['id', 'klasseId', 'fach', 'farbe', 'kategorien', 'notenschluessel', 'notiz', 'archiviert', 'updatedAt', 'deleted', 'checkpunkte', 'userId'],
  SuS:         ['id', 'klasseId', 'nachname', 'vorname', 'geschlecht', 'notiz', 'aktiv', 'sortierung', 'updatedAt', 'deleted', 'userId'],
  Stundenplan: ['id', 'tag', 'stunde', 'klasseId', 'fach', 'raum', 'updatedAt', 'deleted', 'checkpunkte', 'kursId', 'userId'],
  Stunden:     ['id', 'datum', 'stunde', 'klasseId', 'thema', 'hausaufgaben', 'material', 'notiz', 'entfaellt', 'updatedAt', 'deleted', 'kursId', 'userId'],
  Mitarbeit:   ['id', 'datum', 'stunde', 'klasseId', 'susId', 'wert', 'bemerkung', 'updatedAt', 'deleted', 'kursId', 'userId'],
  Leistungen:  ['id', 'klasseId', 'kategorie', 'titel', 'datum', 'maxPunkte', 'gewicht', 'notenschluessel', 'updatedAt', 'deleted', 'kursId', 'userId'],
  Noten:       ['id', 'leistungId', 'susId', 'punkte', 'note', 'bemerkung', 'updatedAt', 'deleted', 'userId'],
  Checks:      ['id', 'datum', 'stunde', 'klasseId', 'susId', 'punkt', 'wert', 'updatedAt', 'deleted', 'kursId', 'userId'],
  Settings:    ['id', 'value', 'updatedAt', 'deleted', 'userId'],

  /* Diese beiden Tabellen werden nie an die App als Unterrichtsdaten ausgeliefert. */
  Users:       ['id', 'name', 'email', 'salt', 'passwordHash', 'role', 'active', 'createdAt', 'updatedAt', 'deleted'],
  Sessions:    ['id', 'userId', 'tokenHash', 'expiresAt', 'createdAt', 'updatedAt', 'deleted']
};

var DATA_TABLES = ['Klassen', 'Kurse', 'SuS', 'Stundenplan', 'Stunden', 'Mitarbeit', 'Leistungen', 'Noten', 'Checks', 'Settings'];
var AUTH_TABLES = ['Users', 'Sessions'];
var TABLES = DATA_TABLES.concat(AUTH_TABLES);

/* ======================================================================
 * Einstiegspunkte
 * ====================================================================== */

function doGet(e) { return handle_(e); }
function doPost(e) { return handle_(e); }

function handle_(e) {
  var callback = (e && e.parameter && e.parameter.callback) ? String(e.parameter.callback) : '';
  var req = {};

  try {
    if (e && e.postData && e.postData.contents) req = JSON.parse(e.postData.contents);
    else if (e && e.parameter && e.parameter.payload) req = JSON.parse(e.parameter.payload);
    else if (e && e.parameter) req = e.parameter;
  } catch (err) {
    return out_({ ok: false, error: 'request', message: 'Anfrage konnte nicht gelesen werden.' }, callback);
  }

  var action = String(req.action || 'ping');

  if (action === 'ping') {
    try {
      return out_({ ok: true, pong: true, spreadsheet: ss_().getName(), version: 22, zeit: new Date().toISOString() }, callback);
    } catch (errPing) {
      return out_({ ok: false, error: 'server', message: String(errPing && errPing.message ? errPing.message : errPing) }, callback);
    }
  }

  if (action === 'pushConfig') {
    var pushCfg = pushConfig_();
    return out_({
      ok: true,
      configured: !!(pushCfg.appId && pushCfg.apiKey),
      appId: pushCfg.appId || '',
      appUrl: pushCfg.appUrl || ''
    }, callback);
  }

  /* Reine Lesezugriffe müssen in V18 nicht mehr bis zu 25 Sekunden auf
     einen Schreib-Lock warten. Das macht Start und manuellen Abgleich
     besonders bei mehreren Geräten deutlich reaktionsfreudiger. */
  if (action === 'session' || action === 'pull') {
    try {
      var leseSession = sessionFromToken_(String(req.session || ''));
      if (!leseSession) return out_({ ok: false, error: 'auth', message: 'Anmeldung abgelaufen. Bitte erneut anmelden.' }, callback);
      var leseUser = userById_(leseSession.userId);
      if (!leseUser || String(leseUser.active) === '0' || String(leseUser.deleted) === '1') {
        return out_({ ok: false, error: 'auth', message: 'Dieses Konto ist nicht aktiv.' }, callback);
      }
      if (action === 'session') {
        return out_({ ok: true, user: publicUser_(leseUser), expiresAt: leseSession.expiresAt }, callback);
      }
      return out_({ ok: true, tables: pullAllForUser_(leseUser.id), zeit: new Date().toISOString() }, callback);
    } catch (errRead) {
      return out_({ ok: false, error: 'server', message: String(errRead && errRead.message ? errRead.message : errRead) }, callback);
    }
  }

  /* Nur schreibende Aktionen werden serialisiert. */
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); }
  catch (errLock) { return out_({ ok: false, error: 'busy', message: 'Gerade wird schon gespeichert. Bitte gleich nochmal.' }, callback); }

  try {
    var result;

    if (action === 'register') {
      result = register_(req);

    } else if (action === 'login') {
      result = login_(req);

    } else if (action === 'resetPassword') {
      result = resetPassword_(req);

    } else {
      var session = sessionFromToken_(String(req.session || ''));
      if (!session) return out_({ ok: false, error: 'auth', message: 'Anmeldung abgelaufen. Bitte erneut anmelden.' }, callback);
      var user = userById_(session.userId);
      if (!user || String(user.active) === '0' || String(user.deleted) === '1') {
        return out_({ ok: false, error: 'auth', message: 'Dieses Konto ist nicht aktiv.' }, callback);
      }

      if (action === 'logout') {
        session.deleted = '1';
        upsertPlain_('Sessions', [session]);
        result = { ok: true };

      } else if (action === 'push') {
        var written = 0;
        var ops = req.ops || [];
        for (var i = 0; i < ops.length; i++) {
          var op = ops[i];
          if (!op || DATA_TABLES.indexOf(String(op.table)) === -1) continue;
          if (op.records && op.records.length) written += upsertForUser_(String(op.table), op.records, user.id);
        }
        result = { ok: true, written: written, zeit: new Date().toISOString() };

      } else if (action === 'pushSetup') {
        result = pushSetup_(user);

      } else if (action === 'pushTest') {
        result = pushTest_(user);

      } else {
        result = { ok: false, error: 'unknown_action', message: 'Unbekannte Aktion: ' + action };
      }
    }

    return out_(result, callback);

  } catch (err) {
    return out_({ ok: false, error: 'server', message: String(err && err.message ? err.message : err) }, callback);
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function out_(obj, callback) {
  var body = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + body + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

/* ======================================================================
 * Benutzerkonten
 * ====================================================================== */

function register_(req) {
  if (String(req.invite || '') !== String(INVITE_CODE)) {
    return { ok: false, error: 'invite', message: 'Der Einladungscode stimmt nicht.' };
  }

  var name = String(req.name || '').trim();
  var email = normalizeEmail_(req.email);
  var password = String(req.password || '');
  if (!name) return { ok: false, error: 'name', message: 'Bitte einen Namen eingeben.' };
  if (!isEmail_(email)) return { ok: false, error: 'email', message: 'Bitte eine gültige E-Mail-Adresse eingeben.' };
  if (password.length < 8) return { ok: false, error: 'password', message: 'Das Passwort braucht mindestens 8 Zeichen.' };
  if (userByEmail_(email)) return { ok: false, error: 'exists', message: 'Für diese E-Mail gibt es bereits ein Konto.' };

  var existingUsers = activeUsers_();
  var firstUser = existingUsers.length === 0;
  var salt = randomToken_();
  var user = {
    id: 'usr_' + Utilities.getUuid(),
    name: name,
    email: email,
    salt: salt,
    passwordHash: passwordHashV2_(password, salt),
    role: firstUser ? 'owner' : 'user',
    active: '1',
    createdAt: new Date().toISOString(),
    deleted: ''
  };
  upsertPlain_('Users', [user]);

  var legacyClaimed = false;
  if (firstUser) legacyClaimed = claimLegacyData_(user.id);

  var sess = createSession_(user.id, req.remember !== false && String(req.remember) !== 'false');
  return {
    ok: true,
    user: publicUser_(user),
    sessionToken: sess.token,
    expiresAt: sess.expiresAt,
    legacyClaimed: legacyClaimed
  };
}

function login_(req) {
  var email = normalizeEmail_(req.email);
  var password = String(req.password || '');
  var user = userByEmail_(email);
  if (!user || String(user.deleted) === '1' || String(user.active) === '0') {
    return { ok: false, error: 'auth', message: 'E-Mail oder Passwort stimmt nicht.' };
  }
  var pruefung = verifyPassword_(password, user);
  if (!pruefung.ok) {
    return { ok: false, error: 'auth', message: 'E-Mail oder Passwort stimmt nicht.' };
  }

  /* Alte V11/V13-Hashes werden nach der ersten erfolgreichen Anmeldung
     automatisch auf den deutlich schnelleren V14-Hash umgestellt. */
  if (pruefung.legacy) {
    user.salt = randomToken_();
    user.passwordHash = passwordHashV2_(password, user.salt);
    upsertPlain_('Users', [user]);
  }

  var sess = createSession_(user.id, req.remember !== false && String(req.remember) !== 'false');
  return { ok: true, user: publicUser_(user), sessionToken: sess.token, expiresAt: sess.expiresAt };
}


function resetPassword_(req) {
  if (String(RECOVERY_CODE || '') === '' || String(RECOVERY_CODE) === 'HIER-EINEN-ANDEREN-LANGEN-RECOVERY-CODE-EINTRAGEN') {
    return { ok: false, error: 'recovery_setup', message: 'Der Recovery-Code ist im Apps Script noch nicht eingerichtet.' };
  }
  if (!constantEqual_(String(req.recovery || ''), String(RECOVERY_CODE))) {
    return { ok: false, error: 'recovery', message: 'Der Recovery-Code stimmt nicht.' };
  }

  var email = normalizeEmail_(req.email);
  var password = String(req.password || '');
  if (!isEmail_(email)) return { ok: false, error: 'email', message: 'Bitte eine gültige E-Mail-Adresse eingeben.' };
  if (password.length < 8) return { ok: false, error: 'password', message: 'Das neue Passwort braucht mindestens 8 Zeichen.' };

  var user = userByEmail_(email);
  if (!user || String(user.deleted) === '1' || String(user.active) === '0') {
    /* Nicht verraten, ob die E-Mail existiert. */
    return { ok: false, error: 'auth', message: 'Konto konnte nicht zurückgesetzt werden.' };
  }

  var salt = randomToken_();
  user.salt = salt;
  user.passwordHash = passwordHashV2_(password, salt);
  upsertPlain_('Users', [user]);

  /* Alle bisherigen Sitzungen dieses Kontos ungültig machen. */
  var sessions = readTable_('Sessions');
  var changed = [];
  for (var i = 0; i < sessions.length; i++) {
    if (String(sessions[i].userId) === String(user.id) && String(sessions[i].deleted) !== '1') {
      sessions[i].deleted = '1';
      changed.push(sessions[i]);
    }
  }
  if (changed.length) upsertPlain_('Sessions', changed);

  return { ok: true, message: 'Passwort wurde zurückgesetzt.' };
}

function createSession_(userId, remember) {
  cleanupExpiredSessions_();
  var raw = randomToken_() + randomToken_();
  var now = new Date();
  var ttlMs = (remember ? 90 : 2) * 24 * 60 * 60 * 1000;
  var expires = new Date(now.getTime() + ttlMs).toISOString();
  var rec = {
    id: 'ses_' + Utilities.getUuid(),
    userId: userId,
    tokenHash: hash_(raw),
    expiresAt: expires,
    createdAt: now.toISOString(),
    deleted: ''
  };
  upsertPlain_('Sessions', [rec]);
  return { token: raw, expiresAt: expires };
}

function sessionFromToken_(raw) {
  raw = String(raw || '');
  if (!raw) return null;
  var target = hash_(raw);
  var now = new Date().getTime();
  var sessions = readTable_('Sessions');
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if (String(s.deleted) === '1') continue;
    if (!constantEqual_(String(s.tokenHash || ''), target)) continue;
    var exp = new Date(String(s.expiresAt || '')).getTime();
    if (!exp || exp <= now) return null;
    return s;
  }
  return null;
}

function cleanupExpiredSessions_() {
  var now = new Date().getTime();
  var sessions = readTable_('Sessions');
  var changed = [];
  for (var i = 0; i < sessions.length; i++) {
    if (String(sessions[i].deleted) === '1') continue;
    var exp = new Date(String(sessions[i].expiresAt || '')).getTime();
    if (exp && exp <= now) {
      sessions[i].deleted = '1';
      changed.push(sessions[i]);
    }
  }
  if (changed.length) upsertPlain_('Sessions', changed);
}

function publicUser_(u) {
  return { id: String(u.id), name: String(u.name || ''), email: String(u.email || ''), role: String(u.role || 'user') };
}

function activeUsers_() {
  return readTable_('Users').filter(function (u) { return String(u.deleted) !== '1' && String(u.active) !== '0'; });
}

function userById_(id) {
  var users = readTable_('Users');
  for (var i = 0; i < users.length; i++) if (String(users[i].id) === String(id)) return users[i];
  return null;
}

function userByEmail_(email) {
  email = normalizeEmail_(email);
  var users = readTable_('Users');
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].deleted) !== '1' && normalizeEmail_(users[i].email) === email) return users[i];
  }
  return null;
}

function normalizeEmail_(email) { return String(email || '').trim().toLowerCase(); }
function isEmail_(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')); }

function randomToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

var PASSWORD_HASH_V2_ROUNDS = 64;

function passwordHashRounds_(password, salt, rounds) {
  var h = String(password || '');
  for (var i = 0; i < rounds; i++) h = hash_(String(salt || '') + '|' + h + '|' + i);
  return h;
}

function passwordHashV2_(password, salt) {
  return 'v2$' + PASSWORD_HASH_V2_ROUNDS + '$' + passwordHashRounds_(password, salt, PASSWORD_HASH_V2_ROUNDS);
}

function passwordHashLegacy_(password, salt) {
  return passwordHashRounds_(password, salt, 1200);
}

function verifyPassword_(password, user) {
  var stored = String(user && user.passwordHash || '');
  var salt = String(user && user.salt || '');
  var m = /^v2\$(\d+)\$(.+)$/.exec(stored);
  if (m) {
    var rounds = Math.max(1, Math.min(500, Number(m[1]) || PASSWORD_HASH_V2_ROUNDS));
    return { ok: constantEqual_(stored, 'v2$' + rounds + '$' + passwordHashRounds_(password, salt, rounds)), legacy: false };
  }
  return { ok: constantEqual_(stored, passwordHashLegacy_(password, salt)), legacy: true };
}

function hash_(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text || ''), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
}

function constantEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ======================================================================
 * Tabellen-Hilfsfunktionen
 * ====================================================================== */

function ss_() { return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActive(); }

function sheet_(name) {
  var ss = ss_();
  var cols = SCHEMA[name];
  var sh = ss.getSheetByName(name);

  if (!sh) {
    sh = ss.insertSheet(name);
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    return sh;
  }

  if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  var head = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  var needsFix = false;
  for (var i = 0; i < cols.length; i++) {
    if (String(head[i]) !== cols[i]) { needsFix = true; break; }
  }
  if (needsFix) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readTable_(name) {
  var sh = sheet_(name);
  var cols = SCHEMA[name];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (row[0] === '' || row[0] === null) continue;
    var rec = {};
    for (var c = 0; c < cols.length; c++) rec[cols[c]] = normalize_(row[c]);
    out.push(rec);
  }
  return out;
}

function normalize_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (v === true) return '1';
  if (v === false) return '';
  return String(v);
}

function pullAllForUser_(userId) {
  var data = {};
  for (var i = 0; i < DATA_TABLES.length; i++) data[DATA_TABLES[i]] = readForUser_(DATA_TABLES[i], userId);
  return data;
}

function readForUser_(name, userId) {
  var rows = readTable_(name);
  return rows.filter(function (r) { return String(r.userId || '') === String(userId); });
}

/**
 * Daten-UPSERT mit Mandantentrennung.
 * IDs eines anderen userId dürfen nie überschrieben werden.
 */
function upsertForUser_(name, records, userId) {
  var sh = sheet_(name);
  var cols = SCHEMA[name];
  var idCol = cols.indexOf('id');
  var userCol = cols.indexOf('userId');
  if (idCol < 0 || userCol < 0) throw new Error('Schemafehler in ' + name);

  var last = sh.getLastRow();
  var values = last >= 2 ? sh.getRange(2, 1, last - 1, cols.length).getValues() : [];
  var index = {};
  var owners = {};

  for (var i = 0; i < values.length; i++) {
    var id = String(values[i][idCol] || '');
    var owner = String(values[i][userCol] || '');
    if (!id) continue;
    index[id + '|' + owner] = i;
    if (!owners[id]) owners[id] = {};
    owners[id][owner] = true;
  }

  var now = new Date().toISOString();
  var written = 0;

  for (var j = 0; j < records.length; j++) {
    var rec = records[j] || {};
    var idv = String(rec.id || '');
    if (!idv) continue;

    var idOwners = owners[idv] || {};
    for (var otherOwner in idOwners) {
      if (Object.prototype.hasOwnProperty.call(idOwners, otherOwner) &&
          otherOwner !== String(userId)) {
        throw new Error('Datensatz gehört zu einem anderen Konto.');
      }
    }

    rec.userId = userId;
    rec.updatedAt = now;
    var row = rowFor_(cols, rec);
    var key = idv + '|' + userId;

    if (index[key] !== undefined) {
      values[index[key]] = row;
    } else {
      index[key] = values.length;
      values.push(row);
      if (!owners[idv]) owners[idv] = {};
      owners[idv][String(userId)] = true;
    }
    written++;
  }

  /* V18: pro Tabelle nur noch ein Sheet-Schreibvorgang statt eines
     setValues-Aufrufs für jeden einzelnen Datensatz. */
  if (written && values.length) {
    sh.getRange(2, 1, values.length, cols.length).setNumberFormat('@').setValues(values);
  }
  return written;
}

/** UPSERT für Users/Sessions, deren IDs global eindeutig sind. */
function upsertPlain_(name, records) {
  var sh = sheet_(name);
  var cols = SCHEMA[name];
  var last = sh.getLastRow();
  var values = last >= 2 ? sh.getRange(2, 1, last - 1, cols.length).getValues() : [];
  var index = {};

  for (var i = 0; i < values.length; i++) {
    var id = String(values[i][0] || '');
    if (id) index[id] = i;
  }

  var now = new Date().toISOString();
  var written = 0;

  for (var j = 0; j < records.length; j++) {
    var rec = records[j] || {};
    if (!rec.id) continue;
    rec.updatedAt = now;
    var row = rowFor_(cols, rec);
    var key = String(rec.id);

    if (index[key] !== undefined) values[index[key]] = row;
    else {
      index[key] = values.length;
      values.push(row);
    }
    written++;
  }

  if (written && values.length) {
    sh.getRange(2, 1, values.length, cols.length).setNumberFormat('@').setValues(values);
  }
  return written;
}

function rowFor_(cols, rec) {
  var row = [];
  for (var c = 0; c < cols.length; c++) {
    var v = rec[cols[c]];
    if (v === undefined || v === null) v = '';
    if (typeof v === 'object') v = JSON.stringify(v);
    if (v === true) v = '1';
    if (v === false) v = '';
    row.push(String(v));
  }
  return row;
}

/**
 * Beim allerersten Konto werden vorhandene Zeilen aus der alten Einzelbenutzer-
 * Version diesem owner-Konto zugeordnet. Danach gibt es keine automatische Übernahme mehr.
 */
function claimLegacyData_(userId) {
  var changedAny = false;
  for (var t = 0; t < DATA_TABLES.length; t++) {
    var name = DATA_TABLES[t];
    var sh = sheet_(name);
    var cols = SCHEMA[name];
    var userCol = cols.indexOf('userId') + 1;
    var last = sh.getLastRow();
    if (last < 2 || userCol < 1) continue;
    var vals = sh.getRange(2, userCol, last - 1, 1).getValues();
    var changed = false;
    for (var r = 0; r < vals.length; r++) {
      if (String(vals[r][0] || '') === '') { vals[r][0] = userId; changed = true; changedAny = true; }
    }
    if (changed) sh.getRange(2, userCol, vals.length, 1).setNumberFormat('@').setValues(vals);
  }
  return changedAny;
}

/* ======================================================================
 * Komfortfunktionen im Apps-Script-Editor
 * ====================================================================== */

function setupSheets() {
  for (var i = 0; i < TABLES.length; i++) sheet_(TABLES[i]);
  melde_('V13 eingerichtet: Datenblätter + Benutzerkonten + Passwort-Reset sind bereit.');
}

function melde_(text) {
  Logger.log(text);
  try { ss_().toast(text, 'Schulapp', 5); } catch (e) {}
}

function papierkorbLeeren() {
  var entfernt = 0;
  for (var i = 0; i < DATA_TABLES.length; i++) {
    var name = DATA_TABLES[i];
    var sh = sheet_(name);
    var cols = SCHEMA[name];
    var delCol = cols.indexOf('deleted') + 1;
    if (delCol < 1) continue;
    var last = sh.getLastRow();
    if (last < 2) continue;
    var flags = sh.getRange(2, delCol, last - 1, 1).getValues();
    for (var r = flags.length - 1; r >= 0; r--) {
      if (String(flags[r][0]) === '1') { sh.deleteRow(r + 2); entfernt++; }
    }
  }
  melde_(entfernt + ' Zeile(n) endgültig entfernt.');
}

function zeigeWebAppUrl() { Logger.log(ScriptApp.getService().getUrl()); }

/* ======================================================================
 * V22 – Echter Web-Push über OneSignal
 * ====================================================================== */

function pushConfig_() {
  var p = PropertiesService.getScriptProperties();
  return {
    appId: String(p.getProperty('ONESIGNAL_APP_ID') || '').trim(),
    apiKey: String(p.getProperty('ONESIGNAL_APP_API_KEY') || '').trim(),
    appUrl: String(p.getProperty('SCHULAPP_URL') || 'https://w8ytbpw7zk-cell.github.io/Schullapp/').trim(),
    timezone: String(p.getProperty('SCHULAPP_TIMEZONE') || 'Europe/Berlin').trim()
  };
}

function pushSetup_(user) {
  var cfg = pushConfig_();
  if (!cfg.appId || !cfg.apiKey) {
    return { ok: false, error: 'push_config', message: 'OneSignal ist in den Script Properties noch nicht eingerichtet.' };
  }
  try {
    var created = ensurePushTrigger_();
    return { ok: true, configured: true, triggerCreated: created };
  } catch (e) {
    return {
      ok: true,
      configured: true,
      triggerCreated: false,
      message: 'Push ist konfiguriert. Den Zeit-Trigger bitte einmal manuell über setupPushReminders() anlegen.'
    };
  }
}

function pushTest_(user) {
  var cfg = pushConfig_();
  if (!cfg.appId || !cfg.apiKey) {
    return { ok: false, error: 'push_config', message: 'OneSignal ist noch nicht eingerichtet.' };
  }
  return pushSendOneSignal_(String(user.id), '🔔 Schulapp',
    'Test erfolgreich – Push-Nachrichten funktionieren.', cfg.appUrl);
}

function setupPushReminders() {
  return ensurePushTrigger_();
}

function ensurePushTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'pushReminderTick') return false;
  }
  ScriptApp.newTrigger('pushReminderTick').timeBased().everyMinutes(5).create();
  return true;
}

function pushReminderTick() {
  var cfg = pushConfig_();
  if (!cfg.appId || !cfg.apiKey) return;

  var now = new Date();
  var iso = Utilities.formatDate(now, cfg.timezone, 'yyyy-MM-dd');
  var hhmm = Utilities.formatDate(now, cfg.timezone, 'HH:mm');
  var nowMin = pushMinutes_(hhmm);
  if (nowMin < 0) return;

  var props = PropertiesService.getScriptProperties();
  var sentKey = 'PUSH_SENT_' + iso;
  var sent = {};
  try { sent = JSON.parse(props.getProperty(sentKey) || '{}') || {}; } catch (e) { sent = {}; }
  props.deleteProperty('PUSH_SENT_' + pushAddDays_(iso, -1));

  var users = activeUsers_();

  for (var u = 0; u < users.length; u++) {
    var user = users[u];
    var settings = pushSettingsForUser_(user.id);
    var prefs = settings.pushPrefs;
    if (!prefs || !prefs.enabled) continue;

    var lead = Math.max(0, Math.min(10, Number(prefs.leadMinutes) || 0));
    var hours = Array.isArray(settings.stunden) && settings.stunden.length
      ? settings.stunden
      : pushDefaultHours_();

    var plan = readForUser_('Stundenplan', user.id).filter(pushAlive_);
    var courses = readForUser_('Kurse', user.id).filter(pushAlive_);
    var classes = readForUser_('Klassen', user.id).filter(pushAlive_);
    var students = readForUser_('SuS', user.id).filter(pushAlive_);
    var tasks = Array.isArray(settings.aufgaben) ? settings.aufgaben : [];
    var day = pushDayNum_(iso);

    for (var h = 0; h < hours.length; h++) {
      var hr = hours[h] || {};
      var nr = Number(hr.nr);
      if (!nr || !hr.von) continue;

      var target = pushMinutes_(String(hr.von)) - lead;
      if (!(nowMin >= target && nowMin < target + 7)) continue;

      var planRow = pushPlanCell_(plan, day, nr);
      if (!planRow || !planRow.kursId) continue;

      var prev = pushPlanCell_(plan, day, nr - 1);
      if (prev && String(prev.kursId || '') === String(planRow.kursId || '')) continue;

      var course = pushById_(courses, planRow.kursId);
      if (!course) continue;

      var relevant = [];
      for (var t = 0; t < tasks.length; t++) {
        var task = tasks[t];
        if (!task || task.erledigt || String(task.kursId || '') !== String(course.id)) continue;
        if (pushTaskRelevant_(task, course.id, iso, plan)) relevant.push(task);
      }
      if (!relevant.length) continue;

      var dedupe = String(user.id) + '|' + iso + '|' + nr + '|' + course.id;
      if (sent[dedupe]) continue;

      var cls = pushById_(classes, course.klasseId);
      var courseLabel = (cls ? cls.name + ' · ' : '') + (course.fach || 'Unterricht');
      var parts = [];
      for (var r = 0; r < relevant.length && r < 3; r++) {
        parts.push(pushTaskLabel_(relevant[r], course, students));
      }
      if (relevant.length > 3) parts.push('+' + (relevant.length - 3) + ' weitere');

      var response = pushSendOneSignal_(
        String(user.id),
        '📋 ' + courseLabel,
        parts.join(' · '),
        cfg.appUrl
      );
      if (response.ok) sent[dedupe] = new Date().toISOString();
    }
  }

  props.setProperty(sentKey, JSON.stringify(sent));
}

function pushSettingsForUser_(userId) {
  var rows = readForUser_('Settings', userId);
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!pushAlive_(r)) continue;
    try { out[String(r.id)] = JSON.parse(String(r.value || 'null')); }
    catch (e) { out[String(r.id)] = r.value; }
  }
  return out;
}

function pushDefaultHours_() {
  return [
    { nr: 1, von: '07:45', bis: '08:30' },
    { nr: 2, von: '08:30', bis: '09:15' },
    { nr: 3, von: '09:35', bis: '10:20' },
    { nr: 4, von: '10:20', bis: '11:05' },
    { nr: 5, von: '11:25', bis: '12:10' },
    { nr: 6, von: '12:10', bis: '12:55' },
    { nr: 7, von: '13:45', bis: '14:30' },
    { nr: 8, von: '14:30', bis: '15:15' }
  ];
}

function pushAlive_(r) {
  return r && String(r.deleted || '') !== '1';
}
function pushById_(rows, id) {
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) return rows[i];
  }
  return null;
}
function pushPlanCell_(plan, day, hour) {
  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    if (!pushAlive_(p)) continue;
    if (Number(p.tag) === Number(day) && Number(p.stunde) === Number(hour)) return p;
  }
  return null;
}
function pushMinutes_(hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}
function pushDayNum_(iso) {
  var d = new Date(String(iso) + 'T12:00:00Z');
  var wd = d.getUTCDay();
  return wd === 0 ? 7 : wd;
}
function pushAddDays_(iso, n) {
  var d = new Date(String(iso) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
function pushCourseHasDate_(courseId, iso, plan) {
  var day = pushDayNum_(iso);
  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    if (!pushAlive_(p)) continue;
    if (Number(p.tag) === Number(day) && String(p.kursId || '') === String(courseId)) return true;
  }
  return false;
}
function pushTaskRelevant_(task, courseId, dateIso, plan) {
  var due = String(task.frist || '');
  if (!due) return false;
  if (due <= dateIso) return true;
  if (!pushCourseHasDate_(courseId, dateIso, plan)) return false;

  var d = pushAddDays_(dateIso, 1);
  var guard = 0;
  while (d < due && guard < 370) {
    if (pushCourseHasDate_(courseId, d, plan)) return false;
    d = pushAddDays_(d, 1);
    guard++;
  }
  return true;
}
function pushTaskLabel_(task, course, students) {
  var title = String(task.titel || (task.typ === 'liste' ? 'Einsammeln' : 'To-do'));
  if (task.typ !== 'liste') return title;

  var checks = task.checks && typeof task.checks === 'object' ? task.checks : {};
  var total = 0, done = 0;
  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    if (String(s.klasseId || '') !== String(course.klasseId || '')) continue;
    if (String(s.aktiv || '1') === '0') continue;
    total++;
    if (checks[s.id]) done++;
  }
  return title + ' (' + done + '/' + total + ')';
}

function pushSendOneSignal_(externalId, title, body, url) {
  var cfg = pushConfig_();
  if (!cfg.appId || !cfg.apiKey) {
    return { ok: false, error: 'push_config', message: 'OneSignal ist nicht eingerichtet.' };
  }

  var payload = {
    app_id: cfg.appId,
    include_aliases: { external_id: [String(externalId)] },
    target_channel: 'push',
    headings: { en: String(title || 'Schulapp') },
    contents: { en: String(body || '') },
    url: String(url || cfg.appUrl || '')
  };

  try {
    var res = UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Key ' + cfg.apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    var obj = {};
    try { obj = JSON.parse(res.getContentText() || '{}'); } catch (e) {}

    if (code < 200 || code >= 300) {
      return {
        ok: false,
        error: 'push_send',
        message: 'OneSignal-Fehler ' + code +
          (obj && obj.errors ? ': ' + JSON.stringify(obj.errors) : '')
      };
    }
    return { ok: true, id: obj.id || '' };
  } catch (err) {
    return { ok: false, error: 'push_send', message: String(err && err.message ? err.message : err) };
  }
}

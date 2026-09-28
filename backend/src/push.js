const { sql, getPool } = require('./db');

// Lazily initialized - only actually touches Firebase when a push is sent,
// and never throws if it isn't configured yet (so the rest of the backend
// still works before you've set up Firebase).
let admin = null;
let initTried = false;

function getFirebaseAdmin() {
  if (admin || initTried) return admin;
  initTried = true;

  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!path) {
    console.warn('FIREBASE_SERVICE_ACCOUNT_PATH not set in .env - push notifications are disabled. See BUILD_APK.md for setup.');
    return null;
  }

  try {
    const firebaseAdmin = require('firebase-admin');
    const serviceAccount = require(require('path').resolve(path));
    firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(serviceAccount) });
    admin = firebaseAdmin;
    console.log('Firebase Admin initialized - push notifications enabled.');
  } catch (err) {
    console.error('Failed to initialize Firebase Admin (push notifications disabled):', err.message);
    admin = null;
  }
  return admin;
}

// Sends a push to specific user ids, and logs it to app_notification_log
// regardless of whether push delivery itself succeeds (so the in-app
// notifications list still works even before Firebase is configured).
async function notifyUsers(userIds, { type, idRef, title, body }) {
  console.log(`[push] notifyUsers called for user ids [${userIds?.join(', ')}], type=${type}`);
  if (!userIds || userIds.length === 0) {
    console.log('[push] no user ids given, nothing to do.');
    return;
  }

  const pool = await getPool();

  // Log first - this is what powers the in-app notifications list, and we
  // want it recorded even if push delivery fails or isn't configured yet.
  for (const idUser of userIds) {
    await pool
      .request()
      .input('id_user', sql.Int, idUser)
      .input('type', sql.NVarChar, type)
      .input('id_ref', sql.Int, idRef ?? null)
      .input('message', sql.NVarChar, body)
      .query(
        `insert into app_notification_log (id_user, type, id_ref, message)
         values (@id_user, @type, @id_ref, @message)`
      );
  }
  console.log(`[push] logged to app_notification_log for ${userIds.length} user(s).`);

  const firebaseAdmin = getFirebaseAdmin();
  if (!firebaseAdmin) {
    console.log('[push] Firebase not configured - stopping after in-app log.');
    return;
  }

  const req = pool.request();
  userIds.forEach((id, i) => req.input(`u${i}`, sql.Int, id));
  const tokensRows = await req.query(
    `select token from app_device_token where id_user in (${userIds.map((_, i) => `@u${i}`).join(',')})`
  );
  const tokens = tokensRows.recordset.map((r) => r.token);
  console.log(`[push] found ${tokens.length} device token(s) for these user id(s).`);
  if (tokens.length === 0) {
    console.log('[push] no device tokens registered for these users - nothing to send. (Are they actually logged in on a device with push registered?)');
    return;
  }

  try {
    const response = await firebaseAdmin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { type, idRef: String(idRef ?? '') }
    });
    console.log(`[push] Firebase send result: ${response.successCount} succeeded, ${response.failureCount} failed.`);

    const deadTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        console.warn(`[push] token ${i} failed: ${r.error?.code} - ${r.error?.message}`);
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error?.code)) {
          deadTokens.push(tokens[i]);
        }
      }
    });
    if (deadTokens.length > 0) {
      const cleanupReq = pool.request();
      deadTokens.forEach((t, i) => cleanupReq.input(`t${i}`, sql.NVarChar, t));
      await cleanupReq.query(`delete from app_device_token where token in (${deadTokens.map((_, i) => `@t${i}`).join(',')})`);
      console.log(`[push] removed ${deadTokens.length} dead token(s) from app_device_token.`);
    }
  } catch (err) {
    console.error('[push] Firebase send threw an error (already logged in-app):', err.message);
  }
}

// Notify everyone currently holding one of the given roles (e.g. all
// managers) - looks up live from utilisateur so it always reflects who
// currently has that role, no separate subscriber list to maintain.
async function notifyRoles(roles, payload) {
  console.log(`[push] notifyRoles called for roles [${roles.join(', ')}]`);
  const pool = await getPool();
  const req = pool.request();
  roles.forEach((r, i) => req.input(`r${i}`, sql.NVarChar, r));
  const usersResult = await req.query(
    `select id, login from utilisateur where deleted = 0 and fonction in (${roles.map((_, i) => `@r${i}`).join(',')})`
  );
  console.log(`[push] matched ${usersResult.recordset.length} user(s) with that role: ${usersResult.recordset.map((u) => u.login).join(', ')}`);
  await notifyUsers(usersResult.recordset.map((u) => u.id), payload);
}

module.exports = { notifyUsers, notifyRoles };

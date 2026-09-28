const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Called by the app right after it obtains an FCM token (on login / app
// start). Upserts so re-registering the same token is harmless.
router.post('/register-token', async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const pool = await getPool();
    await pool
      .request()
      .input('id_user', sql.Int, req.user.id)
      .input('token', sql.NVarChar, token)
      .input('platform', sql.NVarChar, platform || null)
      .query(`
        merge app_device_token as target
        using (select @token as token) as src
        on target.token = src.token
        when matched then update set id_user = @id_user, platform = @platform
        when not matched then insert (id_user, token, platform) values (@id_user, @token, @platform);
      `);
    res.json({ ok: true });
  } catch (err) {
    console.error('register-token error:', err);
    res.status(500).json({ error: 'Server error registering device' });
  }
});

// Recent notifications for the current user (for an in-app bell/list, in
// addition to the OS-level push itself).
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id_user', sql.Int, req.user.id)
      .query(`
        select top 30 id, type, id_ref, message, created_at, read_at
        from app_notification_log
        where id_user = @id_user
        order by created_at desc
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('list notifications error:', err);
    res.status(500).json({ error: 'Server error fetching notifications' });
  }
});

router.get('/unread-count', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id_user', sql.Int, req.user.id)
      .query('select count(*) as count from app_notification_log where id_user = @id_user and read_at is null');
    res.json({ count: result.recordset[0].count });
  } catch (err) {
    console.error('unread count error:', err);
    res.status(500).json({ error: 'Server error fetching unread count' });
  }
});

router.post('/mark-read', async (req, res) => {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('id_user', sql.Int, req.user.id)
      .query('update app_notification_log set read_at = getdate() where id_user = @id_user and read_at is null');
    res.json({ ok: true });
  } catch (err) {
    console.error('mark-read error:', err);
    res.status(500).json({ error: 'Server error marking notifications read' });
  }
});

module.exports = router;
